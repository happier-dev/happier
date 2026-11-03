import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { PluginProjectionV2Schema, SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { storage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { createDeferred } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExistingSessionDirectoryPreflightResult } from '@/dev/testkit/fixtures/sessionFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ensureVoiceConversationSessionForVoiceHome } from '@/voice/persistence/voiceConversationSession';

installDisconnectedServerSocketBoundary(socket => {
  vi.mocked(socket.connect).mockImplementation(() => {
    if (socket.connected) return socket;
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  // The real scoped pool may retain this external Socket across Account
  // lifetimes; restoring per-test spies must not restore a live SDK transport.
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event !== 'rpc-call') throw new Error(`Unexpected socket acknowledgement: ${event}`);
    const request = payload as { method: string; params: unknown };
    const separator = request.method.indexOf(':');
    if (separator < 1) throw new Error('Expected machine-addressed Socket RPC');
    return { ok: true, result: await machineRpc({ machineId: request.method.slice(0, separator),
      method: request.method.slice(separator + 1), payload: request.params }) };
  });
});
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const restoreActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreActionExecutorModuleLoader);

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let rowDefinitions: readonly unknown[];
let acpAvailable = true;
let acpRequests = 0;

// The wire is untyped until the real RPC client's protocol reader admits it.
type MachineRpcFn = (params: { machineId: string; method: string; payload: unknown }) => Promise<unknown>;

const { machineRpc } = vi.hoisted(() => ({
  machineRpc: vi.fn<MachineRpcFn>(async () => ({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' })),
}));

// Only Socket.IO acknowledgements are synthetic. The scoped RPC adapter,
// Account crypto, registry parsing and lifetime admission remain real.

import {
  resolveVoiceConfiguredAgentTarget,
  VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
} from './resolveVoiceConfiguredAgentTarget';

/**
 * A novel external qualified Agent: `acme.voice/agent` is its qualified
 * contribution identity, projected by the machine as registry entry
 * `acme-voice-agent` whose runtime backend is the same id.
 */
const EXTERNAL_IDENTITY = { pluginId: 'acme.voice', localId: 'agent' } as const;
const EXTERNAL_TARGET_KEY = 'agent:acme.voice/agent';
const EXTERNAL_AGENT_ID = 'acme-voice-agent';

function enableExternalAgentProjection(generation: number): void {
  clearDaemonMergedProjectionCacheForTests();
  machineRpc.mockResolvedValue({
    protocolVersion: 1,
    projection: PluginProjectionV2Schema.parse({
      v: 2,
      generation,
      agentsById: {
        [EXTERNAL_AGENT_ID]: {
          id: EXTERNAL_AGENT_ID,
          identity: EXTERNAL_IDENTITY,
          title: 'Acme Voice Agent',
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
        claude: {
          id: 'claude',
          isBuiltIn: true,
          capabilities: {
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn'],
              cancel: true,
            },
          },
        },
      },
      familiesById: {},
    }),
  });
}

function expectProjectionDescribeCallsForMachine(machineId: string): void {
  expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
    machineId,
    method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
  }));
}

beforeEach(async () => {
  account = undefined;
  rowDefinitions = [];
  acpAvailable = true;
  acpRequests = 0;
  clearDaemonMergedProjectionCacheForTests();
  machineRpc.mockReset();
  machineRpc.mockResolvedValue({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });
  account = await restoreServerAccountForTest({ serverUrl: 'https://voice-resolver.example.test', accountId: 'voice-resolver-account', credentialScope: 'restored-home',
    request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(
        JSON.parse(String(init.body)), id => id === 'machine-1'
          ? createPlainMachineRowFixture({ id, accountId: 'voice-resolver-account' }) : null);
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v1/machines') return Response.json([
        createPlainMachineRowFixture({ id: 'machine-1', accountId: 'voice-resolver-account' }),
      ]);
      if (path === '/v1/machines/machine-1') return Response.json({ machine:
        createPlainMachineRowFixture({ id: 'machine-1', accountId: 'voice-resolver-account' }),
      });
      if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
      if (path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
      if (path === '/v1/machines/machine-1/access') {
        const custodian = { accountId: 'voice-resolver-account', displayName: 'Voice Account' };
        return Response.json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: 'machine-1', custodian,
          access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
          canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
        }));
      }
      if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
        acpRequests += 1;
        return acpAvailable ? Response.json({ status: 'present', revision: 3,
          content: { t: 'plain', v: { v: 1, definitions: rowDefinitions } } }) : new Response(null, { status: 503 });
      }
      return new Response(null, { status: 404 });
    },
  });
  const scope = { serverId: account.home.id, accountId: 'voice-resolver-account' };
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}), machines: {}, sessions: {} });
  const { sync } = await import('@/sync/sync');
  await sync.refreshMachines();
  expect(storage.getState().machines['machine-1']).toMatchObject({ storageMode: 'plain' });
  await refreshAcpCatalog(scope);
});

afterEach(async () => {
  resetAcpCatalogEngineForTests();
  resetAcpCatalogSnapshotsForTests();
  await account?.dispose();
});

describe('resolveVoiceConfiguredAgentTarget', () => {
  it('refuses a presentation-only Agent without a configured definition', async () => {
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: 'custom-acp', agentTargetKey: null, agentIdentity: null,
    } })).resolves.toMatchObject({ ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE });
  });

  it('accepts the configured ACP catalog choice through the public setting binding and runtime resolver', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'qa-foldseed-acp', name: 'opencode', title: 'OpenCode ACP',
      launch: { kind: 'command', command: 'opencode', args: ['acp'] }, createdAt: 1, updatedAt: 1 })];
    resetAcpCatalogSnapshotsForTests();
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createVoiceAgentSettingsCatalogReader } = await import('@/sync/ops/actions/voiceAgentSettingsCatalog');
    const { voiceAgentSelectionBinding } = await import('@/voice/settings/voiceSettingBinding');
    const targetKey = 'agent:happier.agent.custom-acp/custom-acp:definition:qa-foldseed-acp';
    const captured = await captureLazyActionAccountContext(account!.home.id);
    try {
      const settings = settingsParse({ voice: writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
        ...readLocalConversationVoiceSettings(voiceSettingsDefaults), conversationMode: 'agent',
      }) });
      if (voiceAgentSelectionBinding.kind !== 'owner') throw new Error('Expected the canonical Voice selection owner');
      expect(voiceAgentSelectionBinding.parse(targetKey)).toEqual({ success: true, value: targetKey });
      const prepared = await voiceAgentSelectionBinding.prepare!(settings, targetKey, {
        readAgentCatalog: createVoiceAgentSettingsCatalogReader(captured),
      });
      expect(prepared).not.toBeNull();
      const next = prepared!(settings);
      expect(next).not.toBeNull();
      const selection = readLocalConversationVoiceSettings(next!.voice).agent;
      expect(selection).toMatchObject({ agentId: 'custom-acp', agentTargetKey: targetKey });
      await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection })).resolves.toMatchObject({
        ok: true, targetKey, backendTarget: { kind: 'backend', backendId: 'qa-foldseed-acp',
          configuredBackendId: 'qa-foldseed-acp', sourceKind: 'configured' },
      });
    } finally { captured.dispose(); }
  });

  it.each(['bundled', 'installed'] as const)('resolves an exact %s Agent independently of unavailable configured-ACP rows', async kind => {
    acpAvailable = false;
    const scope = { serverId: account!.home.id, accountId: 'voice-resolver-account' };
    await refreshAcpCatalog(scope);
    const { getAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
    expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe('unavailable');
    acpRequests = 0;
    if (kind === 'installed') enableExternalAgentProjection(7);
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: 'machine-1', accountScope: scope, selection: kind === 'bundled'
      ? { agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex', agentIdentity: null }
      : { agentId: EXTERNAL_AGENT_ID, agentTargetKey: EXTERNAL_TARGET_KEY, agentIdentity: EXTERNAL_IDENTITY },
    })).resolves.toMatchObject({ ok: true, backendTarget: { kind: 'backend',
      backendId: kind === 'bundled' ? 'codex' : EXTERNAL_AGENT_ID } });
    // Independent Agent selection must not refetch the unrelated ACP row.
    expect(acpRequests).toBe(0);
  });

  it('restores the original R40 bundled OpenCode selection through the real Account catalog binding', async () => {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createVoiceAgentSettingsCatalogReader } = await import('@/sync/ops/actions/voiceAgentSettingsCatalog');
    const { voiceAgentSelectionBinding } = await import('@/voice/settings/voiceSettingBinding');
    const captured = await captureLazyActionAccountContext(account!.home.id);
    try {
      const settings = settingsParse({ voice: writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
        ...readLocalConversationVoiceSettings(voiceSettingsDefaults), conversationMode: 'agent',
        agent: { ...readLocalConversationVoiceSettings(voiceSettingsDefaults).agent, agentSource: 'session', agentId: 'codex',
          agentTargetKey: 'agent:happier.agent.codex/codex', agentIdentity: null,
          chatModelSource: 'custom', chatModelId: 'gpt-6-luna' },
      }) });
      if (voiceAgentSelectionBinding.kind !== 'owner') throw new Error('Expected the canonical Voice selection owner');
      const prepared = await voiceAgentSelectionBinding.prepare!(settings, 'agent:happier.agent.opencode/opencode', {
        readAgentCatalog: createVoiceAgentSettingsCatalogReader(captured),
      });
      expect(prepared).not.toBeNull();
      const restored = prepared!(settings);
      expect(restored).not.toBeNull();
      expect(readLocalConversationVoiceSettings(restored!.voice).agent).toMatchObject({ agentSource: 'session', agentId: 'opencode',
        agentTargetKey: 'agent:happier.agent.opencode/opencode', agentIdentity: null,
        chatModelId: 'gpt-6-luna' });
    } finally { captured.dispose(); }
  });

  it('loads the exact configured Voice target from destination rows without the raw Settings root', async () => {
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 });
    rowDefinitions = [definition];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
    } })).resolves.toMatchObject({ ok: true, kind: 'catalog',
      backendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' } });
  });

  it('resolves a legacy configured ACP carrier through the ready destination catalog', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 })];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: 'acp:row-review', agentTargetKey: null, agentIdentity: null,
    } })).resolves.toMatchObject({ ok: true, kind: 'catalog',
      backendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' } });
  });

  it('does not resolve a different configured ACP id from an otherwise ready catalog', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 })];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: 'acp:another-row', agentTargetKey: null, agentIdentity: null,
    } })).resolves.toMatchObject({ ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE });
  });

  it.each(['exact', 'legacy'] as const)('refuses a %s configured target when destination rows have an incomplete inventory', async kind => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 }), { id: 'malformed-neighbor' }];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: kind === 'legacy' ? 'acp:row-review' : 'row-review',
      agentTargetKey: kind === 'legacy' ? null : 'backend:row-review:configured:row-review', agentIdentity: null,
    } })).resolves.toMatchObject({ ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE });
  });

  it.each(['ready', 'incomplete'] as const)('uses %s destination facts through the real Voice persistence entrypoint', async status => {
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 });
    rowDefinitions = status === 'ready' ? [definition] : [definition, { id: 'malformed-neighbor' }];
    resetAcpCatalogSnapshotsForTests();
    const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults,
      executionMachine: { mode: 'fixed', machineId: 'machine-1' } }, { ...cfg, conversationMode: 'agent', agent: {
      ...cfg.agent, agentSource: 'agent', agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
    } });
    storage.setState({ settings: settingsParse({ voice }) });
    machineRpc.mockImplementation(async request => {
      if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
        return createExistingSessionDirectoryPreflightResult(request.payload);
      }
      if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) {
        const input = SessionSpawnNewInputV2Schema.parse(request.payload);
        expect(input.agentTarget).toMatchObject({ definitionId: 'row-review' });
        return { type: 'error', code: 'incompatible_target', retryable: false };
      }
      return { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
    });
    // A ready catalog must carry the exact selected definition to the real
    // creation owner. The external daemon has no compatible installed target.
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: status === 'ready' ? 'incompatible_target' : 'VOICE_AGENT_SELECTION_UNAVAILABLE',
    });
    const spawnRequests = machineRpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW);
    expect(spawnRequests).toHaveLength(status === 'ready' ? 1 : 0);
  });

  it('refuses an external selection when its Account lifetime retires during daemon resolution', async () => {
    const entered = createDeferred<void>();
    const response = createDeferred<Awaited<ReturnType<MachineRpcFn>>>();
    machineRpc.mockImplementation(() => { entered.resolve(); return response.promise; });
    const pending = resolveVoiceConfiguredAgentTarget({ machineId: 'machine-1', selection: {
      agentId: EXTERNAL_AGENT_ID, agentTargetKey: EXTERNAL_TARGET_KEY, agentIdentity: EXTERNAL_IDENTITY,
    } });
    await entered.promise;
    retireActiveServerAccountScopeLifetime();
    response.resolve({ protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
      agentsById: { [EXTERNAL_AGENT_ID]: { id: EXTERNAL_AGENT_ID, identity: EXTERNAL_IDENTITY } }, familiesById: {},
    }) });
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE });
  });

  it('refuses Voice persistence launch when its captured Account retires during final daemon admission', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      launch: { kind: 'command' as const, command: 'review', args: [] }, createdAt: 1, updatedAt: 1 })];
    await refreshAcpCatalog({ serverId: account!.home.id, accountId: 'voice-resolver-account' });
    const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults,
      executionMachine: { mode: 'fixed', machineId: 'machine-1' } }, { ...cfg, conversationMode: 'agent', agent: {
      ...cfg.agent, agentSource: 'agent', agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
    } });
    storage.setState({ settings: settingsParse({ voice }) });
    const entered = createDeferred<void>();
    const response = createDeferred<Awaited<ReturnType<MachineRpcFn>>>();
    machineRpc.mockImplementation(() => { entered.resolve(); return response.promise; });
    const pending = ensureVoiceConversationSessionForVoiceHome();
    await entered.promise;
    retireActiveServerAccountScopeLifetime();
    response.resolve({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });
    await expect(pending).rejects.toMatchObject({ code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
  });

  it('resolves a novel external qualified Agent to its exact projected backend target on the target machine', async () => {
    enableExternalAgentProjection(7);

    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: {
        agentId: EXTERNAL_AGENT_ID,
        agentTargetKey: EXTERNAL_TARGET_KEY,
        agentIdentity: EXTERNAL_IDENTITY,
      },
    });

    expect(result).toEqual({
      ok: true,
      kind: 'catalog',
      agentId: EXTERNAL_AGENT_ID,
      backendTarget: { kind: 'backend', backendId: EXTERNAL_AGENT_ID },
      targetKey: EXTERNAL_TARGET_KEY,
    });
    expectProjectionDescribeCallsForMachine('machine-1');
  });

  it('preserves a slash-containing external local identity through catalog resolution', async () => {
    const identity = { pluginId: 'acme.voice', localId: 'agents/reviewer' } as const;
    const targetKey = 'agent:acme.voice/agents/reviewer';
    const agentId = 'acme-voice-reviewer';
    clearDaemonMergedProjectionCacheForTests();
    machineRpc.mockResolvedValue({
      protocolVersion: 1,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 9,
        agentsById: {
          [agentId]: {
            id: agentId,
            identity,
            title: 'Acme Voice Reviewer',
            capabilities: {
              sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
            },
          },
        },
        familiesById: {},
      }),
    });

    await expect(resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: { agentId, agentTargetKey: targetKey, agentIdentity: identity },
    })).resolves.toEqual({
      ok: true,
      kind: 'catalog',
      agentId,
      backendTarget: { kind: 'backend', backendId: agentId },
      targetKey,
    });
  });

  it('retains the maximum valid external identity instead of narrowing it to a backend-sized id', async () => {
    // Exactly MAX_PLUGIN_IDENTIFIER_BYTES on both halves. A canonical Plugin id
    // is a dotted namespace, so the maximum *valid* id must carry a dot; a
    // dotless 256-byte string is not an identity this corridor can ever see.
    const pluginId = `p${'l'.repeat(253)}.x`;
    const localId = `a${'g'.repeat(255)}`;
    const identity = { pluginId, localId } as const;
    const agentId = 'max-identity-agent';
    const targetKey = `agent:${pluginId}/${localId}`;
    clearDaemonMergedProjectionCacheForTests();
    machineRpc.mockResolvedValue({
      protocolVersion: 1,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 10,
        agentsById: {
          [agentId]: {
            id: agentId,
            identity,
            title: 'Maximum Identity Agent',
            capabilities: {
              sessions: { open: ['create'], delivery: ['newTurn'], cancel: false },
            },
          },
        },
        familiesById: {},
      }),
    });

    await expect(resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: { agentId, agentTargetKey: targetKey, agentIdentity: identity },
    })).resolves.toEqual({
      ok: true,
      kind: 'catalog',
      agentId,
      backendTarget: { kind: 'backend', backendId: agentId },
      targetKey,
    });
  });

  it('resolves a released bundled backend key to the canonical Agent target without requiring a machine projection', async () => {
    machineRpc.mockResolvedValue({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });

    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: null,
      selection: {
        agentId: 'claude',
        agentTargetKey: 'agent:happier.agent.claude/claude',
        agentIdentity: null,
      },
    });

    expect(result).toEqual({
      ok: true,
      kind: 'catalog',
      agentId: 'claude',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      targetKey: 'agent:happier.agent.claude/claude',
    });
    expect(machineRpc).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted external selection no longer exists in the current machine catalog', async () => {
    // The machine projects a different generation where the Agent was uninstalled.
    clearDaemonMergedProjectionCacheForTests();
    machineRpc.mockResolvedValue({
      protocolVersion: 1,
      projection: PluginProjectionV2Schema.parse({
        v: 2,
        generation: 8,
        agentsById: {
          claude: {
            id: 'claude',
            isBuiltIn: true,
            capabilities: {
              sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
            },
          },
        },
        familiesById: {},
      }),
    });

    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: {
        agentId: EXTERNAL_AGENT_ID,
        agentTargetKey: EXTERNAL_TARGET_KEY,
        agentIdentity: EXTERNAL_IDENTITY,
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
      agentId: EXTERNAL_AGENT_ID,
      agentTargetKey: EXTERNAL_TARGET_KEY,
    });
  });

  it.each([EXTERNAL_TARGET_KEY, 'malformed-persisted-key'])(
    'fails closed when the persisted external selection is disabled for this account (key=%s)',
    async (agentTargetKey) => {
      enableExternalAgentProjection(7);
      const { storage } = await import('@/sync/domains/state/storage');
      const original = storage.getState().settings;
      storage.setState((state) => ({
        ...state,
        settings: {
          ...state.settings,
          backendEnabledByTargetKey: {
            ...state.settings.backendEnabledByTargetKey,
            [EXTERNAL_TARGET_KEY]: false,
          },
        },
      }));
      try {
        expect(storage.getState().settings.backendEnabledByTargetKey[EXTERNAL_TARGET_KEY]).toBe(false);
        const result = await resolveVoiceConfiguredAgentTarget({
          machineId: 'machine-1',
          selection: {
            agentId: EXTERNAL_AGENT_ID,
            agentTargetKey,
            agentIdentity: EXTERNAL_IDENTITY,
          },
        });

        expect(result).toMatchObject({
          ok: false,
          errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
        });
      } finally {
        storage.setState((state) => ({ ...state, settings: original }));
      }
    },
  );

  it('keeps a legacy persisted Agent id working as a raw backend target when no exact facts were recorded', async () => {
    machineRpc.mockResolvedValue({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });

    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: null,
      selection: {
        agentId: 'codex',
        agentTargetKey: null,
        agentIdentity: null,
      },
    });

    expect(result).toEqual({
      ok: true,
      kind: 'legacy',
      agentId: 'codex',
      backendTarget: { kind: 'backend', backendId: 'codex' },
      targetKey: null,
    });
    expect(machineRpc).not.toHaveBeenCalled();
  });

  it('recovers a malformed persisted key only from the authoritative current identity', async () => {
    enableExternalAgentProjection(7);

    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: 'machine-1',
      selection: {
        agentId: EXTERNAL_AGENT_ID,
        agentTargetKey: 'not-a-target-key',
        agentIdentity: EXTERNAL_IDENTITY,
      },
    });

    // The identity still resolves against the current catalog, so the selection
    // is recoverable from the authoritative fact even when the key cannot parse.
    expect(result).toEqual({
      ok: true,
      kind: 'catalog',
      agentId: EXTERNAL_AGENT_ID,
      backendTarget: { kind: 'backend', backendId: EXTERNAL_AGENT_ID },
      targetKey: EXTERNAL_TARGET_KEY,
    });
  });

  it('fails closed for a malformed persisted key without an authoritative identity', async () => {
    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: null,
      selection: {
        agentId: 'untrusted-backend-id',
        agentTargetKey: 'not-a-target-key',
        agentIdentity: null,
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
      agentId: 'untrusted-backend-id',
      agentTargetKey: 'not-a-target-key',
    });
    expect(machineRpc).not.toHaveBeenCalled();
  });
});
