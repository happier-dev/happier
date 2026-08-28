import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const { machineContributionRegistryProjectionDescribe } = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }) as never,
  ),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe,
  machinePluginSettingsGet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
  machinePluginSettingsSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
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
      backendsById: {
        [EXTERNAL_AGENT_ID]: { id: EXTERNAL_AGENT_ID, agentId: EXTERNAL_AGENT_ID },
      },
      familiesById: {},
    }),
  });
}

function expectProjectionDescribeCallsForMachine(machineId: string): void {
  expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith(
    machineId,
    expect.objectContaining({ serverId: null }),
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

  it('resolves a bundled selection through its exact backend target key without requiring a machine projection', async () => {
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });

    const result = await resolveVoiceConfiguredAgentTarget({
      machineId: null,
      selection: {
        agentId: 'claude',
        agentTargetKey: 'backend:claude',
        agentIdentity: null,
      },
    });

    expect(result).toEqual({
      ok: true,
      kind: 'catalog',
      agentId: 'claude',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      targetKey: 'backend:claude',
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
        backendsById: {},
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

  it('fails closed when the persisted external selection is disabled for this account', async () => {
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
      const result = await resolveVoiceConfiguredAgentTarget({
        machineId: 'machine-1',
        selection: {
          agentId: EXTERNAL_AGENT_ID,
          agentTargetKey: EXTERNAL_TARGET_KEY,
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
  });

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

  it('fails closed for a malformed persisted target key instead of spawning an arbitrary backend', async () => {
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
});
