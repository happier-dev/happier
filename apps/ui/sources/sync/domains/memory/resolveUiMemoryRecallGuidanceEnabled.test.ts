import { describe, expect, it } from 'vitest';
import type { MemoryStatusV1 } from '@happier-dev/protocol';

import { resolveUiMemoryRecallGuidanceEnabled } from './resolveUiMemoryRecallGuidanceEnabled';

function buildMemoryStatus(overrides?: Partial<MemoryStatusV1>): MemoryStatusV1 {
  return {
    v: 1,
    enabled: true,
    indexMode: 'hints',
    hintsIndexReady: true,
    hintsIndexHasContent: true,
    deepIndexReady: false,
    deepIndexHasContent: false,
    activeIndexReady: true,
    activeIndexSearchable: true,
    indexContent: {
      lightShardCount: 1,
      lightTermCount: 8,
      deepChunkCount: 0,
      deepEmbeddingCount: 0,
      searchableSessionCount: 1,
      lastIndexedAtMs: 1,
      latestIndexedMessageAtMs: 1,
    },
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
    worker: null,
    queue: null,
    lastRun: null,
    ...overrides,
  };
}

describe('resolveUiMemoryRecallGuidanceEnabled', () => {
  it('returns false when the required memory actions are not enabled on the target surface', async () => {
    const enabled = await resolveUiMemoryRecallGuidanceEnabled({
      settings: {},
      serverId: 'srv',
      machineId: 'machine',
      surfaces: ['voice'],
      deps: {
        resolveLocalFeaturePolicyEnabled: () => true,
        isActionEnabledInState: (_state, actionId, ctx) => ctx?.surface === 'voice' && actionId === 'memory.search',
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
      surfaces: ['voice'],
      deps: {
        resolveLocalFeaturePolicyEnabled: () => true,
        isActionEnabledInState: (_state, actionId, ctx) =>
          ctx?.surface === 'voice' && (actionId === 'memory.search' || actionId === 'memory.get_window'),
        fetchDaemonMemoryStatus: async () => buildMemoryStatus(),
        isDaemonMemorySearchUsable: () => true,
      },
    });

    expect(enabled).toBe(true);
  });
});
