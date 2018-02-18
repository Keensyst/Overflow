import * as React from 'react';
import styled from 'styled-components';

const Navigation = styled.ul`
  display: flex;
  width: 100%;
  max-width: 784px;
  margin: 0;
  padding: 0px 16px;
`;

const FlexSpacer = styled.div`
  flex-grow: 1;
`;

interface PNavLink {
  primary?: boolean;
}
const NavLink = styled.a`
  display: block;
  color: ${(props: PNavLink) => (props.primary && '#0090ff') || 'hsla(209, 16%, 74%, 0.87)'};
  font-size: 16px;
  font-weight: 500;
  padding: 24px 16px;
  transition: all 0.15s ease-in-out;
  &:hover {
    color: #0090ff;
  }
`;

export const Nav = () => (
  <Navigation>
    <li>
      <NavLink href="/" primary={true}>
        Shepherd
      </NavLink>
    </li>
    <FlexSpacer />
    <li>
      <NavLink href="/">Demo</NavLink>
    </li>
    <li>
      <NavLink href="/">Documentation</NavLink>
    </li>
    <li>
      <NavLink href="/">Github</NavLink>
    </li>
  </Navigation>
);
