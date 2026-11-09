import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 as service, MCP_OAUTH_CALLBACK_URL_V1 as callbackUrl } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: async () => true }));
// Only the daemon transport is replaced; Action admission and the authorization lifecycle remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(boundary.rpc));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const browser = await installBrowserRuntimeForTests({ url: 'https://mcp-signing-lifecycle.test/settings/mcp' });
let documentVisible = true;
Object.defineProperty(browser.document, 'visibilityState', { configurable: true,
  get: () => documentVisible ? 'visible' : 'hidden' });
const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { McpSignInSection } = await import('./McpSignInSection');
const { useMcpServerSignIn } = await import('./useMcpServerSignIn');

const server = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {}, auth: { kind: 'oauth' } } });
let disposeActionLoader: (() => void) | undefined;

function SigningLifecycle() {
  const signIn = useMcpServerSignIn(server, [{ machineId: 'mcp-machine', name: 'This computer', online: true }]);
  return signIn.view ? <McpSignInSection name={server.name} signIn={{ ...signIn, view: signIn.view }} /> : null;
}

beforeEach(async () => {
  browser.activate();
  documentVisible = true;
  browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
  await harness.reset();
  const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
  resetScopedHomeActionExecutorsForTests();
  disposeActionLoader = await installRealActionExecutorModuleLoader();
  boundary.rpc.mockReset();
  const serverId = await harness.addHome({ name: 'MCP signing', serverUrl: 'https://mcp-signing-lifecycle.test',
    serverIdentityId: 'srv_mcp_signing_lifecycle', accountId: 'owner', currentAccount: true });
  const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
  const machine = createMachineFixture({ id: 'mcp-machine', activeAt: Date.now(),
    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
  const state = getStorage().getState();
  getStorage().setState({ settingsScope: scope, profileScope: scope, isDataReady: true,
    settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
      'mcp.servers.signIn.start': ['ui'],
    } }) } });
  harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
    actionsSettingsV1: getStorage().getState().settings.actionsSettingsV1,
  } }, version: 0 } });
  getStorage().getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  observeMachinePresenceForTest(scope, [machine.id]);
  harness.answer(serverId, '/v1/account/entity-rows/mcp', { body: {
    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers: [server], bindings: [] } },
  } });
});
afterEach(async () => {
  await standardCleanup();
  disposeActionLoader?.();
  disposeActionLoader = undefined;
});
afterAll(() => browser.restore());

describe('MCP signing display lifecycle', () => {
  it.each(['layout', 'document'] as const)('keeps signing display quiet while %s is hidden without extending authorization', async hiddenOwner => {
    const expiresAtMs = Date.now() + 60_000;
    boundary.rpc.mockImplementation(async request => {
      const operation = request.payload.command.operation;
      if (operation === 'describeService') return { status: 'described', service, descriptor: { id: service.localId, title: 'MCP sign-in', authentication: {
        defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl, pkce: 'required', outcomeReconciliation: 'none' }],
      } }, accounts: [], operationTransport: { kind: 'v4' }, occurrenceId: 'signing-runtime', sourceCustody: { kind: 'host' } };
      if (operation === 'beginConnect') return { status: 'awaitingOAuth', attemptId: 'signing-attempt',
        authorizationUrl: 'https://issuer.test/authorize?state=signing-attempt.nonce', callbackUrl, expiresAtMs };
      if (operation === 'cancel') return { status: 'cancelled', attemptId: 'signing-attempt' };
      throw new Error(`Unexpected signing RPC operation: ${operation}`);
    });
    let presented = true;
    const tree = await renderScreen(<SigningLifecycle />, { wrapper: props =>
      <PluginSurfaceFocusEligibilityProvider active={presented}>{props.children}</PluginSurfaceFocusEligibilityProvider> });
    await waitForHomeGovernance(() => expect(tree.findByTestId('mcp.server.signin:not-connected:action')?.props.disabled).toBeFalsy());
    vi.useFakeTimers();
    vi.setSystemTime(expiresAtMs - 60_000);
    const census = installTimerCensus(stack => stack.includes('McpSignInSection.tsx:') ? 'signing-display'
      : stack.includes('useMcpServerSignIn.ts:') ? 'authorization-deadline' : null);
    const displayTimers = () => census.read().filter(timer => timer.consumer === 'signing-display' && timer.kind === 'interval');
    const setPresented = async (active: boolean) => {
      if (hiddenOwner === 'layout') {
        presented = active;
        await tree.update(<SigningLifecycle />);
      } else {
        await act(async () => {
          documentVisible = active;
          browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
        });
      }
    };
    try {
      await act(async () => { await tree.findByType(McpSignInSection).props.signIn.start(); });
      expect(tree.findByTestId('mcp.server.signin:signing')).not.toBeNull();
      await tree.pressByTestIdAsync('mcp.server.signin:signing:use-phone');
      expect(displayTimers()).toHaveLength(1);
      expect(tree.getTextContent()).toContain('time=1:00');
      await setPresented(false);
      expect(displayTimers()).toHaveLength(0);
      expect(census.read().some(timer => timer.kind === 'timeout' && timer.consumer === 'authorization-deadline')).toBe(true);
      expect(vi.getTimerCount()).toBe(census.read().length);
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(tree.getTextContent()).toContain('time=1:00');
      await setPresented(true);
      expect(tree.getTextContent()).toContain('time=0:50');
      expect(displayTimers()).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(tree.getTextContent()).toContain('time=0:49');
      await act(async () => { await tree.findByType(McpSignInSection).props.signIn.cancel(); });
      expect(tree.findByTestId('mcp.server.signin:not-connected')).not.toBeNull();
      expect(displayTimers()).toHaveLength(0);
      await act(async () => { await tree.findByType(McpSignInSection).props.signIn.start(); });
      expect(tree.findByTestId('mcp.server.signin:signing')).not.toBeNull();
      // Browser and paste modes have no countdown consumer.
      expect(displayTimers()).toHaveLength(0);
      await tree.pressByTestIdAsync('mcp.server.signin:signing:got-code');
      expect(displayTimers()).toHaveLength(0);
      await tree.pressByTestIdAsync('connected-account-setup:cancel');
      await tree.pressByTestIdAsync('mcp.server.signin:signing:use-phone');
      expect(displayTimers()).toHaveLength(1);
      await setPresented(false);
      await act(async () => { vi.advanceTimersByTime(49_000); });
      expect(tree.findByTestId('mcp.server.signin:did-not-finish')).not.toBeNull();
      expect(displayTimers()).toHaveLength(0);
      await setPresented(true);
      expect(tree.findByTestId('mcp.server.signin:did-not-finish')).not.toBeNull();
      expect(displayTimers()).toHaveLength(0);
    } finally {
      await tree.unmount();
      const remaining = displayTimers();
      census.stop();
      vi.useRealTimers();
      expect(remaining).toHaveLength(0);
    }
  });
});
