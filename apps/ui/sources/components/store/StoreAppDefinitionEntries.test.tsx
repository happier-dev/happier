import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { StoreAppDefinitionEntries } = await import('./StoreAppDefinitionEntries');
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

it.each([['compose', 'store.kind.app.pasteCompose'], ['image', 'store.kind.app.runImage']] as const)(
  'opens the %s definition in the chosen Project\'s own draft', async (kind, testID) => {
    const serverId = await home.addHome({ name: 'Entries', serverUrl: `https://entries-${kind}.test`, accountId: 'alice',
      serverIdentityId: `srv_${(kind === 'compose' ? 'd' : 'e').repeat(32)}`, currentAccount: true });
    home.answer(serverId, 'GET /v2/project-sources', { body: { items: [{ id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' },
      audience: [], createdByAccountId: 'alice' }], nextCursor: null } });
    const screen = await renderScreen(<StoreAppDefinitionEntries />);
    const menu = () => screen.tree.findAll(node => node.props.testID === `${testID}.menu` && typeof node.props.onSelect === 'function')[0]!;
    await act(async () => menu().props.onOpenChange(true));
    await waitForTestEvent(home.subscribe, () => menu().props.items.length, count => count > 0);
    await act(async () => menu().props.onSelect('source-app'));
    expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^/deployments/source-app\\?serverId=[^&]+&newDefinition=${kind}$`)));
    await screen.unmount();
  });
