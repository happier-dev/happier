import '../../../../ui/sources/dev/vitestSetup';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, RoleActionOutputSchemasV1, readSessionRolesV1 } from '@happier-dev/protocol';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema, PromptLibraryRowMutationV1Schema,
  PromptLibraryRowMutationResponseV1Schema, PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { RoleOverrideRecordV1Schema } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { registerSessionClientRuntimeHandlers } from '@/api/session/client/executionRuns/registerSessionClientRuntimeHandlers';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readAccountRoleOverridesFromSnapshot,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createWorkspaceWritesPolicyPreparation } from '@/session/roles/workspaceWritesPolicyPreparation';
import { logger } from '@/ui/logger';
import { serveSessionActionHome } from '../../../../ui/sources/dev/testkit/harness/sessionActionHome';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { createSessionFixture } from '../../../../ui/sources/dev/testkit';

const transport = vi.hoisted(() => vi.fn());
// Replace only the browser → Session network hop with the real receiving registrar.
vi.mock('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
  const { createServerScopedSessionRpcModuleMock } = await import('../../../../ui/sources/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: { sessionRpcWithServerScope: transport } });
});
vi.mock('react-native', async () => (await import('../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('../../../../ui/sources/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('../../../../ui/sources/dev/testkit/mocks/router')).createExpoRouterMock().module);

// Match app bootstrap after the transport mocks above, before starting an Action's budget.
await loadSyncSingletonForTests();
const { storage } = await import('../../../../ui/sources/sync/domains/state/storageStore');
const { roleActions } = await import('../../../../ui/sources/sync/ops/roles/roleActions');
const previous = storage.getState();
function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { storage.setState(previous); resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); transport.mockReset(); });

it('resets and edits through the real UI front door after the Session prepared private Account and Session overrides', async () => {
  const diagnostics = vi.spyOn(logger, 'infoFile');
  const serverUrl = 'https://role-reset.test';
  const accountId = 'role-reset-account';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    encryption: null, credentialProvenance: 'stored_session' } as const;
  const home = await serveSessionActionHome({ homes: [{ key: 'owner', serverUrl, accountId, currentAccount: true }], route: () => undefined });
  const sessionId = 'role-reset-session';
  let current = true;
  let nativeWorkspaceWrites: 'allow' | 'deny' = 'allow';
  let metadata = createTestMetadata({ work: { sessionRolesV1: { roleId: 'builder',
    overrides: { builder: { roleId: 'builder', secondOpinion: 'encouraged', workspaceWrites: 'allow' } }, sessionRoles: {}, notes: 'SESSION_CONTEXT' } } });
  const socket = createApiSessionSocketStub();
  const parent = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: sessionId, metadata }), {
    metadataAuthority: { kind: 'owner', credentials }, transport: { serverId: home.serverId, serverUrl,
      createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
  });
  const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
  const scopeKey = runWithServerHttpBaseUrl(serverUrl, () => resolveAccountSettingsScopeKey(credentials));
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, scopeKey,
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog: { status: 'loading' } });
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Missing Account fixture');
  const operation = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl: serverUrl,
    readSourceSnapshot: () => current ? getActiveAccountSettingsSnapshot() : null, isCurrent: async () => current });
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  let roleRowReads = 0;
  let artifactListReads = 0;
  let homeRecovered = false;
  let roleRevision = 1;
  let accountOverrides = RoleOverrideRecordV1Schema.parse({ v: 1, overrides: {
    builder: { roleId: 'builder', instructionsOverride: 'ACCOUNT_CONTEXT', workspaceWrites: 'deny' },
  } });
  const refreshing = createDeferred();
  const refreshed = createDeferred();
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/artifacts') { artifactListReads++; return { status: 200, data: [] }; }
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/prompt-library') {
      roleRowReads += 1;
      if (roleRowReads === 2) { refreshing.resolve(); await refreshed.promise; }
      // The retained Session demand succeeds; a competing later network read
      // encounters a real transport outage instead of borrowing that readiness.
      if (roleRowReads > 2 && !homeRecovered) return { status: 503, data: {} };
      return { status: 200, data: PromptLibraryRowsListResponseV1Schema.parse({
      status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: key === 'role-overrides' ? roleRevision : 1,
        content: { t: 'plain', v: key === 'role-overrides' ? { key, value: accountOverrides } : emptyPromptLibraryRecordV1(key) } })) }) };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
    throw new Error(`Unexpected Role HTTP path ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/prompt-library/role-overrides');
    const mutation = PromptLibraryRowMutationV1Schema.parse(body);
    expect(mutation.expectedRevision).toBe(roleRevision);
    if (mutation.content.t !== 'plain') throw new Error('Expected plain Account boundary');
    const record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
    if (record.key !== 'role-overrides') throw new Error('Expected Role record');
    accountOverrides = record.value;
    roleRevision += 1;
    return { status: 200, data: PromptLibraryRowMutationResponseV1Schema.parse({ status: 'updated', revision: roleRevision, cursor: roleRevision }) };
  });
  const sources = createRoleSourceReader({ accountId, artifactStore: createCredentialedAccountArtifactStore(credentials),
    readPluginRoles: () => [], readRawAccountSettings: async () => operation.readSnapshot()?.rawSettings ?? {} });
  const roleContext = createSessionRoleContext({ readMetadata: () => metadata, readOrganization: async () => ({}), readRoleSources: sources,
    readAccountRoleOverrides: () => {
      const currentSnapshot = operation.readSnapshot();
      return currentSnapshot ? readAccountRoleOverridesFromSnapshot(currentSnapshot) : { status: 'unavailable', reason: 'scope-retired' };
    },
    prepareAccountRoleOverrides: async signal => { await prepareActiveAccountRoleOverrides({ credentials, scopeKey, lifetimeToken, operationContext: operation, signal }); },
    ...{ readOperationContext: () => operation },
  });
  applyRunnerMcpSessionContext(parent, { getSessionRoleContext: () => roleContext,
    prepareWorkspaceWritesPolicy: createWorkspaceWritesPolicyPreparation({
      // Native Agent configuration is the external boundary; the policy owner stays real.
      update: async policy => { nativeWorkspaceWrites = policy; return { status: 'applied', timing: 'current_window' }; },
    }),
  });
  const unexpectedWrite = async (): Promise<never> => { throw new Error('Unexpected transcript write'); };
  const registration = registerSessionClientRuntimeHandlers({ rpcHandlerManager: rpc, token: credentials.token,
    serverId: home.serverId, serverUrl, readOwnerAccountCredentials: async () => credentials,
    actionsSettingsProvider: createActionSettingsProvider({ scopeKey }), readRoleSources: sources,
    metadataPath: metadata.path, metadata, sessionId, session: parent, getSessionMetadata: () => metadata,
    enqueueRegisteredSessionStateFieldMutation: async mutation => { metadata = applyRegisteredSessionStateFieldMutationToMetadata(metadata, mutation); },
    enqueueSessionUserMessage: unexpectedWrite, enqueueUserTextMessageCommitted: unexpectedWrite, enqueueAgentMessageCommitted: unexpectedWrite,
    enqueueVoiceAgentTranscriptTurnCommitted: unexpectedWrite, sendAgentMessageEphemeral: () => { throw new Error('Unexpected ephemeral write'); },
    getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }), persistVoiceAgentRunMetadataFromPublicRun: () => {}, socketEmitExecutionRunUpdated: () => {},
  });
  try {
    await runWithServerHttpBaseUrl(serverUrl, async () => {
      const prepared = await roleContext.resolvePromptContext();
      expect(prepared?.role?.instructions).toBe('ACCOUNT_CONTEXT');
      expect(prepared?.role?.secondOpinion).toBe('encouraged');
      expect(prepared?.role?.workspaceWrites).toBe('allow');
      expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog?.status).toBe('loading');
      let preparedArtifactReads = artifactListReads;
      storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: home.serverId }) } });
      transport.mockImplementation(async ({ method, payload }) => await rpc.handleRequest({ method: `${sessionId}:${method}`, params: payload, callerAuthority: 'present_user' }));
      await operation.commitPromptLibraryCatalog({ expectedSettingsVersion: 1, catalog: { status: 'loading' } });
      const preparing = roleContext.prepare(undefined, true);
      await refreshing.promise;
      const resetting = roleActions.clearSessionOverride(sessionId, 'builder', { serverId: home.serverId });
      refreshed.resolve();
      await preparing;
      const reset = await resetting;
      expect(reset).toEqual({ ok: true, result: RoleActionOutputSchemasV1['session.roles.override.clear'].parse({ updated: true }) });
      expect(readSessionRolesV1(metadata)?.overrides).toEqual({});
      expect(nativeWorkspaceWrites).toBe('deny');
      expect(artifactListReads).toBe(preparedArtifactReads);
      expect((await roleContext.resolvePromptContext())?.role?.secondOpinion).toBe('off');
      preparedArtifactReads = artifactListReads;
      expect(await roleActions.setSessionOverride(sessionId, { roleId: 'builder', secondOpinion: 'encouraged' }, { serverId: home.serverId }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(readSessionRolesV1(metadata)?.overrides.builder?.secondOpinion).toBe('encouraged');
      expect(await roleActions.clearSessionOverride(sessionId, 'builder', { serverId: home.serverId })).toEqual({ ok: true, result: { updated: true } });
      expect(await roleActions.setSessionNotes(sessionId, 'UPDATED_SESSION_NOTES', { serverId: home.serverId }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(readSessionRolesV1(metadata)?.notes).toBe('UPDATED_SESSION_NOTES');
      expect(artifactListReads).toBe(preparedArtifactReads);
      expect((await roleContext.resolvePromptContext())?.role?.instructions).toBe('ACCOUNT_CONTEXT');
      // A new explicit person attempt may prepare again after a real outage.
      await operation.commitPromptLibraryCatalog({ expectedSettingsVersion: 1, catalog: { status: 'loading' } });
      await roleContext.prepare(undefined, true);
      expect(await roleContext.readAccountOverrides()).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
      homeRecovered = true;
      expect(await roleActions.setSessionOverride(sessionId, { roleId: 'builder', secondOpinion: 'encouraged' }, { serverId: home.serverId }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(await roleActions.clearSessionOverride(sessionId, 'builder', { serverId: home.serverId }))
        .toEqual({ ok: true, result: { updated: true } });
      const accountExecutor = createCliActionExecutor({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
        serverId: home.serverId, serverHttpBaseUrl: serverUrl, savedSecretOperationContext: operation,
        readRoleSources: sources, ...{ getSessionRoleContext: () => roleContext } });
      expect(await accountExecutor.execute('roles.override.set', { roleId: 'builder', instructionsOverride: 'UPDATED_ACCOUNT_CONTEXT' },
        { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'roles.override.set' } }))
        .toEqual({ ok: true, result: { updated: true } });
      expect((await roleContext.resolvePromptContext())?.role?.instructions).toBe('UPDATED_ACCOUNT_CONTEXT');
      expect(await accountExecutor.execute('roles.override.reset', { roleId: 'builder' }, {
        surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'roles.override.reset' },
      }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(accountOverrides.overrides).toEqual({});
      expect((await roleContext.resolvePromptContext())?.role?.instructions).not.toContain('ACCOUNT_CONTEXT');
      current = false;
      expect(await roleActions.setSessionOverride(sessionId, { roleId: 'builder', secondOpinion: 'encouraged' }, { serverId: home.serverId }))
        .toMatchObject({ ok: false, errorCode: 'account_role_overrides_unavailable' });
      expect(readSessionRolesV1(metadata)?.overrides).toEqual({});
      expect(diagnostics.mock.calls.filter(([message]) => message === '[Session] Role Action refused')).toContainEqual([
        '[Session] Role Action refused', { originalCode: 'account_role_overrides_unavailable', reason: 'not-current', contextSource: 'account_lifetime' },
      ]);
    });
  } finally { refreshed.resolve(); await registration.dispose(); await parent.close(); await home.dispose(); }
});
