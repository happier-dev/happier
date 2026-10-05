import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

beforeEach(() => {
  clearDaemonMergedProjectionCacheForTests();
  machineContributionRegistryProjectionDescribe.mockReset();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
});

describe('resolveVoiceConfiguredAgentTarget', () => {
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
