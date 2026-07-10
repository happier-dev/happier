import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('session.spawn_new dev adaptation', () => {
  it('is discoverable but not direct by default on the agent surface', () => {
    const spec = getActionSpec('session.spawn_new');

    expect(spec.surfaces.agent).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
    expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
  });

  it('accepts configOptions as a shorthand alias when it does not conflict with canonical overrides', () => {
    const spec = getActionSpec('session.spawn_new');

    const parsed = spec.inputSchema.safeParse({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1710000000000,
        overrides: {
          reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
        },
      },
      configOptions: {
        ultracode: true,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects conflicting configOptions shorthand values for canonical override ids', () => {
    const spec = getActionSpec('session.spawn_new');

    const parsed = spec.inputSchema.safeParse({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 1710000000000,
        overrides: {
          reasoning_effort: { updatedAt: 1710000000000, value: 'xhigh' },
        },
      },
      configOptions: {
        reasoning_effort: 'high',
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['configOptions', 'reasoning_effort']);
  });
});
