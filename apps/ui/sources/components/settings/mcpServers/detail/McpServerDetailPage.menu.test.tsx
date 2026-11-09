import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { encodeMcpServerInstallLinkV1 } from '@happier-dev/protocol/mcp/servers/import/parseMcpServerImportV1';
import { installBrowserClipboardBoundary, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const boundary = vi.hoisted(() => ({ copy: vi.fn(async (_value: string) => true) }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// HTTP and clipboard are boundaries; mounted Action admission/currentness and link production stay real.
vi.mock('expo-clipboard', () => ({ setStringAsync: boundary.copy }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { McpServerDetailPage } = await import('./McpServerDetailPage');
const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');

const server = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {} } });
const availability = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };
const HOME_URL = 'https://mcp-detail-menu.test';
const LINK = encodeMcpServerInstallLinkV1(server, HOME_URL);
let catalogHasServer = true;
let disposeActionLoader: (() => void) | undefined;

async function page(onDuplicate = vi.fn()) {
  const tree = await renderScreen(<McpServerDetailPage server={server} draftServer={server} catalogRevision={3} secrets={[]}
    secretAvailability={availability} scope={getStorage().getState().settingsScope} configurationSaveState="idle" onCommitConfiguration={() => {}}
    onRemove={() => {}} onDuplicate={onDuplicate} approvalNotice={null} onChangeServer={() => {}} />);
  return { tree, onDuplicate, actions: () => tree.findByType(PageHeaderMenu).props.actions as readonly { id: string; onSelect: () => unknown }[] };
}
beforeEach(async () => {
  await harness.reset();
  const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
  resetScopedHomeActionExecutorsForTests();
  disposeActionLoader = await installRealActionExecutorModuleLoader();
  boundary.copy.mockClear();
  boundary.copy.mockResolvedValue(true);
  installBrowserClipboardBoundary(async text => { await boundary.copy(text); });
  retirePresentationNotice();
  catalogHasServer = true;
  const serverId = await harness.addHome({ name: 'MCP menu', serverUrl: HOME_URL,
    serverIdentityId: 'srv_mcp_detail_menu', accountId: 'owner', currentAccount: true });
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
  getStorage().setState({ settingsScope: scope, profileScope: scope, isDataReady: true });
  harness.answer(serverId, '/v1/account/entity-rows/mcp', { select: () => ({ body: {
    status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, servers: catalogHasServer ? [server] : [], bindings: [] } },
  } }) });
});
afterEach(async () => { await standardCleanup(); disposeActionLoader?.(); disposeActionLoader = undefined; });

describe('saved MCP server header menu', () => {
  it('offers Duplicate, and Copy install link when the server read carries one, which copies exactly that link', async () => {
    const current = await page();
    await waitForHomeGovernance(() => expect(current.actions().map((action) => action.id)).toEqual(['duplicate', 'copyInstallLink']));
    expect(harness.requests.some(request => request.path === '/v1/account/entity-rows/mcp')).toBe(true);
    await current.actions()[1]!.onSelect();
    expect(boundary.copy).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
    // A repeat copy replaces the notice rather than stacking another.
    const key = readPresentationNotice()!.key;
    await current.actions()[1]!.onSelect();
    expect(readPresentationNotice()!.key).toBe(key);
    await current.actions()[0]!.onSelect();
    expect(current.onDuplicate).toHaveBeenCalledOnce();
  });

  it('hides Copy install link when the read has no link', async () => {
    // A withdrawn HTTP catalog entry gives the real read no link; never fabricate an Action receipt.
    catalogHasServer = false;
    const current = await page();
    await waitForHomeGovernance(() => expect(harness.requests.some(request => request.path === '/v1/account/entity-rows/mcp')).toBe(true));
    expect(current.actions().map((action) => action.id)).toEqual(['duplicate']);
  });

  it('says so when the clipboard refuses the link', async () => {
    boundary.copy.mockRejectedValue(new DOMException('', 'NotAllowedError'));
    const current = await page();
    await waitForHomeGovernance(() => expect(current.actions()).toHaveLength(2));
    await current.actions()[1]!.onSelect();
    expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
  });
});
