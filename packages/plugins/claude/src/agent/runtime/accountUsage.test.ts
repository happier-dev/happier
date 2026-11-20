import { describe, expect, it, vi } from 'vitest';
import { computeConnectedAccountAccessTokenFingerprint } from '@happier-dev/plugin-sdk/connected-accounts';

import { createClaudeRuntimeAuthIdentity } from '../auth/services/runtime/requestIdentity.js';
import { recordClaudeRuntimeProviderAccountUsageSnapshot } from './accountUsage.js';
import { buildClaudeRuntimeIssue } from './issues/runtimeIssues.js';
import { CLAUDE_RUNTIME_RATE_LIMITS_STALE_AFTER_MS } from '../auth/services/usage/snapshot.js';

describe('Claude runtime provider account usage recording', () => {
  it.each(['native', 'managed'] as const)('keeps issued %s account evidence on its original subject after native credentials change', async kind => {
    let currentAccount = 'account-a';
    const encoder = new TextEncoder();
    const nativeHome = { async readFiles() { return {
      '.claude.json': encoder.encode(JSON.stringify({ oauthAccount: {
        accountUuid: currentAccount, organizationUuid: `org-${currentAccount}`, emailAddress: `${currentAccount}@example.com`,
      } })),
      '.credentials.json': encoder.encode(JSON.stringify({ claudeAiOauth: {
        accessToken: `token-${currentAccount}`, scopes: ['user:inference'],
      } })),
    }; } };
    const launchEnv: Record<string, string> = kind === 'managed' ? { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"serviceId":"claude-subscription"}]' } : {};
    const observations: unknown[] = [];
    const logger = { debug() {}, warn() {} };
    const runtimeAuthIdentity = createClaudeRuntimeAuthIdentity({ launchEnv, nativeHome, logger });
    const ctx = { agentRuntime: { nativeHome, accountUsage: {
      async resolveSourceContext() { return { serviceId: 'claude-subscription' as const, profileId: currentAccount, bindingKind: 'profile' as const }; },
      async recordSnapshot(input: unknown) { observations.push(input); return { status: 'recorded' as const }; },
    } }, logger };
    const record = (evidence: unknown) => recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx, runtimeAuthIdentity, launchEnv, evidence, sessionId: 'switched-account-quota',
    });
    await runtimeAuthIdentity.captureRequest();
    await record({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 1 }, seven_day: { utilization: 0.2 } },
    } });
    currentAccount = 'account-b';
    await record({ type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit',
      providerLimitId: 'five_hour', utilization: 95 });
    expect(observations).toHaveLength(2);
    for (const observation of observations) expect(observation).toMatchObject({
      snapshot: { accountSubject: { kind: 'providerSubject', id: 'account-a' }, accountLabel: 'account-a@example.com' },
      credentialProof: { providerAccountId: 'account-a', credentialFingerprint: computeConnectedAccountAccessTokenFingerprint('token-account-a') },
    });
    expect(observations[1]).toMatchObject({ snapshot: { meters: [
      { meterId: 'five_hour', utilizationPct: 100 }, { meterId: 'seven_day', utilizationPct: 20 },
    ] } });
    await runtimeAuthIdentity.captureRequest();
    await record({ type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 429, apiError: 'usage_limit_reached',
      error: 'rate_limit', providerLimitId: 'five_hour', utilization: 80 });
    expect(observations.at(-1)).toMatchObject({
      snapshot: { accountSubject: { kind: 'providerSubject', id: 'account-b' } }, credentialProof: { providerAccountId: 'account-b', credentialFingerprint: computeConnectedAccountAccessTokenFingerprint('token-account-b') },
    });
    if (kind === 'native') expect(runtimeAuthIdentity.readFailure(Date.now())).toBeNull();
  });

  it('does not manufacture a quota snapshot or exhausted issue from a generic 429', async () => {
    const evidence = { type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit', utilization: 100 };
    const snapshots: unknown[] = [];
    await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx: { agentRuntime: { accountUsage: {
        async recordSnapshot(input) { snapshots.push(input.snapshot); return { status: 'recorded' }; },
      } }, logger: { debug() {}, warn() {} } },
      evidence, sessionId: 'generic-quota-category',
    });
    expect(buildClaudeRuntimeIssue({ evidence, occurredAt: 100 })).toMatchObject({
      source: 'agent_status_error', usageLimit: { limitCategory: 'rate_limit', quotaScope: 'unknown', utilization: null },
    });
    expect(snapshots).toEqual([]);
  });

  it('keeps equal SDK revalidation fresh beyond the runtime snapshot stale interval', async () => {
    const snapshots: unknown[] = [];
    const logger = { debug() {}, warn() {} };
    const runtimeAuthIdentity = createClaudeRuntimeAuthIdentity({ launchEnv: {}, logger });
    await runtimeAuthIdentity.captureRequest();
    const ctx = { agentRuntime: { accountUsage: {
      async recordSnapshot(input: { snapshot: unknown }) { snapshots.push(input.snapshot); return { status: 'recorded' as const }; },
    } }, logger };
    const evidence = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.2 } },
    } };
    const revalidatedAtMs = 1_790_378_000_000 + CLAUDE_RUNTIME_RATE_LIMITS_STALE_AFTER_MS + 1;
    for (const observedAtMs of [1_790_378_000_000, revalidatedAtMs]) await recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx, runtimeAuthIdentity, evidence, observedAtMs, sessionId: 'unchanged-provider-revalidation',
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ fetchedAtMs: revalidatedAtMs, observedAtMs: revalidatedAtMs,
      meters: [{ meterId: 'five_hour', utilizationPct: 40 }, { meterId: 'seven_day', utilizationPct: 20 }],
    });
  });

  it('qualifies only changed request quota facts from statusline arrivals', async () => {
    const readFiles = vi.fn(async () => ({}));
    const resolveSourceContext = vi.fn(async () => null);
    const snapshots: unknown[] = [];
    const logger = { debug() {}, warn() {} };
    const runtimeAuthIdentity = createClaudeRuntimeAuthIdentity({ launchEnv: {}, nativeHome: { readFiles }, logger });
    const ctx = { agentRuntime: { nativeHome: { readFiles }, accountUsage: { resolveSourceContext,
      async recordSnapshot(input: { snapshot: unknown }) { snapshots.push(input.snapshot); return { status: 'recorded' as const }; },
    } }, logger };
    const record = (evidence: unknown) => recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx, sessionId: 'statusline-cost', runtimeAuthIdentity, evidence,
    });
    await runtimeAuthIdentity.captureRequest();
    readFiles.mockClear();
    await record({ model: { id: 'model-before' } });
    expect(readFiles).not.toHaveBeenCalled();
    const rate_limits = { five_hour: { used_percentage: 100 }, seven_day: { used_percentage: 20, resets_at: 1_790_378_500 } };
    await record({ rate_limits, model: { id: 'model-before' } });
    await record({ rate_limits, model: { id: 'model-after' } });
    await record({ rate_limits, context_window: { used_percentage: 75 } });
    await record({ rate_limits: { seven_day: rate_limits.seven_day, five_hour: rate_limits.five_hour } });
    expect(readFiles).not.toHaveBeenCalled();
    expect(resolveSourceContext).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ meters: [
      { meterId: 'five_hour', utilizationPct: 100 }, { meterId: 'seven_day', utilizationPct: 20 },
    ] });
    await record({ rate_limits: { ...rate_limits, seven_day: { used_percentage: 20, resets_at: 1_790_378_600 } } });
    expect(readFiles).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toMatchObject({ meters: [expect.anything(), { meterId: 'seven_day', resetAtMs: 1_790_378_600_000 }] });
    await runtimeAuthIdentity.captureRequest();
    readFiles.mockClear();
    await record({ rate_limits });
    expect(readFiles).not.toHaveBeenCalled();
    expect(resolveSourceContext).toHaveBeenCalledTimes(3);
    expect(snapshots).toHaveLength(3);
  });

  it('keeps measured windows and credits when a sidechain emits one rejected window', async () => {
    const snapshots: unknown[] = [];
    const logger = { debug() {}, warn() {} };
    const runtimeAuthIdentity = createClaudeRuntimeAuthIdentity({ launchEnv: {}, logger });
    const ctx = { agentRuntime: { accountUsage: {
      async recordSnapshot(input: { snapshot: unknown }) { snapshots.push(input.snapshot); return { status: 'recorded' as const }; },
    } }, logger };
    const record = (evidence: unknown) => recordClaudeRuntimeProviderAccountUsageSnapshot({
      ctx, sessionId: 'sidechain-quota', runtimeAuthIdentity, evidence,
    });
    await runtimeAuthIdentity.captureRequest();
    await record({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'allowed',
      rateLimitType: 'five_hour', unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: 1_790_378_400 }, seven_day: { utilization: 0.2, resetsAt: 1_790_378_500 },
      } } });
    await record({ type: 'rate_limit_event', parent_tool_use_id: 'quota-child',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 0.95 } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ meters: [
      { meterId: 'five_hour', utilizationPct: 100, resetAtMs: 1_790_378_400_000 },
      { meterId: 'seven_day', utilizationPct: 20, resetAtMs: 1_790_378_500_000 },
      { meterId: 'extra_usage', unit: 'credits', isExhausted: false },
    ] });
  });

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
