import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { StoreAppDefinitionEntriesFor } = await import('./StoreAppDefinitionEntries');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
beforeEach(async () => { await home.reset(); });
afterEach(() => standardCleanup());

it.each([['compose', 'store.kind.app.pasteCompose'], ['image', 'store.kind.app.runImage']] as const)(
  'opens the %s definition in the chosen Project\'s own draft', async (kind, testID) => {
    const serverId = await home.addHome({ name: 'Entries', serverUrl: `https://entries-${kind}.test`, accountId: 'alice',
      serverIdentityId: `srv_${(kind === 'compose' ? 'd' : 'e').repeat(32)}`, currentAccount: true });
    home.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true,
      sources: [{ id: 'source-app', revision: 3, name: 'App', audience: [], createdByAccountId: 'alice' }],
      coverage: { complete: true, nextCursor: null } } });
    const account = await captureLazyActionAccountContext(serverId);
    routerMock.spies.push.mockClear();
    const screen = await renderScreen(<StoreAppDefinitionEntriesFor scope={account.accountLifetime.scope} />);
    const find = () => screen.tree.findAll(node => node.props.testID === `${testID}.menu` && typeof node.props.onSelect === 'function')[0];
    const menu = () => find()!;
    // The entries render once the active Account scope has resolved.
    await vi.waitFor(() => expect(find(), 'the entries render for the Account').toBeDefined(), { timeout: 20000 });
    await act(async () => menu().props.onOpenChange(true));
    await vi.waitFor(() => expect(menu().props.items.length, 'the opened menu lists the Account\'s Projects').toBeGreaterThan(0), { timeout: 20000 });
    await act(async () => menu().props.onSelect('source-app'));
    expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^/deployments/source-app\\?serverId=[^&]+&newDefinition=${kind}$`)));
    await screen.unmount();
    account.dispose();
  });

it.each([
  ['offline', { status: 503, body: { ok: false, error: 'source_backend_unavailable' } }, 'store.kind.app.pasteCompose.offline'],
  ['refused', { status: 403, body: { ok: false, error: 'action_forbidden' } }, 'store.kind.app.pasteCompose.refused'],
] as const)('never reads a %s Project list as "Add a project first"', async (state, answer, stateTestID) => {
  const serverId = await home.addHome({ name: 'Entries', serverUrl: `https://entries-${state}.test`, accountId: 'alice',
    serverIdentityId: `srv_${(state === 'offline' ? 'f' : 'a').repeat(32)}`, currentAccount: true });
  home.answer(serverId, 'GET /v1/projects/sources', answer);
  const account = await captureLazyActionAccountContext(serverId);
  const screen = await renderScreen(<StoreAppDefinitionEntriesFor scope={account.accountLifetime.scope} />);
  const find = () => screen.tree.findAll(node => node.props.testID === 'store.kind.app.pasteCompose.menu' && typeof node.props.onSelect === 'function')[0];
  await vi.waitFor(() => expect(find()).toBeDefined(), { timeout: 20000 });
  const { t } = await import('@/text');
  // Before the read answers, the menu says it is reading.
  expect(find()!.props.emptyLabel).toBe(t('common.loading'));
  await act(async () => find()!.props.onOpenChange(true));
  await vi.waitFor(() => expect(find()!.props.emptyLabel?.props?.testID).toBe(stateTestID), { timeout: 20000 });
  expect(find()!.props.emptyLabel).not.toBe(t('capabilities.store.definitionNoProjects'));
  await screen.unmount();
  account.dispose();
});


it.each(['compose', 'image'] as const)('opens a %s draft for a reviewed new Project without creating anything', async kind => {
  const serverId = await home.addHome({ name: 'Entries', serverUrl: `https://entries-new-${kind}.test`, accountId: 'alice', currentAccount: true });
  home.answer(serverId, 'GET /v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
  const account = await captureLazyActionAccountContext(serverId);
  const screen = await renderScreen(<StoreAppDefinitionEntriesFor scope={account.accountLifetime.scope} />);
  const testID = kind === 'compose' ? 'store.kind.app.pasteCompose' : 'store.kind.app.runImage';
  const menu = () => screen.tree.findAll(node => node.props.testID === `${testID}.menu` && typeof node.props.onSelect === 'function')[0]!;
  await act(async () => menu().props.onOpenChange(true));
  await vi.waitFor(() => expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'new' })), { timeout: 20000 });
  routerMock.spies.push.mockClear();
  await act(async () => menu().props.onSelect('new'));
  expect(routerMock.spies.push).toHaveBeenCalledWith(`/deployments/new?serverId=${encodeURIComponent(serverId)}&newDefinition=${kind}`);
  expect(home.requests.some(request => request.method === 'POST' && request.path === '/v1/projects/sources')).toBe(false);
  expect(home.requests.some(request => request.path.startsWith('/v1/deployments/environments'))).toBe(false);
  await screen.unmount();
  account.dispose();
});
