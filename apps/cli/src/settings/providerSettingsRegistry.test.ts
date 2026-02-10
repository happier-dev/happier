import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { assertProviderSettingsRegistryValid, getAllProviderSettingsDefinitions } from '@happier-dev/agents';

describe('provider settings registry (@happier-dev/agents)', () => {
  it('exposes a valid registry (no duplicate keys; defaults cover all shape fields)', () => {
    const defs = getAllProviderSettingsDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);

    expect(() => assertProviderSettingsRegistryValid(z)).not.toThrow();
  });
});

