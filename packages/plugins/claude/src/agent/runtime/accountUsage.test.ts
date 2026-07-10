import { describe, expect, it, vi } from 'vitest';

import { recordClaudeRuntimeProviderAccountUsageSnapshot } from './accountUsage.js';

describe('Claude runtime provider account usage recording', () => {
  it('passes connected-service source context when recording runtime usage evidence', async () => {
    const launchEnv = {
      CLAUDE_CONFIG_DIR: '/tmp/claude-connected-profile',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS: '[]',
    };
    const source = {
      serviceId: 'claude-subscription',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'claude-team',
      groupGeneration: 7,
    } as const;
    const resolveSourceContext = vi.fn(async () => source);
    const recordSnapshot = vi.fn(async (input: Readonly<{ snapshot: Readonly<{ recordId: string }> }>) => ({
      status: 'recorded' as const,
      recordId: input.snapshot.recordId,
    }));

    await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: {
        agentRuntime: {
          accountUsage: {
            resolveSourceContext,
            recordSnapshot,
          },
        },
        logger: { debug: vi.fn() },
      },
      evidence: {
        rate_limits: {
          five_hour: {
            utilization: 91,
            resets_at: '2026-02-16T00:00:00Z',
          },
        },
      },
      sessionId: 'happy-session-claude',
      launchEnv,
      observedAtMs: 1_768_000_000_000,
    });

    expect(resolveSourceContext).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      env: launchEnv,
    });
    expect(recordSnapshot).toHaveBeenCalledWith({
      sessionId: 'happy-session-claude',
      source,
      snapshot: expect.objectContaining({
        providerId: 'claude',
        source: 'runtimeSignal',
        state: 'loaded_data',
        meters: [expect.objectContaining({
          meterId: 'five_hour',
          utilizationPct: 91,
        })],
      }),
    });
  });
});
