import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { createDeferred } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ensureVoiceConversationSessionForVoiceHome } from '@/voice/persistence/voiceConversationSession';

installDisconnectedServerSocketBoundary();
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let rowDefinitions: readonly unknown[];

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const { machineContributionRegistryProjectionDescribe } = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }) as never,
  ),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>(),
  machineContributionRegistryProjectionDescribe,
}));

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
  machineContributionRegistryProjectionDescribe.mockResolvedValue({
    supported: true,
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
  expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith(
    machineId,
    expect.objectContaining({ serverId: getActiveServerSnapshot().serverId }),
  );
}

beforeEach(async () => {
  account = undefined;
  rowDefinitions = [];
  clearDaemonMergedProjectionCacheForTests();
  machineContributionRegistryProjectionDescribe.mockReset();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
  account = await restoreServerAccountForTest({ serverUrl: 'https://voice-resolver.example.test', accountId: 'voice-resolver-account',
    request: async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      if (path === '/v2/account/settings') return Response.json({ version: 4, content: { t: 'plain', v: {} } });
      if (path === '/v1/artifacts') return Response.json([]);
      if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
      if (path === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
      if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 3,
        content: { t: 'plain', v: { v: 1, definitions: rowDefinitions } } });
      return new Response(null, { status: 404 });
    },
  });
  const scope = { serverId: account.home.id, accountId: 'voice-resolver-account' };
  storage.setState({ profileScope: scope, settingsScope: scope, settings: settingsParse({}), machines: {}, sessions: {} });
  await refreshAcpCatalog(scope);
});

afterEach(async () => {
  resetAcpCatalogEngineForTests();
  resetAcpCatalogSnapshotsForTests();
  await account?.dispose();
});

describe('resolveVoiceConfiguredAgentTarget', () => {
  it('loads the exact configured Voice target from destination rows without the raw Settings root', async () => {
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      command: 'review', createdAt: 1, updatedAt: 1 });
    rowDefinitions = [definition];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
    } })).resolves.toMatchObject({ ok: true, kind: 'catalog',
      backendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' } });
  });

  it('resolves a legacy configured ACP carrier through the ready destination catalog', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      command: 'review', createdAt: 1, updatedAt: 1 })];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: 'acp:row-review', agentTargetKey: null, agentIdentity: null,
    } })).resolves.toMatchObject({ ok: true, kind: 'catalog',
      backendTarget: { kind: 'backend', backendId: 'row-review', configuredBackendId: 'row-review' } });
  });

  it.each(['exact', 'legacy'] as const)('refuses a %s configured target when destination rows have an incomplete inventory', async kind => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      command: 'review', createdAt: 1, updatedAt: 1 }), { id: 'malformed-neighbor' }];
    resetAcpCatalogSnapshotsForTests();
    await expect(resolveVoiceConfiguredAgentTarget({ machineId: null, selection: {
      agentId: kind === 'legacy' ? 'acp:row-review' : 'row-review',
      agentTargetKey: kind === 'legacy' ? null : 'backend:row-review:configured:row-review', agentIdentity: null,
    } })).resolves.toMatchObject({ ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE });
  });

  it.each(['ready', 'incomplete'] as const)('uses %s destination facts through the real Voice persistence entrypoint', async status => {
    const definition = AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      command: 'review', createdAt: 1, updatedAt: 1 });
    rowDefinitions = status === 'ready' ? [definition] : [definition, { id: 'malformed-neighbor' }];
    resetAcpCatalogSnapshotsForTests();
    const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults,
      executionMachine: { mode: 'fixed', machineId: 'machine-1' } }, { ...cfg, conversationMode: 'agent', agent: {
      ...cfg.agent, agentSource: 'agent', agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
    } });
    storage.setState({ settings: settingsParse({ voice }), machines: {
      'machine-1': createMachineFixture({ activeAt: Date.now() }),
    } });
    // The ready row reaches installed-Agent admission. This fixture's genuine
    // daemon boundary has no installed owner; it cannot fabricate that identity.
    await expect(ensureVoiceConversationSessionForVoiceHome()).rejects.toMatchObject({
      code: status === 'ready' ? 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE' : 'VOICE_AGENT_SELECTION_UNAVAILABLE',
    });
  });

  it('refuses an external selection when its Account lifetime retires during daemon resolution', async () => {
    const entered = createDeferred<void>();
    const response = createDeferred<Awaited<ReturnType<MachineContributionRegistryProjectionDescribeFn>>>();
    machineContributionRegistryProjectionDescribe.mockImplementation(() => { entered.resolve(); return response.promise; });
    const pending = resolveVoiceConfiguredAgentTarget({ machineId: 'machine-1', selection: {
      agentId: EXTERNAL_AGENT_ID, agentTargetKey: EXTERNAL_TARGET_KEY, agentIdentity: EXTERNAL_IDENTITY,
    } });
    await entered.promise;
    retireActiveServerAccountScopeLifetime();
    response.resolve({ supported: true, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
      agentsById: { [EXTERNAL_AGENT_ID]: { id: EXTERNAL_AGENT_ID, identity: EXTERNAL_IDENTITY } }, familiesById: {},
    }) });
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE });
  });

  it('refuses Voice persistence launch when its captured Account retires during final daemon admission', async () => {
    rowDefinitions = [AcpBackendDefinitionV1Schema.parse({ id: 'row-review', name: 'row-review', title: 'Row review',
      command: 'review', createdAt: 1, updatedAt: 1 })];
    await refreshAcpCatalog({ serverId: account!.home.id, accountId: 'voice-resolver-account' });
    const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults,
      executionMachine: { mode: 'fixed', machineId: 'machine-1' } }, { ...cfg, conversationMode: 'agent', agent: {
      ...cfg.agent, agentSource: 'agent', agentId: 'row-review', agentTargetKey: 'backend:row-review:configured:row-review', agentIdentity: null,
    } });
    storage.setState({ settings: settingsParse({ voice }), machines: {
      'machine-1': createMachineFixture({ activeAt: Date.now() }),
    } });
    const entered = createDeferred<void>();
    const response = createDeferred<Awaited<ReturnType<MachineContributionRegistryProjectionDescribeFn>>>();
    machineContributionRegistryProjectionDescribe.mockImplementation(() => { entered.resolve(); return response.promise; });
    const pending = ensureVoiceConversationSessionForVoiceHome();
    await entered.promise;
    retireActiveServerAccountScopeLifetime();
    response.resolve({ supported: false, reason: 'not-supported' });
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
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
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
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
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
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });

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
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted external selection no longer exists in the current machine catalog', async () => {
    // The machine projects a different generation where the Agent was uninstalled.
    clearDaemonMergedProjectionCacheForTests();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
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
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });

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
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
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
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
  });
});
