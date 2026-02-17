import { describe, expect, it } from 'vitest';

import { DEFAULT_MEMORY_SETTINGS, MemorySettingsV1Schema, normalizeMemorySettings } from './memorySettings.js';

describe('memorySettings', () => {
  it('normalizes invalid payloads to defaults', () => {
    expect(normalizeMemorySettings({ v: 999, enabled: 'nope' } as any)).toEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it('parses a minimal v1 settings object', () => {
    const parsed = MemorySettingsV1Schema.parse({ v: 1, enabled: true });
    expect(parsed.v).toBe(1);
    expect(parsed.enabled).toBe(true);
    expect(parsed.indexMode).toBe('hints');
  });
});

