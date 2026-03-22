import { describe, expect, it } from 'vitest';
import type { MemoryStatusV1 } from '@happier-dev/protocol';

import { resolveUiMemoryRecallGuidanceEnabled } from './resolveUiMemoryRecallGuidanceEnabled';

function buildMemoryStatus(overrides?: Partial<MemoryStatusV1>): MemoryStatusV1 {
  return {
    v: 1,
    enabled: true,
    indexMode: 'hints',
    hintsIndexReady: true,
    deepIndexReady: false,
    activeIndexReady: true,
    embeddingsEnabled: false,
    embeddingsMode: 'disabled',
    embeddingsPresetId: null,
    embeddingsProviderKind: null,
    embeddingsModelId: null,
    embeddingsRuntimeState: 'ready',
    embeddingsUsingFallback: false,
    tier1DbPath: '/tmp/memory-hints.sqlite',
    deepDbPath: null,
    tier1DbBytes: 128,
    deepDbBytes: null,
    ...overrides,
  };
}

describe('resolveUiMemoryRecallGuidanceEnabled', () => {
  it('returns false when the required memory actions are not enabled on the target surface', async () => {
    const enabled = await resolveUiMemoryRecallGuidanceEnabled({
      settings: {},
      serverId: 'srv',
      machineId: 'machine',
      surfaces: ['voice_action_block'],
      deps: {
        resolveLocalFeaturePolicyEnabled: () => true,
        isActionEnabledInState: (_state, actionId, ctx) => ctx?.surface === 'voice_action_block' && actionId === 'memory.search',
        fetchDaemonMemoryStatus: async () => buildMemoryStatus(),
        isDaemonMemorySearchUsable: () => true,
      },
    });

    expect(enabled).toBe(false);
  });

  it('returns true when the feature is enabled, the surface exposes both actions, and memory is usable', async () => {
    const enabled = await resolveUiMemoryRecallGuidanceEnabled({
      settings: {},
      serverId: 'srv',
      machineId: 'machine',
      surfaces: ['voice_action_block'],
      deps: {
        resolveLocalFeaturePolicyEnabled: () => true,
        isActionEnabledInState: (_state, actionId, ctx) =>
          ctx?.surface === 'voice_action_block' && (actionId === 'memory.search' || actionId === 'memory.get_window'),
        fetchDaemonMemoryStatus: async () => buildMemoryStatus(),
        isDaemonMemorySearchUsable: () => true,
      },
    });

    expect(enabled).toBe(true);
  });
});
