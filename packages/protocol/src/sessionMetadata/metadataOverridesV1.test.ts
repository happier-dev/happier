import { describe, expect, it } from 'vitest';
import * as protocol from '../index.js';

describe('sessionMetadata overrides v1', () => {
  it('builds and parses modelOverrideV1', () => {
    const built = (protocol as any).buildModelOverrideV1({ updatedAt: 1, modelId: 'gpt-x' });
    expect(built).toMatchObject({ v: 1, updatedAt: 1, modelId: 'gpt-x' });
    const parsed = (protocol as any).ModelOverrideV1Schema.parse({ ...built, extra: 'x' });
    expect((parsed as any).extra).toBe('x');
  });

  it('builds and parses acpSessionModeOverrideV1', () => {
    const built = (protocol as any).buildAcpSessionModeOverrideV1({ updatedAt: 2, modeId: 'plan' });
    expect(built).toMatchObject({ v: 1, updatedAt: 2, modeId: 'plan' });
    const parsed = (protocol as any).AcpSessionModeOverrideV1Schema.parse({ ...built, extra: 'x' });
    expect((parsed as any).extra).toBe('x');
  });

  it('builds and parses acpConfigOptionOverridesV1', () => {
    const built = (protocol as any).buildAcpConfigOptionOverridesV1({
      updatedAt: 3,
      overrides: {
        opt_a: { updatedAt: 10, value: 'x' },
        opt_b: { updatedAt: 11, value: null },
        opt_c: { updatedAt: 12, value: 1 },
        opt_d: { updatedAt: 13, value: false },
      },
    });
    expect(built).toMatchObject({ v: 1, updatedAt: 3 });
    const parsed = (protocol as any).AcpConfigOptionOverridesV1Schema.parse({ ...built, extra: 'x' });
    expect((parsed as any).extra).toBe('x');
    expect(Object.keys((parsed as any).overrides ?? {})).toEqual(['opt_a', 'opt_b', 'opt_c', 'opt_d']);
  });
});

