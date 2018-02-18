import { delay, SagaIterator, buffers, channel, Task, Channel } from 'redux-saga';
import {
  call,
  fork,
  put,
  take,
  select,
  race,
  apply,
  spawn,
  flush,
  all,
  actionChannel,
  takeEvery
} from 'redux-saga/effects';
import {
  NodeCall,
  NodeCallRequestedAction,
  NodeCallTimeoutAction,
  nodeCallFailed,
  nodeCallRequested,
  nodeCallSucceeded,
  nodeCallTimeout,
  NodeCallSucceededAction,
  NodeCallFailedAction,
  NODE_CALL,
  getNodeCallById
} from 'balancer/ducks/nodeBalancer/nodeCalls';
import {
  balancerFlush,
  NetworkSwitchSucceededAction,
  networkSwitchSucceeded,
  BalancerFlushAction,
  BALANCER,
  setOffline,
  setOnline
} from 'balancer/ducks/nodeBalancer/balancerConfig';
import { IWorker, workerProcessing } from 'balancer/ducks/nodeBalancer/workers';
import { NodeConfig } from 'balancer/types/nodes';
import {
  INodeStats,
  nodeOffline,
  nodeOnline,
  NodeOfflineAction,
  getNodeStatsById,
  NODE
} from 'balancer/ducks/nodeBalancer/nodeStats';
import { getAllNodesOfCurrentNetwork } from 'balancer/ducks/selectors';
import { isOffline } from 'balancer/ducks/nodeBalancer/balancerConfig/selectors';
import { getNodeConfigById } from 'balancer/ducks/nodeConfigs/configs';
import { getAvailableNodeId, getAllMethodsAvailable } from 'balancer/ducks/nodeBalancer/selectors';
import { RPCNode } from 'balancer/nodes';
import { store } from 'balancer/ducks';

// need to check this arbitary number
const MAX_NODE_CALL_TIMEOUTS = 3;

/**
 *  For now we're going to hard code the initial node configuration in,
 *  ideally on initialization, a ping call gets sent to every node in the current network
 *  to determine which nodes are offline on app start using 'NodeAdded'
 *  then spawn workers for each node from there using 'WorkerSpawned'
 *
 */

/**
window.setTimeout(() => {
  const testNode = RPCNode('kekekek');
  for (let index = 0; index < 10; index++) {
    testNode.ping().then(res => {
    });
  }
}, 1000);
 * Each channel id is a 1-1 mapping of a nodeId
 */
interface IChannels {
  [key: string]: Channel<NodeCall>;
}

const channels: IChannels = {};

function* networkSwitch(): SagaIterator {
  yield put(setOffline());
  //flush all existing requests
  yield put(balancerFlush());

  const nodes: {
    [x: string]: NodeConfig;
  } = yield select(getAllNodesOfCurrentNetwork);

  interface Workers {
    [workerId: string]: IWorker;
  }
  /**
   *
   * @description Handles checking if a node is online or not, and adding it to the node balancer
   * @param {string} nodeId
   * @param {NodeConfig} nodeConfig
   */
  function* handleAddingNode(nodeId: string, nodeConfig: NodeConfig) {
    const startTime = new Date();
    const nodeIsOnline: boolean = yield call(checkNodeConnectivity, nodeId, false);
    const endTime = new Date();
    const avgResponseTime = +endTime - +startTime;
    const stats: INodeStats = {
      avgResponseTime,
      isOffline: !nodeIsOnline,
      isCustom: nodeConfig.isCustom,
      timeoutThresholdMs: 2000,
      currWorkersById: [],
      maxWorkers: 4,
      requestFailures: 0,
      requestFailureThreshold: 2,
      supportedMethods: {
        client: true,
        requests: true,
        ping: true,
        sendCallRequest: true,
        getBalance: true,
        estimateGas: true,
        getTokenBalance: true,
        getTokenBalances: true,
        getTransactionCount: true,
        getCurrentBlock: true,
        sendRawTx: true
      }
    };

    const nodeChannel: Channel<NodeCall> = yield call(channel, buffers.expanding(10));
    channels[nodeId] = nodeChannel;

    const workers: Workers = {};
    for (
      let workerNumber = stats.currWorkersById.length;
      workerNumber < stats.maxWorkers;
      workerNumber++
    ) {
      const workerId = `${nodeId}_worker_${workerNumber}`;
      const workerTask: Task = yield spawn(spawnWorker, workerId, nodeId, nodeChannel);
      stats.currWorkersById.push(workerId);
      const worker: IWorker = {
        assignedNode: nodeId,
        currentPayload: null,
        task: workerTask
      };
      workers[workerId] = worker;
    }

    return { nodeId, stats, workers };
  }
  const nodeEntries = Object.entries(nodes).map(([nodeId, nodeConfig]) =>
    call(handleAddingNode, nodeId, nodeConfig)
  );

  // process adding all nodes in parallel
  const processedNodes: {
    nodeId: string;
    stats: INodeStats;
    workers: Workers;
  }[] = yield all(nodeEntries);

  const networkSwitchPayload = processedNodes.reduce(
    (accu, currNode) => ({
      nodeStats: { ...accu.nodeStats, [currNode.nodeId]: currNode.stats },
      workers: { ...accu.workers, ...currNode.workers }
    }),
    { nodeStats: {}, workers: {} } as NetworkSwitchSucceededAction['payload']
  );

  yield put(networkSwitchSucceeded(networkSwitchPayload));

  yield put(setOnline());
}

function* handleNodeCallRequests(): SagaIterator {
  const requestChan = yield actionChannel(NODE_CALL.REQUESTED, buffers.expanding(50));
  while (true) {
    const { payload }: NodeCallRequestedAction = yield take(requestChan);
    // check if the app is offline
    if (yield select(isOffline)) {
      yield take(BALANCER.ONLINE);
    }
    // wait until its back online

    // get an available nodeId to put the action to the channel
    const nodeId: string = yield select(getAvailableNodeId, payload);
    const nodeChannel = channels[nodeId];
    yield put(nodeChannel, payload);
  }
}

function* handleCallTimeouts({
  payload: { error, nodeId, ...nodeCall }
}: NodeCallTimeoutAction): SagaIterator {
  const nodeStats: Readonly<INodeStats> | undefined = yield select(getNodeStatsById, nodeId);
  if (!nodeStats) {
    throw Error('Could not find node stats');
  }
  // if the node has reached maximum failures, declare it as offline
  if (nodeStats.requestFailures >= nodeStats.requestFailureThreshold) {
    yield put(nodeOffline({ nodeId }));

    //check if all methods are still available after this node goes down
    const isAllMethodsAvailable: boolean = yield select(getAllMethodsAvailable);
    if (!isAllMethodsAvailable) {
      // if not, set app state offline and flush channels

      yield put(setOffline());
    }
  }

  // if the payload exceeds timeout limits, return a response failure
  if (nodeCall.numOfTimeouts > MAX_NODE_CALL_TIMEOUTS) {
    yield put(nodeCallFailed({ error: error.message, nodeCall }));
  } else {
    // else consider it a timeout on the request to be retried
    // might want to make this a seperate action
    // add nodeId to min priority to avoid it if possible
    const nextNodeCall: NodeCall = {
      ...nodeCall,
      minPriorityNodeList: [...nodeCall.minPriorityNodeList, nodeId],
      numOfTimeouts: ++nodeCall.numOfTimeouts
    };
    yield put(nodeCallRequested(nextNodeCall));
  }
}

/**
 * @description polls the offline state of a node, then returns control to caller when it comes back online
 * @param {string} nodeId
 */
function* checkNodeConnectivity(nodeId: string, poll: boolean = true) {
  const nodeConfig: NodeConfig = yield select(getNodeConfigById, nodeId);
  while (true) {
    try {
      const { lb } = yield race({
        lb: apply(nodeConfig.pLib, nodeConfig.pLib.getCurrentBlock),
        to: call(delay, 5000)
      });
      if (lb) {
        return true;
      }
    } catch (error) {
      if (!poll) {
        return false;
      }
      yield call(delay, 5000);
    }
  }
}

function* watchOfflineNode({ payload: { nodeId } }: NodeOfflineAction) {
  yield call(checkNodeConnectivity, nodeId);

  yield put(nodeOnline({ nodeId }));

  // check if all methods are available after this node is online
  const isAllMethodsAvailable: boolean = yield select(getAllMethodsAvailable);

  // if they are, put app in online state
  if (isAllMethodsAvailable) {
    yield put(setOnline());
  }
}

function* spawnWorker(thisId: string, nodeId: string, chan: IChannels[string]) {
  /**
   * @description used to differentiate between errors from worker code vs a network call error
   * @param message
   */
  const createInternalError = (message: string) => {
    const e = Error(message);
    e.name = 'InternalError';
    return e;
  };

  //select the node config on initialization to avoid re-selecting on every request handled
  const nodeConfig: NodeConfig | undefined = yield select(getNodeConfigById, nodeId);
  if (!nodeConfig) {
    throw Error(`Node ${nodeId} not found when selecting from state`);
  }

  let currentPayload: NodeCall;
  while (true) {
    try {
      // take from the assigned action channel
      const payload: NodeCall = yield take(chan);
      currentPayload = payload;
      // after taking a request, declare processing state
      yield put(workerProcessing({ currentPayload: payload, workerId: thisId }));

      const nodeStats: Readonly<INodeStats> | undefined = yield select(getNodeStatsById, nodeId);

      if (!nodeStats) {
        throw createInternalError(`Could not find stats for node ${nodeId}`);
      }

      const lib = nodeConfig.pLib;

      // make the call in the allotted timeout time
      // this will create an infinite loop
      const { result, timeout } = yield race({
        result: apply(lib, lib[payload.rpcMethod], payload.rpcArgs),
        timeout: call(delay, nodeStats.timeoutThresholdMs)
      });

      //TODO: clean this up
      if (timeout || !result) {
        throw createInternalError(`Request timed out for ${nodeId}`);
      }
      console.log('Finished', thisId, payload.callId);
      yield put(nodeCallSucceeded({ result, nodeCall: payload }));
    } catch (error) {
      const e: Error = error;
      if (!(e.name === 'InternalError')) {
        e.name = `NetworkError_${e.name}`;
      }
      console.error(e);
      yield put(nodeCallTimeout({ ...currentPayload!, nodeId, error }));
    }
  }
}

export const nodeCallRequester = (() => {
  let callId = 0;
  return (rpcMethod: string) => {
    return (...rpcArgs: string[]) => {
      return new Promise((resolve, reject) => {
        // allow all nodes for now
        const nodeCall: NodeCall = {
          callId: ++callId,
          numOfTimeouts: 0,
          rpcArgs,
          rpcMethod,
          minPriorityNodeList: []
        };

        // make the request to the load balancer
        const networkReq = nodeCallRequested(nodeCall);
        store.dispatch(networkReq);

        const unsubscribe = store.subscribe(() => {
          const state = store.getState();
          const nodeCall = getNodeCallById(state, networkReq.payload.callId);
          if (nodeCall && !nodeCall.pending) {
            nodeCall.result ? resolve(nodeCall.result) : reject(nodeCall.error);
            return unsubscribe();
          }
        });
      });
    };
  };
})();

function* flushHandler(_: BalancerFlushAction): SagaIterator {
  const channelValues = Object.values(channels);
  for (const chan of channelValues) {
    yield flush(chan);
  }
}

export function* nodeBalancer() {
  yield all([
    call(networkSwitch),
    takeEvery(BALANCER.NETWORK_SWTICH_REQUESTED, networkSwitch),
    takeEvery(NODE.OFFLINE, watchOfflineNode),
    fork(handleNodeCallRequests),
    takeEvery(NODE_CALL.TIMEOUT, handleCallTimeouts),
    takeEvery(BALANCER.FLUSH, flushHandler)
  ]);
}
