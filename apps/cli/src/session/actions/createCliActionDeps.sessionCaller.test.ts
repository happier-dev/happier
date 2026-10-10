import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor, createRoleSourceReaderV1, readLegacyRolesV1,
  type ActionExecutorContext } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, readActiveAccountRoleOverrides,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { createCliActionDeps, type SessionActionRpcTransport } from './createCliActionDeps';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';

function callerSessionFixture(callerDirectory = '/caller/repo', currentStarterDepth = 2, active = true) {
    const sessionId = 'c111111111111111111111111';
    const metadata = { path: callerDirectory, machineId: 'caller-machine', flavor: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } as const;
    const settings = accountSettingsParse({ workDepthLimit: 7 });
    const credentials = { token: 'token', encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings: { workDepthLimit: 7 },
      settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    // HTTP is the genuine boundary; Session resolution, opening, metadata,
    // Agent selection, and admission-context construction all remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (String(url).includes(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, active,
          encryptionMode: 'plain', metadata: JSON.stringify(metadata),
          workDepth: currentStarterDepth,
        }) } };
      }
      return { status: 404, data: {} };
    });
      const params: Parameters<typeof createCliActionDeps>[0] = {
        token: credentials.token, credentials,
        sessionId: 'cli-global', mode: 'plain', ctx: null,
        rawSession: { path: '/wrong/repo', machineId: 'wrong-machine', workDepth: 0 },
        getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
        readRoleSources: createRoleSourceReaderV1({}),
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
      };
      return { sessionId, params, metadata, settings, cleanup: () => {
        get.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
      } };
}

describe('daemon Account Action Session caller context', () => {
  it('refuses generic Artifact deletion of a current guidance Role without blocking unrelated documents or retired guidance', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const accountId = 'guidance-delete-account';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    let rawSettings: Readonly<Record<string, unknown>> = { executionRunsGuidanceEntries: [
      { id: 'current-guidance', title: 'Guidance Role', description: 'Preserve the current guidance Role.' },
      { id: 'malformed-unrelated-guidance', description: 17 },
    ] };
    const legacy = readLegacyRolesV1(rawSettings, accountId)[0];
    if (!legacy) throw new Error('invalid current guidance fixture');
    let settingsVersion = 7;
    const publish = () => setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings: accountSettingsParse(rawSettings),
      rawSettings, settingsVersion, settingsSecretsReadKeys: [], loadedAtMs: settingsVersion,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    publish();
    const stored = (id: string, header: Readonly<Record<string, unknown>>, body: string) => ({
      id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1,
    });
    const artifacts = new Map([
      [legacy.artifactId, stored(legacy.artifactId, { kind: 'role.v1', name: legacy.role.name }, JSON.stringify(legacy.role))],
      ['ordinary-role', stored('ordinary-role', { kind: 'role.v1', name: 'Independent Role' }, JSON.stringify(legacy.role))],
      ['ordinary-document', stored('ordinary-document', { kind: 'prompt_doc.v1', title: 'Independent document' }, 'Keep ordinary deletion available.')],
    ]);
    // HTTP is the storage boundary; current guidance admission and native
    // revision deletion remain the real CLI/Protocol paths.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: rawSettings }, version: settingsVersion } };
      const artifact = artifacts.get(path.slice('/v1/artifacts/'.length));
      if (path.startsWith('/v1/artifacts/')) return { status: artifact ? 200 : 404, data: artifact ?? {} };
      throw new Error(`Unexpected guidance deletion HTTP boundary: ${path}`);
    });
    const remove = vi.spyOn(axios, 'delete').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      const prefix = '/v1/artifacts/';
      const suffix = '/revision/1/1';
      if (!path.startsWith(prefix) || !path.endsWith(suffix)) throw new Error(`Unexpected Artifact deletion boundary: ${path}`);
      return { status: artifacts.delete(path.slice(prefix.length, -suffix.length)) ? 200 : 404, data: {} };
    });
    try {
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'guidance-session', mode: 'plain', ctx: null });
      const executeDelete = (artifactId: string) => deps.artifactAction?.({ actionId: 'artifact.delete',
        input: { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
        context: { surface: 'cli', authority: 'present_user' } });
      await expect(executeDelete(legacy.artifactId)).resolves.toMatchObject({ ok: false, errorCode: 'role_source_incomplete' });
      expect(artifacts.has(legacy.artifactId)).toBe(true);
      for (const artifactId of ['ordinary-document', 'ordinary-role']) {
        await expect(executeDelete(artifactId)).resolves.toEqual({ artifactId, deleted: true });
        expect(artifacts.has(artifactId)).toBe(false);
      }
      rawSettings = {};
      settingsVersion = 8;
      publish();
      await expect(executeDelete(legacy.artifactId)).resolves.toEqual({ artifactId: legacy.artifactId, deleted: true });
      expect(artifacts.has(legacy.artifactId)).toBe(false);
    } finally { remove.mockRestore(); get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each(['roles.list', 'roles.get'] as const)('refuses retired %s before reading a private Role Artifact body', async actionId => {
    resetActiveAccountSettingsSnapshotForTests();
    const accountId = 'private-role-account';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    const publish = (loadedAtMs: number) => setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings,
      rawSettings: {}, settingsVersion: 7, settingsSecretsReadKeys: [], loadedAtMs,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    publish(1);
    const roleId = 'private-role-artifact';
    const role = { name: 'Private instructions', instructions: 'Account-private Role document', runsAs: { kind: 'session' },
      workspaceWrites: 'deny', secondOpinion: 'off', enabled: true };
    const stored = { id: roleId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ kind: 'role.v1', name: role.name }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(role) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const privateReads: string[] = [];
    // HTTP is the only replaced boundary: the actual Account Artifact store
    // opens the private body and the canonical source reader classifies it.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') { privateReads.push(path); return { status: 200, data: [stored] }; }
      if (path === `/v1/artifacts/${roleId}`) { privateReads.push(path); return { status: 200, data: stored }; }
      throw new Error(`Unexpected private Role HTTP boundary: ${path}`);
    });
    try {
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'private-role-session', mode: 'plain', ctx: null,
        readRoleSources: createRoleSourceReaderV1({ artifactStore: createCredentialedAccountArtifactStore(credentials) }) });
      const request = { actionId, input: actionId === 'roles.get' ? { roleId } : {},
        context: { surface: 'cli', authority: 'present_user' } as const };
      const current = await deps.roleActionExecute?.(request);
      if (actionId === 'roles.get') expect(current).toMatchObject({ roleId, role });
      else expect(current).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ roleId, role })]) });
      expect(privateReads).toContain(`/v1/artifacts/${roleId}`);
      privateReads.length = 0;
      clearActiveAccountSettingsSnapshot();
      publish(2);
      await expect(deps.roleActionExecute?.(request)).rejects.toMatchObject({
        code: 'account_role_overrides_unavailable', reason: 'scope-retired',
      });
      expect(privateReads).toEqual([]);
    } finally { get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([false, true])('demands the actual Account Role row only in the captured standalone Action lifetime (retired=%s)', async retired => {
    resetActiveAccountSettingsSnapshotForTests();
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'role-first-demand-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings: {}, settingsVersion: 7,
      settingsSecretsReadKeys: [], loadedAtMs: 1 });
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    let nativePolicy: 'allow' | 'deny' = 'allow';
    // Home HTTP and the native/durable effects are the only replaced boundaries.
    // Row opening, demand, scoped publication, source and Role resolution remain real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain',
          v: key === 'role-overrides' ? { key, value: { v: 1, overrides: {
            builder: { roleId: 'builder', workspaceWrites: 'deny' },
          } } } : emptyPromptLibraryRecordV1(key) } })) } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
      if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      throw new Error(`Unexpected Role first-demand HTTP boundary: ${path}`);
    });
    try {
      const deps = createCliActionDeps({ token, credentials, sessionId: 'bound-role-session', mode: 'plain', ctx: null,
        getCurrentSessionMetadata: () => ({ path: '/repo', machineId: 'machine' }),
        readRoleSources: createRoleSourceReaderV1({}),
        prepareWorkspaceWritesPolicy: async policy => { nativePolicy = policy; return { ok: true }; },
        stageSessionStateMutation: async mutation => { queued.push(mutation); },
      });
      expect(readActiveAccountRoleOverrides({ scopeKey, lifetimeToken }))
        .toEqual({ status: 'unavailable', reason: 'catalog-unobserved' });
      if (retired) {
        clearActiveAccountSettingsSnapshot();
        setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings: {}, settingsVersion: 7,
          settingsSecretsReadKeys: [], loadedAtMs: 2 });
        await expect(deps.roleActionExecute?.({ actionId: 'session.role.set',
          input: { sessionId: 'bound-role-session', roleId: 'builder' },
          context: { surface: 'cli', authority: 'present_user' } })).rejects.toMatchObject({ code: 'account_role_overrides_unavailable' });
        expect(nativePolicy).toBe('allow');
        expect(queued).toEqual([]);
        expect(readActiveAccountRoleOverrides({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() }))
          .toEqual({ status: 'unavailable', reason: 'catalog-unobserved' });
        return;
      }
      await expect(deps.roleActionExecute?.({ actionId: 'session.role.set',
        input: { sessionId: 'bound-role-session', roleId: 'builder' },
        context: { surface: 'cli', authority: 'present_user' } })).resolves.toEqual({ updated: true });
      expect(nativePolicy).toBe('deny');
      expect(queued).toMatchObject([{ fieldId: 'intent.role', op: { kind: 'set', value: 'builder' } }]);
      expect(readActiveAccountRoleOverrides({ scopeKey, lifetimeToken })).toMatchObject({ status: 'ready',
        overrides: { builder: { workspaceWrites: 'deny' } } });
    } finally { get.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('refuses a fresh child snapshot when the real Role source inventory is partial', async () => {
    const { params, sessionId, cleanup } = callerSessionFixture();
    try {
      const deps = createCliActionDeps({ ...params,
        readRoleSources: createRoleSourceReaderV1({ accountId: 'account-1',
          readRawAccountSettings: async () => { throw new Error('Settings storage unavailable'); } }),
      });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toBeNull();
    } finally { cleanup(); }
  });

  it('fails closed for malformed Session origins before forwarding an admitted own-Session role edit', async () => {
    const { params, sessionId, metadata, settings, cleanup } = callerSessionFixture();
    const forwarded: Parameters<SessionActionRpcTransport>[0][] = [];
    try {
      const deps = createCliActionDeps({ ...params,
        readRoleSources: createRoleSourceReaderV1({}),
        // The network port is the only effect boundary; role resolution,
        // caller opening, Action admission and origin validation remain real.
        sessionActionRpcTransport: async (request) => { forwarded.push(request); return { updated: true }; },
      });
      const agentStartContext = resolveCliAgentStartContextV1({ sessionId, metadata,
        machineId: metadata.machineId, directory: metadata.path, backendTarget: metadata.backendTarget,
        starterDepth: 2, turnDepth: 3, callerPermissionMode: 'default', settings,
        roleSourceInventory: await createRoleSourceReaderV1({})(),
        accountRoleOverrides: { status: 'ready', overrides: {} } });
      if (!agentStartContext || agentStartContext.caller.kind !== 'session') throw new Error('invalid host caller fixture');
      const context: ActionExecutorContext = {
        surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId,
        actionCaller: agentStartContext.caller, agentStartContext,
        callerPermissionMode: 'default', actionRequestId: 'original-request',
      };
      const executor = createActionExecutor(deps);
      const input = { sessionId, notes: 'Coordinate' };
      for (const source of [undefined, null, 'untrusted-origin', 1, true,
        { sourceSessionId: 'foreign-session', sourceTurnId: 'original-turn' }]) {
        expect(await executor.execute('session.notes.set', input, { ...context, sessionInputSource: source }))
          .toMatchObject({ ok: false, errorCode: 'action_failed', error: 'role_rpc_origin_unavailable' });
        expect(forwarded).toEqual([]);
      }
      expect(await executor.execute('session.notes.set', input, { ...context,
        sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'original-turn' } }))
        .toEqual({ ok: true, result: { updated: true } });
      expect(forwarded).toMatchObject([{ sessionId, method: 'session.notes.set', input,
        origin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
          sourceTurnId: 'original-turn', requestId: 'original-request', callerPermissionMode: 'default' } }]);
    } finally { cleanup(); }
  });

  it('uses the exact caller Session instead of the global executor host snapshot', async () => {
    // The authenticated runner owner proves liveness; Home's heartbeat
    // projection can lag and must not become a second admission decision.
    const { params, sessionId, cleanup } = callerSessionFixture('/caller/repo', 2, false);
    try {
      const deps = createCliActionDeps({ ...params, getCurrentTurnWorkDepth: () => 3 });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { machineId: 'caller-machine', directory: '/caller/repo',
          configuration: { agentTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } },
        workDepthLimit: 7,
      });
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: 'foreign-session',
        callerPermissionMode: 'default' })).resolves.toBeNull();
      await expect(deps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'host' }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toBeNull();
    } finally { cleanup(); }
  });

  it('retains original admitted depths for replay while rebuilding the current baseline', async () => {
    const { params, sessionId, cleanup } = callerSessionFixture('/current/repo', 4);
    try {
      const replayDeps = createCliActionDeps(params);
      await expect(replayDeps.resolveAgentStartContext?.({ surface: 'agent',
        actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId,
        callerPermissionMode: 'default' })).resolves.toMatchObject({
        caller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 },
        baseline: { directory: '/current/repo', machineId: 'caller-machine' }, workDepthLimit: 7,
      });
    } finally { cleanup(); }
  });
});
