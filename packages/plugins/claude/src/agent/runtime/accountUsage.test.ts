import { describe, expect, it, vi } from 'vitest';

import { recordClaudeRuntimeProviderAccountUsageSnapshot } from './accountUsage.js';

describe('Claude runtime provider account usage recording', () => {
  it('passes connected-service source context when recording runtime usage evidence', async () => {
    const accountConfig = JSON.stringify({
      oauthAccount: {
        accountUuid: 'live-claude-account',
        emailAddress: 'live@example.com',
      },
    });
    const launchEnv = {
      CLAUDE_CONFIG_DIR: '/host-owned/claude-home',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"serviceId":"claude-subscription"}]',
    };
    const source = {
      serviceId: 'claude-subscription',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'claude-team',
    } as const;
    const resolveSourceContext = vi.fn(async () => source);
    const recordSnapshot = vi.fn(async () => ({
      status: 'recorded' as const,
    }));

    await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: {
        agentRuntime: {
          nativeHome: {
            readFiles: vi.fn(async () => ({
              '.claude.json': new TextEncoder().encode(accountConfig),
            })),
          },
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
      env: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"serviceId":"claude-subscription"}]',
      },
    });
    expect(recordSnapshot).toHaveBeenCalledWith({
      sessionId: 'happy-session-claude',
      source: {
        serviceId: 'claude-subscription',
        env: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"serviceId":"claude-subscription"}]',
        },
      },
      snapshot: expect.objectContaining({
        providerId: 'claude',
        accountSubject: {
          kind: 'providerSubject',
          id: 'live-claude-account',
        },
        accountLabel: 'live@example.com',
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
