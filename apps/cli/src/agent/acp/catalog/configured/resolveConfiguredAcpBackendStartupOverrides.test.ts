import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfiguredAcpBackendStartupOverrides } from './resolveConfiguredAcpBackendStartupOverrides';

describe('resolveConfiguredAcpBackendStartupOverrides', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies backend default mode and model when explicit overrides are not provided', () => {
    const result = resolveConfiguredAcpBackendStartupOverrides(
      { credentials: {} as any },
      { defaultMode: 'plan', defaultModel: 'sonnet' },
    );

    expect(result).toMatchObject({
      agentModeId: 'plan',
      modelId: 'sonnet',
    });
    expect(result.agentModeUpdatedAt).toBe(Date.now());
    expect(result.modelUpdatedAt).toBe(Date.now());
  });

  it('preserves explicit mode and model overrides from the caller', () => {
    const result = resolveConfiguredAcpBackendStartupOverrides(
      {
        credentials: {} as any,
        agentModeId: 'build',
        agentModeUpdatedAt: 111,
        modelId: 'opus',
        modelUpdatedAt: 222,
      },
      { defaultMode: 'plan', defaultModel: 'sonnet' },
    );

    expect(result).toEqual({
      agentModeId: 'build',
      agentModeUpdatedAt: 111,
      modelId: 'opus',
      modelUpdatedAt: 222,
    });
  });
});
