import { describe, expect, it } from 'vitest';
import {
  SessionContextUsageSnapshotV1Schema,
  UsageObservationContextSchema,
  UsageObservationCostSchema,
  UsageObservationScopeSchema,
  UsageObservationTokensSchema,
} from '@happier-dev/protocol/runtime';

import * as usage from './usage.js';

describe('stable usage surface', () => {
  it('preserves the canonical portable Protocol schema identities', () => {
    expect(usage.SessionContextUsageSnapshotV1Schema)
      .toBe(SessionContextUsageSnapshotV1Schema);
    expect(usage.UsageObservationContextSchema).toBe(UsageObservationContextSchema);
    expect(usage.UsageObservationCostSchema).toBe(UsageObservationCostSchema);
    expect(usage.UsageObservationScopeSchema).toBe(UsageObservationScopeSchema);
    expect(usage.UsageObservationTokensSchema).toBe(UsageObservationTokensSchema);
  });

  it('exports the complete protocol-owned observation vocabulary', () => {
    expect(usage.UsageObservationScopeSchema.parse('session_final')).toBe('session_final');
    expect(usage.UsageObservationTokensSchema.parse({
      input: 1,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 5,
      total: 15,
    }).total).toBe(15);
    expect(usage.UsageObservationCostSchema.parse({
      reportedUsd: 0.1,
      estimatedUsd: 0,
      currency: 'USD',
    }).reportedUsd).toBe(0.1);
    expect(usage.UsageObservationContextSchema.parse({
      usedTokens: 1,
      windowTokens: 10,
    }).windowTokens).toBe(10);
    expect(usage.SessionContextUsageSnapshotV1Schema.parse({
      v: 1,
      modelId: null,
      usedTokens: 1,
      windowTokens: null,
      totalProcessedTokens: null,
      baselineTokens: null,
      isAutoCompactEnabled: null,
      categories: null,
      observedAtMs: 1,
      source: 'provider_turn',
    }).source).toBe('provider_turn');
  });

  it('builds the typed usage observation post-send effect', () => {
    const observation = {
      provider: 'codex',
      source: 'codex-app-server-token-usage',
      scope: 'session_cumulative',
      key: 'codex-session',
      modelId: 'gpt-5.4',
      tokens: { total: 10 },
      cost: null,
      contextUsedTokens: 8,
      contextWindowTokens: 400_000,
    } as const;

    expect(usage.buildUsageObservationEffect({
      observation,
      backendMode: 'app-server',
      externalKey: 'codex:thread-1:turn-1',
    })).toEqual({
      type: 'usageObservation',
      observation,
      backendMode: 'app-server',
      externalKey: 'codex:thread-1:turn-1',
    });
  });

  it('omits optional effect fields when callers do not supply them', () => {
    const observation = {
      provider: 'claude',
      source: 'claude-sdk-result',
      scope: 'session_final',
      key: null,
      modelId: null,
      tokens: null,
      cost: { total: 0.1 },
      contextUsedTokens: null,
      contextWindowTokens: null,
    } as const;

    expect(usage.buildUsageObservationEffect({ observation })).toEqual({
      type: 'usageObservation',
      observation,
    });
  });
});
