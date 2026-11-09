import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { tmpdir } from 'node:os';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1, type WorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { bindApiSessionSocketMock, createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import { loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { configuration } from '@/configuration';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/run-cause';
import { commitActiveAcpCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, PROFILE_ROWS_ROUTE_V1,
  sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';

const mocks = vi.hoisted(() => ({ io: vi.fn(), fetchSessionById: vi.fn(), fetchAccountEncryptionCurrentness: vi.fn() }));
// HTTP and Socket.IO are boundaries; authorization, catalogs and materialization remain real.
vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('@/session/transport/http/sessionsHttp', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(), fetchSessionById: mocks.fetchSessionById,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: mocks.fetchAccountEncryptionCurrentness,
}));
import { createProductionDaemonWorkflowRuntime, resolveWorkflowSessionConversation } from './daemonRuntime';

describe('scoped Automation daemon admission', () => {
  beforeAll(async () => {
    const workspaceRuntime = await pluginReloadController.acquireRuntimeRegistry({ resolveRuntimeRegistry: () =>
      resolveExecutablePluginRuntimeRegistry({ pluginIds: ['happier.agent.claude'] }) });
    await workspaceRuntime.release();
  });
  afterAll(async () => { await pluginReloadController.shutdown(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it.each([
    { agentId: 'claude', target: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    { agentId: 'custom-acp', target: { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'review-bot' } },
    { agentId: 'external.review/assistant', target: { kind: 'agent' as const, identity: { pluginId: 'external.review', localId: 'assistant' } } },
    { agentId: 'claude', target: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, r41d: true },
    { agentId: 'claude', target: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, r41d: true, differentMachine: true },
  ])('materializes scoped built-in roles from the authenticated $agentId origin Session engine ($r41d, differentMachine=$differentMachine)', async ({ agentId, target, ...scenario }) => {
    const r41d = 'r41d' in scenario;
    const differentMachine = 'differentMachine' in scenario;
    const profile = ProfileRecordV1Schema.parse({ v: 1, id: 'origin-launch', enabled: true,
      definition: { kind: 'inline', profile: { v: 2, id: 'origin-launch', name: 'Origin launch', createdAt: 1, updatedAt: 1 } },
      promptStack: [], secretBindings: {},
    });
    const modelId = r41d ? 'claude-haiku-4-5' : 'review-model';
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected' as const,
        selection: 'profile' as const, profileId: 'beee2181-b6ad-463c-8c96-5922f24555cd' },
    } };
    // R41d's available second family was configured ACP, even with the
    // optional second opinion disabled. Admission still resolves that leaf.
    const secondOpinionTarget = { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      definitionId: 'qa-c-exact-args' };
    const secondOpinionKey = buildBackendTargetKeyV2(secondOpinionTarget);
    const targetKey = buildBackendTargetKeyV2(target);
    const accountId = 'account-1';
    const machineId = 'machine-1';
    const sessionId = 'c123456789012345678901234';
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const credentials = { token: 'token', encryption: null } as const;
    const home = configuration.apiServerUrl;
    const captured = new Error('accepted_scoped_builtin_captured');
    const snapshots: WorkflowAcceptedSnapshotV1[] = [];
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    mocks.fetchSessionById.mockResolvedValue({ id: sessionId, seq: 0, active: true, activeAt: 1,
      createdAt: 1, updatedAt: 1, metadataVersion: 0, agentStateVersion: 0, agentState: null,
      dataEncryptionKey: null, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify({ machineId: differentMachine ? 'other-machine' : machineId, path: tmpdir(),
        runtimeDescriptorV1: { v: 1, agentId, agent: {} },
        ...(r41d ? { connectedServices, profileId: profile.id } : {}),
        ...('definitionId' in target ? { acpConfiguredBackendV1: { v: 1, backendId: target.definitionId, title: 'Review Bot', updatedAt: 1 } } : {}),
        ...(!r41d ? { work: { sessionRolesV1: { overrides: { judge: { roleId: 'judge', instructionsOverride: 'Use the scoped Session judge instructions.' } },
          sessionRoles: {}, notes: '' } } } : {}),
        modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: {
          agentTargetKey: targetKey, providerConnectionId: null, modelId,
        } },
      }),
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === `/v1/machines/${machineId}`) return { status: 200, data: {
        machine: { ...createAvailableSessionSpawnMachineSnapshot(machineId), storageMode: 'plain' },
      } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/account/settings') return { status: 200, data: {
        // HTTP serves persisted raw settings; the Settings owner applies projection defaults.
        content: { t: 'plain', v: {} }, version: 1,
      } };
      if (path === '/v1/artifacts') return { status: 200, data:
        new URL(String(url)).searchParams.has('kinds') || new URL(String(url)).searchParams.has('unclassified')
          ? { items: [], hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } } : [] };
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: ProfileRowsListResponseV1Schema.parse({
        status: 'listed', rows: [{ id: profile.id, revision: 1,
          content: sealProfileRecordContentV1({ mode: 'plain', material: null, record: profile }) }],
        nextCursor: null, complete: true, referenceGuardRevision: 1, transferControl: { status: 'absent' }, diagnostics: [],
      }) };
      if (path === `${PROFILE_ROWS_ROUTE_V1}/reference-guard`) return { status: 200, data: { status: 'ready', revision: 1 } };
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      if (path === `${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`) return { status: 200, data: { status: 'absent' } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [{
        key: 'role-overrides', revision: 1, content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } },
      }] } };
      throw new Error(`Unexpected scoped admission HTTP read ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (new URL(String(url)).pathname !== '/v3/automations/runs/workflow-storage'
        || !body || typeof body !== 'object' || !('operation' in body)
        || body.operation !== 'accepted-snapshot.resolve' || !('acceptedEnvelope' in body)
        || typeof body.acceptedEnvelope !== 'string') {
        throw new Error('Unexpected scoped admission effect');
      }
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(body.acceptedEnvelope),
      });
      if (opened.kind !== 'available') throw new Error('Scoped accepted snapshot unavailable');
      snapshots.push(opened.content);
      throw captured;
    });
    bindApiSessionSocketMock(mocks.io, createApiSessionSocketStub({ async emitWithAck(event, payload) {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
        || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)
        || !payload.method.startsWith(`${machineId}:`)) throw new Error('Unexpected scoped Machine RPC');
      const method = payload.method.slice(`${machineId}:`.length);
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
      // Answer only the Home network boundary. This fixture captures the
      // accepted snapshot before any receiving admission or Session effect.
      let result: unknown;
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) result = {
        protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { [agentId]: {
          id: agentId, identity: target.identity,
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }, ...(r41d ? { 'custom-acp': { id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } : {}) } },
      };
      else if (method === RPC_METHODS.CAPABILITIES_DETECT) result = { protocolVersion: 1, results: {
        [`cli.${agentId}`]: { ok: true, data: { installed: true, version: '1', latestVersion: null,
          update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
          platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
        'tool.executionRuns': { ok: true, data: { available: true, features: { detachedScope: true },
          backends: { ['definitionId' in target ? targetKey : agentId]: { available: true },
            ...(r41d ? { [secondOpinionKey]: { available: true } } : {}) } } },
      } };
      else throw new Error(`Unexpected scoped Machine read ${method}`);
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) };
    } }));
    const settings = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
    if (!settings.scopeKey) throw new Error('Missing scoped Account settings');
    const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () =>
      PromptLibraryRowsListResponseV1Schema.parse((await axios.get(`${home}${PROMPT_LIBRARY_ROWS_ROUTE_V1}`)).data) });
    expect(commitActivePromptLibraryCatalog({ scopeKey: settings.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog })).toBe(true);
    expect(commitActiveAcpCatalog({ scopeKey: settings.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog: { status: 'ready', revision: 1,
        record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: r41d ? secondOpinionTarget.definitionId : 'review-bot', name: 'review-bot', title: 'Review Bot',
          launch: { kind: 'command', command: 'review-bot', args: [] }, createdAt: 1, updatedAt: 1 }] }),
      } })).toBe(true);
    const runtime = createProductionDaemonWorkflowRuntime({ credentials, accountId });
    const coordinate = runtime.createCoordinatorForMachine({ machineId,
      machineAdmissionTransport: async () => { throw new Error('No Session effect before accepted snapshot'); },
      machineActionDirectTargetTransport: { machineId, invoke: async () => {
        throw new Error('No local Machine shortcut before accepted snapshot');
      } },
    });
    const admission = coordinate({ runId, automationId: 'automation-1', attempt: 1, expectedRevision: 1,
      accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      workflowDefinitionId: 'builtin:keep-going', scopeSessionId: sessionId, causeWorkDepth: 0,
      automationCause: AutomationRunCauseSchema.parse(r41d ? { kind: 'trigger', triggerId: 'bb164669-1aca-4e9f-b1b2-8b21a9459240',
        triggerRevision: 0, triggerKind: 'sessionLifecycle',
        occurrenceKey: 'JZls-NLYm2Y1iO-El5OSDjPzDfMVQn1iamUV0jB6KlI', occurredAt: 1792100420487,
        evidence: { sourceSessionId: sessionId, event: 'parentTurnCompleted',
          sourceTurnId: 'native-turn-55409cc7-dd37-46cf-8154-a255805c39d0-2', policy: { kind: 'everyMatch' } } }
        : { kind: 'manual', invokedAt: 1 }),
      definitionEnvelope: JSON.stringify({ t: 'plain', v: {
        workspace: { directory: tmpdir() }, executionTarget: { kind: 'session' },
        inputs: { maxRounds: 4, strikes: 3, secondOpinion: false },
      } }),
    });
    if (differentMachine) {
      await expect(admission).resolves.toEqual({ state: 'failed', reason: 'source_unavailable', admission: 'refused' });
      expect(snapshots).toEqual([]);
      expect(await resolveWorkflowSessionConversation({ credentials, sessionId, machineId })).toBeNull();
      return;
    }
    await expect(admission).rejects.toBe(captured);
    expect(await resolveWorkflowSessionConversation({ credentials, sessionId, machineId }))
      .toMatchObject({ agentTarget: target, runtimeSelection: { agentTarget: target } });
    expect(snapshots[0]).toMatchObject({ source: { kind: 'catalog', ref: 'builtin:keep-going' },
      materializedLeaves: expect.arrayContaining([expect.objectContaining({ sourceKey: '$root', blockId: 'check', kind: 'step',
        selection: expect.objectContaining({ agentTarget: target,
          ...(r41d ? { connectedServices, profileId: profile.id } : {}),
          modelSelection: expect.objectContaining({ ref: expect.objectContaining({ agentTargetKey: targetKey, modelId }) }) }),
        executionTarget: { kind: 'detached_run' }, authoredWorkspace: { kind: 'inherit' },
        role: expect.objectContaining({ roleId: 'judge', ...(!r41d ? { instructions: 'Use the scoped Session judge instructions.' } : {}) }),
      })]),
    });
    if (r41d) expect(snapshots[0]).toMatchObject({ materializedLeaves: expect.arrayContaining([
      expect.objectContaining({ blockId: 'second-opinion', selection: expect.objectContaining({ agentTarget: secondOpinionTarget }),
        role: expect.objectContaining({ engine: { agentTargetKey: secondOpinionKey } }) }),
    ]) });
    if (r41d) {
      const accepted = snapshots[0];
      expect(accepted.materializedLeaves.find(leaf => leaf.blockId === 'second-opinion')?.selection.connectedServices).toBeUndefined();
    }
  });
});
