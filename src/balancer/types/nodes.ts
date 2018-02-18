import Web3Node from 'balancer/nodes/web3';
import RPCNode from 'balancer/nodes/rpc';
import CustomNode from 'balancer/nodes/custom';
import { StaticNetworkIds } from 'balancer/types/networks';

export interface CustomNodeConfig {
  id: string;
  isCustom: true;
  name: string;
  lib: CustomNode;
  pLib: CustomNode;
  service: 'your custom node';
  url: string;
  port: number;
  network: string;
  auth?: {
    username: string;
    password: string;
  };
}

export interface StaticNodeConfig {
  isCustom: false;
  network: StaticNetworkIds;
  lib: RPCNode | Web3Node;
  pLib: RPCNode | Web3Node;
  service: string;
  hidden?: boolean;
}

export enum StaticNodeId {
  ETH_MYCRYPTO = 'eth_mycrypto',
  ETH_ETHSCAN = 'eth_ethscan',
  ETH_INFURA = 'eth_infura',
  ROP_INFURA = 'rop_infura',
  KOV_ETHSCAN = 'kov_ethscan',
  RIN_ETHSCAN = 'rin_ethscan',
  RIN_INFURA = 'rin_infura',
  ETC_EPOOL = 'etc_epool',
  UBQ = 'ubq',
  EXP_TECH = 'exp_tech',
}

export type StaticNodeWithWeb3Id = StaticNodeId | 'web3';

export type NodeConfig = CustomNodeConfig | StaticNodeConfig;
