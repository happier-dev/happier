import { describe, expect, it } from 'vitest';

import { SessionForkRpcParamsSchema } from './sessionFork.js';

describe('SessionForkRpcParamsSchema', () => {
  it('accepts a latest fork point request', () => {
    const parsed = SessionForkRpcParamsSchema.safeParse({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a seq fork point request', () => {
    const parsed = SessionForkRpcParamsSchema.safeParse({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      strategy: 'auto',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional replay summary runner config', () => {
    const parsed = SessionForkRpcParamsSchema.safeParse({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional replay maxSeedChars budget hint', () => {
    const parsed = SessionForkRpcParamsSchema.safeParse({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      replayMaxSeedChars: 40_000,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    const parsed = SessionForkRpcParamsSchema.safeParse({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      extra: 'nope',
    });
    expect(parsed.success).toBe(false);
  });
});
