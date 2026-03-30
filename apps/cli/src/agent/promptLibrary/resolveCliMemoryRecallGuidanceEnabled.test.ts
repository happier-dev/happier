import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_SETTINGS, type MemorySettingsV1 } from '@happier-dev/protocol';

import { resolveCliMemoryRecallGuidanceEnabled } from './resolveCliMemoryRecallGuidanceEnabled';

function buildMemorySettings(overrides: Readonly<Partial<MemorySettingsV1>>): MemorySettingsV1 {
  return {
    ...DEFAULT_MEMORY_SETTINGS,
    ...overrides,
  };
}

describe('resolveCliMemoryRecallGuidanceEnabled', () => {
  it('returns false when the active local memory index is not ready yet', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['mcp'],
      deps: {
        isActionEnabledByEnv: () => true,
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'deep',
        }),
        resolveMemoryIndexPaths: () => ({
          tier1DbPath: '/tmp/light.sqlite',
          deepDbPath: '/tmp/deep.sqlite',
          memoryDir: '/tmp',
          modelsDir: '/tmp/models',
        }),
        stat: async (_path: string) => {
          throw new Error('missing');
        },
      },
    });

    expect(enabled).toBe(false);
  });

  it('returns true when memory search is enabled for the requested surface and the active index exists', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['voice_tool', 'voice_action_block'],
      deps: {
        isActionEnabledByEnv: (actionId, ctx) =>
          ctx?.surface === 'voice_tool' && (actionId === 'memory.search' || actionId === 'memory.get_window'),
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'hints',
        }),
        resolveMemoryIndexPaths: () => ({
          tier1DbPath: '/tmp/light.sqlite',
          deepDbPath: '/tmp/deep.sqlite',
          memoryDir: '/tmp',
          modelsDir: '/tmp/models',
        }),
        stat: async (_path: string) => ({ size: 128 }),
      },
    });

    expect(enabled).toBe(true);
  });

  it('returns false when required memory actions are split across different surfaces', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['voice_tool', 'voice_action_block'],
      deps: {
        isActionEnabledByEnv: (actionId, ctx) => {
          if (ctx?.surface === 'voice_tool') return actionId === 'memory.search';
          if (ctx?.surface === 'voice_action_block') return actionId === 'memory.get_window';
          return false;
        },
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'hints',
        }),
        resolveMemoryIndexPaths: () => ({
          tier1DbPath: '/tmp/light.sqlite',
          deepDbPath: '/tmp/deep.sqlite',
          memoryDir: '/tmp',
          modelsDir: '/tmp/models',
        }),
        stat: async (_path: string) => ({ size: 128 }),
      },
    });

    expect(enabled).toBe(false);
  });
});
