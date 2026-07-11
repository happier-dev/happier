import { describe, expect, it } from 'vitest';

import { assertAgentSettingsRegistryValid, getAllAgentSettingsDefinitions } from '@happier-dev/agents';

describe('agent settings registry (@happier-dev/agents)', () => {
  it('exposes a valid registry (no duplicate keys; defaults cover all shape fields)', () => {
    const defs = getAllAgentSettingsDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);

    expect(() => assertAgentSettingsRegistryValid()).not.toThrow();
  });
});
