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
  it('returns true without probing the mutable index when the configured capability is enabled', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['mcp'],
      deps: {
        isActionEnabledByEnv: () => true,
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'deep',
        }),
      },
    });

    expect(enabled).toBe(true);
  });

  it('returns true when memory search is enabled for the requested surface and the active index exists', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['voice'],
      deps: {
        isActionEnabledByEnv: (actionId, ctx) =>
          ctx?.surface === 'voice' && (actionId === 'memory.search' || actionId === 'memory.get_window'),
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'hints',
        }),
      },
    });

    expect(enabled).toBe(true);
  });

  it('does not make guidance depend on whether the index currently has searchable content', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['voice'],
      deps: {
        isActionEnabledByEnv: (actionId, ctx) =>
          ctx?.surface === 'voice' && (actionId === 'memory.search' || actionId === 'memory.get_window'),
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'hints',
        }),
      },
    });

    expect(enabled).toBe(true);
  });

  it('returns false when a required memory action is disabled for the requested surface', async () => {
    const enabled = await resolveCliMemoryRecallGuidanceEnabled({
      surfaces: ['voice'],
      deps: {
        isActionEnabledByEnv: (actionId, ctx) => {
          if (ctx?.surface === 'voice') return actionId === 'memory.search';
          return false;
        },
        readMemorySettingsFromDisk: async () => buildMemorySettings({
          enabled: true,
          indexMode: 'hints',
        }),
      },
    });

    expect(enabled).toBe(false);
  });
});
