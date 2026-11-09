import { describe, expect, it, vi } from 'vitest';

import { recordClaudeRuntimeProviderAccountUsageSnapshot } from './accountUsage.js';

describe('Claude runtime provider account usage recording', () => {
  it('qualifies account evidence before background delivery without holding the runtime on the host acknowledgement', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const observations: unknown[] = [];
    const recording = recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: { agentRuntime: {
        nativeHome: { async readFiles() { return { '.claude.json': new TextEncoder().encode(JSON.stringify({
          oauthAccount: { accountUuid: 'qualified-user', organizationUuid: 'qualified-org' },
        })), '.credentials.json': new TextEncoder().encode(JSON.stringify({ claudeAiOauth: {
          accessToken: 'qualified-current-token', scopes: ['user:inference'],
        } })) }; } },
        accountUsage: {
          async resolveSourceContext() { return { serviceId: 'claude-subscription', profileId: 'work', bindingKind: 'profile' }; },
          async recordSnapshot(input) { observations.push(input); await held; return { status: 'recorded' }; },
        },
      }, logger: { debug() {}, warn() {} } },
      sessionId: 'qualified-usage', launchEnv: { CLAUDE_CONFIG_DIR: '/qualified/native/home' },
      evidence: { rate_limits: { five_hour: { utilization: 100 } } },
      policyDisposition: 'evidence_only',
    }).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]).toMatchObject({ policyDisposition: 'evidence_only',
        snapshot: { accountSubject: { kind: 'providerSubject', id: 'qualified-user' } },
        source: { serviceId: 'claude-subscription' },
        credentialProof: { providerAccountId: 'qualified-user', credentialFingerprint: expect.stringMatching(/^sha256:/) },
      });
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally { release(); await recording; }
  });

  it('makes unavailable background account-usage delivery observable through the warning boundary', async () => {
    const warn = vi.fn();
    await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: { agentRuntime: { accountUsage: { async recordSnapshot() { return { status: 'unavailable' }; } } },
        logger: { debug() {}, warn } },
      sessionId: 'unavailable-usage', evidence: { rate_limits: { five_hour: { utilization: 95 } } },
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), { status: 'unavailable', reason: null }));
  });

  it.each(['authentication_failed', 'Unexpected provider failure'])('does not turn non-quota StopFailure %s into account usage evidence', async error => {
    const recordSnapshot = vi.fn(async () => ({ status: 'recorded' as const }));
    await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: { agentRuntime: { accountUsage: { recordSnapshot } }, logger: { debug() {}, warn() {} } },
      sessionId: 'non-quota-failure',
      evidence: { hook_event_name: 'StopFailure', error },
      policyDisposition: 'evidence_only',
    });
    expect(recordSnapshot).not.toHaveBeenCalled();
  });

  it.each(['current', 'malformed', 'missing'])('keeps user-only native observations provisional with bounded %s local credential proof', async (credentialState) => {
    const observations: unknown[] = [];
    await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: { agentRuntime: {
        nativeHome: { async readFiles() { return { '.claude.json': new TextEncoder().encode(JSON.stringify({
          oauthAccount: { accountUuid: 'provider-user' },
        })), ...(credentialState === 'missing' ? {} : { '.credentials.json': new TextEncoder().encode(
          credentialState === 'current' ? JSON.stringify({ claudeAiOauth: { accessToken: 'native-current-access', scopes: ['user:inference'] } }) : '{invalid',
        ) }) }; } },
        accountUsage: {
          async resolveSourceContext() { return { serviceId: 'claude-subscription', profileId: 'work', bindingKind: 'profile' }; },
          async recordSnapshot(input) { observations.push(input); return { status: 'recorded' }; },
        },
      }, logger: { debug() {}, warn() {} } },
      sessionId: 'local-session', launchEnv: { CLAUDE_CONFIG_DIR: '/selected/native/home' },
      evidence: { rate_limits: { five_hour: { utilization: 100 } } },
    });
    expect(observations).toEqual([expect.objectContaining({ snapshot: expect.objectContaining({
      accountSubject: expect.objectContaining({ kind: 'provisionalLocalSubject' }), confidence: 'unknown',
    }) })]);
    if (credentialState === 'current') {
      expect(observations[0]).toHaveProperty('source', { serviceId: 'claude-subscription' });
      // Existing host fingerprint contract: first eight hex characters of SHA-256(accessToken).
      expect(observations[0]).toHaveProperty('credentialProof', {
        providerAccountId: 'provider-user', credentialFingerprint: 'sha256:32dc71ca',
      });
    } else {
      expect(observations[0]).not.toHaveProperty('source');
      expect(observations[0]).not.toHaveProperty('credentialProof');
    }
  });

  it.each(['allowed', 'rejected'])('records every %s SDK window through the qualified host usage service', async (status) => {
    const accountConfig = JSON.stringify({
      oauthAccount: {
        accountUuid: 'live-claude-account',
        organizationUuid: 'organization-a',
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
        logger: { debug: vi.fn(), warn: vi.fn() },
      },
      evidence: {
        type: 'rate_limit_event',
        rate_limit_info: { status, rateLimitType: 'five_hour', unifiedWindows: {
          five_hour: { utilization: 0.91, resetsAt: '2026-02-16T00:00:00Z' },
          seven_day: { utilization: 0.2 },
          seven_day_fable: { utilization: 0.61 },
        } },
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
        recordKey: { providerId: 'claude', accountSubjectId: 'live-claude-account', subjectKind: 'account', quotaScope: 'organization', quotaScopeId: 'organization-a' },
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
        }), expect.objectContaining({ meterId: 'seven_day', utilizationPct: 20 }),
        expect.objectContaining({ meterId: 'seven_day_fable', utilizationPct: 61 })],
      }),
    });
  });
});
