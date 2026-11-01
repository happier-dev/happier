import type { notifyDaemonConnectedServiceRuntimeAuthFailure, notifyDaemonConnectedServiceQuotaSnapshot } from '@/daemon/controlClient';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
  CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS,
  resetConnectedServiceRuntimeAuthFailureReportDedupeForTests,
} from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '@/daemon/connectedServices/accountUsage/fromConnectedServiceQuotaObservation';
import { canRecordProviderAccountUsageSourceLinks } from '@/daemon/connectedServices/accountUsage/record';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from '@/daemon/connectedServices/quotas/recordConnectedServiceRuntimeQuotaSnapshotForSession';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '@/daemon/connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { resolveConnectedServiceGroupMemberByProviderAccountId } from '@/daemon/connectedServices/shared/resolveConnectedServiceGroupMemberByProviderAccountId';
import { readClaudeMaterializedOAuthAccountIdentity } from './resolveClaudeRuntimeProviderAccountIdentity';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import type { FailTurnInput } from '@/agent/runtime/session/turn/types';
import { createClaudeUnifiedHookLifecycleBridge } from '../unifiedTerminal/createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedInputArbiter } from '../unifiedTerminal/createClaudeUnifiedInputArbiter';
import type { SessionHookData } from '../utils/startHookServer';

import {
  recordClaudeRateLimitQuotaEvidence,
  surfaceClaudeRuntimeAuthFailure,
  surfaceClaudeRateLimitRuntimeIssue,
} from './surfaceClaudeRuntimeIssues';

const mockNotifyDaemonConnectedServiceRuntimeAuthFailure = vi.hoisted(() => vi.fn<(input: Parameters<typeof notifyDaemonConnectedServiceRuntimeAuthFailure>[0]) => Promise<unknown>>(async () => ({})));
const mockNotifyDaemonConnectedServiceQuotaSnapshot = vi.hoisted(() => vi.fn<(input: Parameters<typeof notifyDaemonConnectedServiceQuotaSnapshot>[0]) => Promise<unknown>>(async () => ({ ok: true })));
vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: mockNotifyDaemonConnectedServiceRuntimeAuthFailure,
  notifyDaemonConnectedServiceQuotaSnapshot: mockNotifyDaemonConnectedServiceQuotaSnapshot,
}));

type ClaudeFailTurn = (params: FailTurnInput) => Promise<void>;

function createClaudeFailTurnSpy() {
  return vi.fn<ClaudeFailTurn>(async () => undefined);
}

async function awaitBeforeDurableTurnWrite<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('recovery remained blocked by the durable turn write')),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function createScheduledRuntimeAuthRecoveryReport(input: Readonly<{ includeTranscriptEvent?: boolean }> = {}) {
  const diagnostic = {
    code: 'recovery_retry_scheduled',
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: 'claude-subscription',
    profileId: 'claude-main',
    groupId: 'team-pool',
    retryable: true,
    suggestedActions: [],
    diagnostics: { runtimeFailureKind: 'usage_limit' },
  };
  const transcriptEvent = {
    type: 'connected-service-runtime-auth-recovery',
    status: 'retry_scheduled',
    serviceId: 'claude-subscription',
    profileId: 'claude-main',
    groupId: 'team-pool',
    nextRetryAtMs: 1_700_000_100_000,
    terminal: false,
    diagnostic,
  };
  return {
    ok: true,
    result: {
      status: 'recovery_retry_scheduled',
      recovery: {
        status: 'scheduled',
        retryable: true,
        nextRetryAtMs: 1_700_000_100_000,
      },
      uxDiagnostic: diagnostic,
      ...(input.includeTranscriptEvent === false ? {} : { transcriptEvent }),
    },
  };
}

function installClaudeSelectionEnv(): string | undefined {
  const previous = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
    kind: 'group',
    serviceId: 'claude-subscription',
    groupId: 'team-pool',
    activeProfileId: 'claude-main',
    fallbackProfileId: 'claude-backup',
    generation: 4,
    credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
  }]);
  return previous;
}

function restoreClaudeSelectionEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    return;
  }
  process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previous;
}

describe('surfaceClaudeRuntimeIssues runtime-auth projection', () => {
  it('reports duplicate Claude observers once and a fresh begun turn again', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const mutations: SessionTurnMutationV1[] = [];
    let sequence = 0;
    const lifecycle = createSessionTurnLifecycle({
      sessionId: 'claude-observer-occurrences', createId: () => String(++sequence),
      enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
    });
    const session = { client: { sessionId: 'claude-observer-occurrences', sessionTurnLifecycle: lifecycle } };
    const details = {
      v: 1 as const, resetAtMs: null, retryAfterMs: null, limitCategory: 'usage_limit' as const,
      quotaScope: 'account' as const, recoverability: 'wait' as const, planType: null,
      utilization: null, overage: null, action: null, connectedService: null,
    };
    try {
      await lifecycle.beginTurn({ provider: 'claude' });
      await surfaceClaudeRateLimitRuntimeIssue(session, details, '[test]');
      await surfaceClaudeRateLimitRuntimeIssue(session, details, '[test]');
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(1);
      await lifecycle.beginTurn({ provider: 'claude' });
      await surfaceClaudeRateLimitRuntimeIssue(session, details, '[test]');
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(2);
      const fingerprints = mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mock.calls.map(([input]) => sanitizeConnectedServiceRuntimeFailureClassification(input.classification)?.runtimeIssueFingerprint);
      expect(fingerprints[0]).toEqual(expect.any(String));
      expect(fingerprints[1]).not.toBe(fingerprints[0]);
      expect(mutations.filter((mutation) => mutation.action === 'fail')).toHaveLength(2);
    } finally { restoreClaudeSelectionEnv(previousSelectionEnv); }
  });

  it('publishes a primary rejection after the previous turn completed', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
      sessionId: 'idle-primary-rejection',
      enqueueSessionTurn: async (mutation) => { mutations.push(mutation); },
    });
    try {
      await lifecycle.beginTurn({ provider: 'claude' });
      await lifecycle.completeTurn();
      await surfaceClaudeRateLimitRuntimeIssue({ client: {
        sessionId: 'idle-primary-rejection', sessionTurnLifecycle: lifecycle,
      } }, {
        v: 1, resetAtMs: null, retryAfterMs: null, limitCategory: 'usage_limit',
        quotaScope: 'account', recoverability: 'wait', planType: null,
        utilization: null, overage: null, action: null, connectedService: null,
      }, '[test]');
      expect(mutations.at(-1)).toMatchObject({ action: 'fail', issue: { source: 'usage_limit' } });
      expect(lifecycle.hasActiveTurn()).toBe(false);
    } finally { restoreClaudeSelectionEnv(previousSelectionEnv); }
  });
  afterEach(() => {
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockReset();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue({});
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockReset();
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValue({ ok: true });
    // The shared daemon-report path dedupes on stable identity; tests reuse session ids and
    // classifications across cases, so the window must not leak between tests.
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });

  it('keeps sidechain-sourced usage-limit evidence out of turn failure and recovery while still recording quota evidence (FIX-3)', async () => {
    // Incident Jun-11 H-B (trigger half): a SUBAGENT api-error row imported into the parent
    // stream must not fail the parent turn nor produce a runtime-auth failure report. The
    // limit is still real account-level signal, so the quota snapshot is still recorded.
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_sidechain',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: 1_781_221_200_000,
        retryAfterMs: null,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'five_hour',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
        sourcedFromSidechain: true,
      }, '[claude-test]');

      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_sidechain',
        serviceId: 'claude-subscription',
        snapshot: expect.objectContaining({
          profileId: 'claude-main',
          meters: [expect.objectContaining({
            meterId: 'five_hour',
            resetAtMs: 1_781_221_200_000,
          })],
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('records passive allowed-warning Claude utilization as quota evidence without failing the turn', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await recordClaudeRateLimitQuotaEvidence({
        client: {
          sessionId: 'sess_claude_passive_quota',
          sessionTurnLifecycle: { failTurn },
        },
      } as any, [{
        v: 1,
        resetAtMs: 1_779_097_200_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'seven_day',
        planType: null,
        utilization: 92,
        overage: null,
        action: null,
        connectedService: null,
      }], '[claude-test]');

      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_passive_quota',
        serviceId: 'claude-subscription',
        groupId: 'team-pool',
        groupGeneration: 4,
        snapshot: expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'claude-main',
          source: 'in_band_provider_snapshot',
          confidence: 'exact',
          evidence: expect.objectContaining({
            kind: 'claude_runtime_quota_utilization',
            providerLimitId: 'seven_day',
          }),
          meters: [expect.objectContaining({
            meterId: 'seven_day',
            utilizationPct: 92,
            remainingPct: 8,
            resetAtMs: 1_779_097_200_000,
            source: 'in_band_provider_snapshot',
          })],
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('records every passive Claude quota window as a labelled meter of one snapshot', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const passiveWindow = {
      v: 1 as const,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'wait' as const,
      planType: null,
      overage: null,
      action: null,
      connectedService: null,
    };
    try {
      await recordClaudeRateLimitQuotaEvidence({
        client: { sessionId: 'sess_claude_passive_windows' },
      } as any, [
        { ...passiveWindow, providerLimitId: 'five_hour', utilization: 5, resetAtMs: 1_790_378_400_000 },
        { ...passiveWindow, providerLimitId: 'seven_day', utilization: 7, resetAtMs: 1_790_928_000_000 },
      ], '[claude-test]');

      // The account-usage store replaces a record wholesale, so both windows must travel together.
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledTimes(1);
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_passive_windows',
        snapshot: expect.objectContaining({
          confidence: 'exact',
          meters: [
            expect.objectContaining({
              meterId: 'five_hour',
              label: '5-hour',
              utilizationPct: 5,
              remainingPct: 95,
              resetAtMs: 1_790_378_400_000,
            }),
            expect.objectContaining({
              meterId: 'seven_day',
              label: 'Weekly',
              utilizationPct: 7,
              remainingPct: 93,
              resetAtMs: 1_790_928_000_000,
            }),
          ],
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it.each([null, 95])('keeps measured rejected and other windows even with top-level usage %s', async (utilization) => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const window = {
      v: 1 as const,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'wait' as const,
      planType: null,
      overage: null,
      action: null,
      connectedService: null,
    };
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: { sessionId: 'sess_claude_rejected_windows', sessionTurnLifecycle: { failTurn: createClaudeFailTurnSpy() } },
      } as any, {
        ...window,
        limitCategory: 'usage_limit',
        providerLimitId: 'five_hour',
        utilization,
        resetAtMs: 1_790_378_400_000,
      }, '[claude-test]', {
        // What the same event reported for every window, the rejected one included.
        observedWindows: [
          { ...window, providerLimitId: 'five_hour', utilization: 100, resetAtMs: 1_790_378_400_000 },
          { ...window, providerLimitId: 'seven_day', utilization: 42, resetAtMs: 1_790_928_000_000 },
        ],
      });

      // Reaching one limit must not drop the other window from the account's usage.
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_rejected_windows',
        snapshot: expect.objectContaining({
          evidence: expect.objectContaining({ providerLimitId: 'five_hour' }),
          meters: [
            expect.objectContaining({ meterId: 'five_hour', utilizationPct: 100 }),
            expect.objectContaining({ meterId: 'seven_day', utilizationPct: 42 }),
          ],
        }),
      }));
    } finally {
      if (previousSelectionEnv === undefined) delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      else process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
    }
  });

  it('threads source provider account identity into passive Claude quota evidence delivery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await recordClaudeRateLimitQuotaEvidence({
        client: {
          sessionId: 'sess_claude_passive_identity',
          sessionTurnLifecycle: { failTurn },
        },
      } as any, [{
        v: 1,
        resetAtMs: 1_779_097_200_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'seven_day',
        planType: null,
        utilization: 92,
        overage: null,
        action: null,
        connectedService: null,
        sourceProviderAccountId: 'acct_claude_live',
      }], '[claude-test]');

      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_passive_identity',
        serviceId: 'claude-subscription',
        sourceProviderAccountId: 'acct_claude_live',
        snapshot: expect.objectContaining({
          profileId: 'claude-main',
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('keeps sidechain-sourced transient 401 auth evidence out of turn failure and recovery (incident cmq8y3nlx)', async () => {
    // Incident 2026-06-12 cmq8y3nlx: a SUBAGENT transcript row (`isSidechain: true`) carrying
    // "Please run /login · API Error: 401 Invalid authentication credentials" was classified as
    // a session-level auth failure, the daemon armed reactive runtime-auth recovery and
    // restarted (SIGTERMed) the healthy parent session. Subagent-scoped evidence must never
    // fail the parent turn nor produce a runtime-auth failure report.
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_sidechain_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isSidechain: true,
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(false);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('keeps SDK-stream subagent (parent_tool_use_id) 401 auth evidence out of turn failure and recovery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_subagent_sdk_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        parent_tool_use_id: 'toolu_01TkTXvAj9C6X7TJSKmxH2jX',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(false);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('routes definitive sidechain OAuth revocation to Connected Services without failing the parent turn', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport(),
    );
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_sidechain_revoked',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isSidechain: true,
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 OAuth access token has been revoked.' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('settles parent-scoped 401 failure before asking Connected Services to recover it', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockImplementationOnce(async () => {
      expect(failTurn).toHaveBeenCalledOnce();
      return createScheduledRuntimeAuthRecoveryReport();
    });
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_parent_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({ source: 'auth_error' }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
        classification: expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'claude-main',
          groupId: 'team-pool',
          groupGeneration: 4,
          credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
        }),
      }), expect.objectContaining({ timeoutMs: CONNECTED_SERVICE_RUNTIME_AUTH_FAILURE_REPORT_TIMEOUT_MS }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('does not let a stalled durable turn write block parent-scoped 401 recovery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    let releaseTurnWrite!: () => void;
    const failTurn = vi.fn<ClaudeFailTurn>(() => new Promise<void>((resolve) => {
      releaseTurnWrite = resolve;
    }));
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport(),
    );
    try {
      const surfaced = surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_stalled_turn_write_auth',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn },
        },
      }, {
        type: 'assistant',
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 OAuth access token has been revoked.' }],
        },
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledOnce();
      await expect(awaitBeforeDurableTurnWrite(surfaced)).resolves.toBe(true);
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    } finally {
      releaseTurnWrite?.();
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it.each([false, true])('marks rejected primary quota delivery as evidence-only without changing sidechain eligibility (sidechain=%s)', async sidechain => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({ client: { sessionId: `claude-policy-source-${sidechain}` } }, {
        v: 1, resetAtMs: Date.now() + 60_000, retryAfterMs: null, limitCategory: 'usage_limit',
        quotaScope: 'account', recoverability: 'switch_account', providerLimitId: 'five_hour',
        planType: null, utilization: 100, overage: null, action: null, connectedService: null,
        sourceProviderAccountId: 'policy-account', sourceProviderOrganizationId: 'policy-org',
        ...(sidechain ? { sourcedFromSidechain: true } : {}),
      }, '[test]');
      const delivered = mockNotifyDaemonConnectedServiceQuotaSnapshot.mock.calls[0]?.[0];
      expect(delivered).toMatchObject({ sourceProviderAccountId: 'policy-account', groupId: 'team-pool',
        snapshot: { activeAccountId: 'policy-account', providerOrganizationId: 'policy-org', profileId: 'claude-main' } });
      if (sidechain) expect(delivered).not.toHaveProperty('policyDisposition');
      else expect(delivered).toHaveProperty('policyDisposition', 'evidence_only');
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledTimes(sidechain ? 0 : 1);
    } finally { restoreClaudeSelectionEnv(previousSelectionEnv); }
  });

  it('retains failed quota delivery for retry and reports it on the default file log', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    const diagnostic = vi.spyOn(logger, 'warnFile').mockImplementation(() => {});
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValueOnce({ ok: false, errorCode: 'quota_transport_unavailable' });
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValue({ ok: true });
    try {
      await recordClaudeRateLimitQuotaEvidence({ client: { sessionId: 'quota-background-retry' } }, [{
        v: 1, resetAtMs: Date.now() + 60_000, retryAfterMs: null, quotaScope: 'account',
        recoverability: 'wait', providerLimitId: 'five_hour', planType: null, utilization: 95,
        overage: null, action: null, connectedService: null,
        sourceProviderAccountId: 'retry-account', sourceProviderOrganizationId: 'retry-org',
      }], '[test]');
      await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        event: 'quota_snapshot_delivery_retrying', sessionId: 'quota-background-retry', attemptCount: 1,
      })));
      // The outbox's existing retry cadence, not a new report queue, owns redelivery.
      await vi.waitFor(() => expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      // Drain the real timer before restoring the shared transport boundary.
      await vi.waitFor(() => expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      diagnostic.mockRestore();
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it.each([false, true])('releases unified terminal Pending delivery while quota HTTP is held (earlier sidechain quota=%s)', async passiveFirst => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    let releaseQuota!: () => void;
    const quotaHeld = new Promise<void>(resolve => { releaseQuota = resolve; });
    let quotaSettled = false;
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockImplementation(async () => {
      await quotaHeld;
      quotaSettled = true;
      return { ok: true };
    });
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValue(createScheduledRuntimeAuthRecoveryReport());
    const injected: string[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: `unified-quota-held-${passiveFirst}`,
      enqueueSessionTurn: async () => {},
    });
    const session = { client: { sessionId: `unified-quota-held-${passiveFirst}`, sessionTurnLifecycle: lifecycle } };
    const arbiter = createClaudeUnifiedInputArbiter({ quietPeriodMs: 0,
      injectPrompt: async batch => { injected.push(batch.message); return { status: 'injected', at: Date.now(), bytesWritten: batch.message.length }; },
    });
    let hook: ((data: SessionHookData) => void) | undefined;
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: callback => { hook = callback; return () => { hook = undefined; }; },
      arbiter, completionQuiescenceMs: 0,
      onUsageLimitDetails: details => surfaceClaudeRateLimitRuntimeIssue(session, details, '[test]'),
      onQuotaEvidence: windows => recordClaudeRateLimitQuotaEvidence(session, windows, '[test]'),
    });
    try {
      await lifecycle.beginTurn({ provider: 'claude' });
      bridge.start({ abortSignal: new AbortController().signal });
      if (!hook) throw new Error('Expected hook transport subscription');
      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'provider-quota-test' });
      await arbiter.enqueueUiMessage({ message: 'continue after recovery', origin: { kind: 'ui_pending' } });
      expect(injected).toEqual([]);
      if (passiveFirst) bridge.observeTranscript({ type: 'assistant', uuid: 'quota-sidechain-observation',
        isSidechain: true, isApiErrorMessage: true, apiErrorStatus: 429,
        error: 'rate_limit_error', message: { content: [{ type: 'text', text: 'Usage limit reached' }] },
      });
      hook({ hook_event_name: 'StopFailure', session_id: 'provider-quota-test', error: 'rate_limit' });
      await vi.waitFor(() => {
        expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalled();
        expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
        expect(arbiter.snapshot().turnState).toBe('idle');
        expect(injected).toEqual(['continue after recovery']);
      });
      expect(quotaSettled).toBe(false);
      expect(lifecycle.hasActiveTurn()).toBe(false);
    } finally {
      releaseQuota();
      await vi.waitFor(() => expect(quotaSettled).toBe(true));
      bridge.dispose();
      await arbiter.dispose();
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('admits durable usage-limit recovery without waiting for best-effort quota delivery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    let releaseQuota!: () => void;
    const quotaDelivery = new Promise<void>(resolve => { releaseQuota = resolve; });
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockImplementationOnce(async () => {
      await quotaDelivery;
      return { ok: true };
    });
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: 'quota-delivery-held-recovery',
      enqueueSessionTurn: async mutation => { mutations.push(mutation); },
    });
    let settled = false;
    let surfaced: Promise<void> | undefined;
    try {
      await lifecycle.beginTurn({ provider: 'claude' });
      surfaced = surfaceClaudeRateLimitRuntimeIssue({ client: {
        sessionId: 'quota-delivery-held-recovery', sessionTurnLifecycle: lifecycle, sendSessionEvent: vi.fn(),
      } }, {
        v: 1, resetAtMs: 1_781_221_200_000, retryAfterMs: null, limitCategory: 'usage_limit',
        quotaScope: 'account', recoverability: 'switch_account', providerLimitId: 'five_hour',
        planType: null, utilization: 100, overage: null, action: null, connectedService: null,
        sourceProviderAccountId: 'provider-account-current', sourceProviderOrganizationId: 'provider-org-current',
      }, '[claude-test]');
      void surfaced.then(() => { settled = true; });
      await vi.waitFor(() => {
        expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledOnce();
        expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
      });
      expect(mutations.at(-1)).toMatchObject({ action: 'fail', issue: { source: 'usage_limit' } });
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mock.calls[0]?.[0]).toMatchObject({
        classification: { kind: 'usage_limit', profileId: 'claude-main', groupId: 'team-pool',
          sourceProviderAccountId: 'provider-account-current', sourceProviderOrganizationId: 'provider-org-current',
          runtimeIssueFingerprint: expect.any(String) },
      });
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot.mock.calls[0]?.[0]).toMatchObject({
        groupId: 'team-pool', groupGeneration: 4, sourceProviderAccountId: 'provider-account-current',
        snapshot: { profileId: 'claude-main' },
      });
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      releaseQuota();
      await surfaced;
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
    expect(settled).toBe(true);
  });

  it('does not let a stalled durable turn write block connected-service usage-limit recovery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    let releaseTurnWrite!: () => void;
    const failTurn = vi.fn<ClaudeFailTurn>(() => new Promise<void>((resolve) => {
      releaseTurnWrite = resolve;
    }));
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport(),
    );
    try {
      const surfaced = surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_stalled_turn_write_limit',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn },
        },
      }, {
        v: 1,
        resetAtMs: 1_781_221_200_000,
        retryAfterMs: null,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'five_hour',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledOnce();
      await expect(awaitBeforeDurableTurnWrite(surfaced)).resolves.toBeUndefined();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledOnce();
    } finally {
      releaseTurnWrite?.();
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces parent-scoped 401 evidence when connected-service recovery requires user action', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'claude-subscription',
          profileId: 'claude-main',
        },
      },
    });
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_parent_auth_action_required',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'assistant',
        isApiErrorMessage: true,
        apiErrorStatus: 401,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Please run /login · API Error: 401 Invalid authentication credentials' }],
        },
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({ source: 'auth_error' }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('lets Claude SDK provider-owned native 401 retries continue without surfacing an auth failure', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_native_oauth_provider_retrying',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'system',
        subtype: 'api_error',
        attempt: 1,
        max_retries: 11,
        retry_delay_ms: 1_000,
        error_status: 401,
        error: 'Connection error.',
      }, '[claude-test]');

      expect(surfaced).toBe(false);
      expect(failTurn).not.toHaveBeenCalled();
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces native Claude OAuth SDK 401 evidence without connected-service recovery', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      const surfaced = await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_native_oauth_auth',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        type: 'system',
        subtype: 'api_error',
        attempt: 11,
        max_retries: 11,
        retry_delay_ms: 1_000,
        error_status: 401,
        error: 'Connection error.',
      }, '[claude-test]');

      expect(surfaced).toBe(true);
      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'auth_error',
          source: 'auth_error',
          provider: 'claude',
        }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('does not re-emit daemon typed runtime-auth recovery projection for retryable Claude auth recovery', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, { status: 401, message: 'OAuth token has expired' }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({ source: 'auth_error' }),
      }));
      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('does not re-emit daemon typed runtime-auth recovery projection for Claude usage-limit issues', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn: vi.fn(async () => {}) },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'daily_tokens',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(sendSessionEvent).not.toHaveBeenCalled();
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('records in-band quota evidence for the selected member alongside connected-service recovery', async () => {
    // RD-QUO-2: group-bound Claude sessions must feed live in-band rate-limit evidence into the
    // canonical quota snapshot store (mirroring Codex), not only into runtime-auth recovery.
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_selected_snapshot',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn: vi.fn(async () => {}) },
        },
      } as any, {
        v: 1,
        resetAtMs: 1_768_100_000_000,
        retryAfterMs: null,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'five_hour',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_selected_snapshot',
        serviceId: 'claude-subscription',
        groupId: 'team-pool',
        groupGeneration: 4,
        snapshot: expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'claude-main',
          source: 'runtime_event',
          meters: [expect.objectContaining({
            meterId: 'five_hour',
            resetAtMs: 1_768_100_000_000,
          })],
        }),
      }));
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess_claude_selected_snapshot',
          classification: expect.objectContaining({
            groupId: 'team-pool',
            groupGeneration: 4,
          }),
        }),
        expect.anything(),
      );
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('reports quota against the latest hot-applied group truth instead of immutable launch selection', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        connectedServiceAuthGroupRequestFence: {
          readCurrentTruth: () => ({
            kind: 'current_auth_group_available' as const,
            groupId: 'team-pool',
            generation: 5,
            credentialRevision: 'csr_8123456789ABCDEFGHJKMNPQRS' as const,
          }),
        },
        client: {
          sessionId: 'sess_claude_hot_applied_snapshot',
          getMetadataSnapshot: () => ({
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team-pool',
                  profileId: 'claude-next',
                },
              },
            },
          }),
          sessionTurnLifecycle: { failTurn: vi.fn(async () => {}) },
        },
      }, {
        v: 1,
        resetAtMs: 1_768_100_000_000,
        retryAfterMs: null,
        limitCategory: 'usage_limit',
        quotaScope: 'account',
        recoverability: 'switch_account',
        providerLimitId: 'five_hour',
        planType: null,
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess_claude_hot_applied_snapshot',
          classification: expect.objectContaining({
            profileId: 'claude-next',
            groupId: 'team-pool',
            groupGeneration: 5,
            credentialRevision: 'csr_8123456789ABCDEFGHJKMNPQRS',
          }),
        }),
        expect.anything(),
      );
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces temporary provider throttles outside usage-limit issue fields', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_temporary_throttle',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: 1_250,
        limitCategory: 'rate_limit',
        quotaScope: 'provider',
        recoverability: 'wait',
        providerLimitId: 'transient',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        allocateWhenIdle: true,
        issue: expect.objectContaining({
          code: 'provider_temporary_throttle',
          source: 'provider_status_error',
          provider: 'claude',
          temporaryThrottle: {
            v: 1,
            retryAfterMs: 1_250,
            recoverability: 'retry',
          },
        }),
      }));
      const issue = (failTurn.mock.calls[0]?.[0] as { issue?: Record<string, unknown> } | undefined)?.issue;
      expect(issue).not.toHaveProperty('usageLimit');
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('surfaces provider capacity as a provider status issue with structured limit details', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_claude_capacity',
          sendSessionEvent: vi.fn(),
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: 2_000,
        limitCategory: 'capacity',
        quotaScope: 'provider',
        recoverability: 'wait',
        providerLimitId: 'server_overloaded',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        allocateWhenIdle: true,
        issue: expect.objectContaining({
          code: 'provider_status_error',
          source: 'provider_status_error',
          provider: 'claude',
          sanitizedPreview: 'Provider reported an error',
          usageLimit: expect.objectContaining({
            limitCategory: 'capacity',
            providerLimitId: 'server_overloaded',
            retryAfterMs: 2_000,
          }),
        }),
      }));
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('records native Claude usage-limit evidence without connected-service recovery when no connected selection exists', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/happier-claude-native-home';
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_native_claude',
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: 1_700_000_000_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'daily_tokens',
        planType: 'max',
        utilization: 100,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        allocateWhenIdle: true,
        issue: expect.objectContaining({
          code: 'usage_limit',
          usageLimit: expect.objectContaining({
            providerLimitId: 'daily_tokens',
            effectiveMeterId: 'daily_tokens',
            effectiveRemainingPct: 0,
            allWindows: [
              expect.objectContaining({
                meterId: 'daily_tokens',
                remainingPct: 0,
                resetAtMs: 1_700_000_000_000,
                status: 'ok',
              }),
            ],
            connectedService: {
              serviceId: 'claude-subscription',
              profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
              groupId: null,
            },
          }),
        }),
      }));
      expect(mockNotifyDaemonConnectedServiceQuotaSnapshot).toHaveBeenCalledWith({
        sessionId: 'sess_native_claude',
        serviceId: 'claude-subscription',
        policyDisposition: 'evidence_only',
        snapshot: expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: expect.stringMatching(/^native:[a-f0-9]{48}$/u),
          providerId: 'claude',
          planLabel: 'max',
          meters: [
            expect.objectContaining({
              meterId: 'daily_tokens',
              utilizationPct: 100,
              resetsAt: 1_700_000_000_000,
            }),
          ],
        }),
      });
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('surfaces native Claude temporary throttles without connected-service recovery when no connected selection exists', async () => {
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/happier-claude-native-throttle-home';
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRateLimitRuntimeIssue({
        client: {
          sessionId: 'sess_native_claude_throttle',
          sessionTurnLifecycle: { failTurn },
        },
      } as any, {
        v: 1,
        resetAtMs: null,
        retryAfterMs: 1_250,
        limitCategory: 'rate_limit',
        quotaScope: 'provider',
        recoverability: 'wait',
        providerLimitId: 'transient',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      }, '[claude-test]');

      expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        allocateWhenIdle: true,
        issue: expect.objectContaining({
          code: 'provider_temporary_throttle',
          source: 'provider_status_error',
          temporaryThrottle: {
            v: 1,
            retryAfterMs: 1_250,
            recoverability: 'retry',
          },
        }),
      }));
      const issue = (failTurn.mock.calls[0]?.[0] as { issue?: Record<string, unknown> } | undefined)?.issue;
      expect(issue).not.toHaveProperty('usageLimit');
      expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).not.toHaveBeenCalled();
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it('emits a generic recovery message when the daemon report has a typed diagnostic but no transcript event', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure.mockResolvedValueOnce(
      createScheduledRuntimeAuthRecoveryReport({ includeTranscriptEvent: false }),
    );
    const sendSessionEvent = vi.fn();
    const failTurn = createClaudeFailTurnSpy();
    try {
      await surfaceClaudeRuntimeAuthFailure({
        client: {
          sessionId: 'sess_claude_1',
          sendSessionEvent,
          sessionTurnLifecycle: { failTurn },
        },
      } as any, { status: 401, message: 'OAuth token has expired' }, '[claude-test]');

      expect(sendSessionEvent).toHaveBeenCalledWith({
        type: 'message',
        message: expect.stringContaining('retry scheduled'),
      });
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('leaves repeated daemon-handled group-recovery transcript projections to the daemon', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport())
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const client = {
      sessionId: 'sess_claude_dedupe',
      metadata: {} as Record<string, unknown>,
      metadataLock: {
        inLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
      },
      updateMetadata(this: any, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) {
        return this.metadataLock.inLock(async () => {
          this.metadata = updater(this.metadata);
        });
      },
      sendSessionEvent,
      sessionTurnLifecycle: { failTurn: vi.fn(async () => undefined) },
    };
    const details = {
      v: 1 as const,
      resetAtMs: 1_700_000_060_000,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'switch_account' as const,
      providerLimitId: 'daily_tokens',
      planType: null,
      utilization: 100,
      overage: null,
      action: null,
      connectedService: null,
    };
    try {
      await surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]');
      await surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]');

      expect(sendSessionEvent.mock.calls.filter(
        ([event]) => event?.type === 'connected-service-runtime-auth-recovery',
      )).toHaveLength(0);
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });

  it('leaves concurrent daemon-handled group-recovery transcript projections to the daemon', async () => {
    const previousSelectionEnv = installClaudeSelectionEnv();
    mockNotifyDaemonConnectedServiceRuntimeAuthFailure
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport())
      .mockResolvedValueOnce(createScheduledRuntimeAuthRecoveryReport());
    const sendSessionEvent = vi.fn();
    const client = {
      sessionId: 'sess_claude_dedupe_concurrent',
      metadata: {} as Record<string, unknown>,
      metadataLock: {
        inLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
      },
      updateMetadata(this: any, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) {
        return this.metadataLock.inLock(async () => {
          this.metadata = updater(this.metadata);
        });
      },
      sendSessionEvent,
      sessionTurnLifecycle: { failTurn: vi.fn(async () => undefined) },
    };
    const details = {
      v: 1 as const,
      resetAtMs: 1_700_000_060_000,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'switch_account' as const,
      providerLimitId: 'daily_tokens',
      planType: null,
      utilization: 100,
      overage: null,
      action: null,
      connectedService: null,
    };
    try {
      await Promise.all([
        surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]'),
        surfaceClaudeRateLimitRuntimeIssue({ client } as any, details, '[claude-test]'),
      ]);

      expect(sendSessionEvent.mock.calls.filter(
        ([event]) => event?.type === 'connected-service-runtime-auth-recovery',
      )).toHaveLength(0);
    } finally {
      restoreClaudeSelectionEnv(previousSelectionEnv);
    }
  });
});

describe('R3-4: Claude in-band evidence becomes source-backed → predictive soft-switch eligible', () => {
  // The rate_limit tap runs in the agent child process whose materialized CLAUDE_CONFIG_DIR
  // names the live account. The tap must resolve that real provider-account UUID and stamp it as
  // `sourceProviderAccountId` so the emitted quota evidence forms a PROVEN source link — the
  // precondition the predictive soft-switch policy requires (it fails closed on unproven evidence).
  let tmpDir: string;
  let previousSelectionEnv: string | undefined;
  let previousConfigDir: string | undefined;

  async function writeMaterializedClaudeConfig(oauthAccount: Record<string, unknown> | null): Promise<void> {
    const rootConfig = oauthAccount ? { oauthAccount } : {};
    await writeFile(join(tmpDir, '.claude.json'), JSON.stringify(rootConfig), 'utf8');
  }

  function installConfigDir(): void {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claude-r34-'));
    previousSelectionEnv = installClaudeSelectionEnv();
    installConfigDir();
  });

  afterEach(async () => {
    restoreClaudeSelectionEnv(previousSelectionEnv);
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockReset();
    mockNotifyDaemonConnectedServiceQuotaSnapshot.mockResolvedValue({ ok: true });
    await rm(tmpDir, { recursive: true, force: true });
  });

  function passiveUtilizationDetails() {
    return {
      v: 1 as const,
      resetAtMs: 1_779_097_200_000,
      retryAfterMs: null,
      quotaScope: 'account' as const,
      recoverability: 'wait' as const,
      providerLimitId: 'seven_day',
      planType: null,
      utilization: 92,
      overage: null,
      action: null,
      connectedService: null,
    };
  }

  function deliveredQuotaCall() {
    const calls = mockNotifyDaemonConnectedServiceQuotaSnapshot.mock.calls as readonly (readonly unknown[])[];
    const call = calls.at(-1)?.[0] as
      | { sourceProviderAccountId?: string; snapshot: import('@happier-dev/protocol').ConnectedServiceQuotaSnapshotV1 }
      | undefined;
    if (!call) throw new Error('expected a quota snapshot delivery');
    return call;
  }

  it('enriches passive quota evidence with the live account identity → source-linked PAU (soft-switch eligible)', async () => {
    await writeMaterializedClaudeConfig({ accountUuid: 'acct_live_uuid', emailAddress: 'pool@happier.dev', organizationUuid: 'org-pool' });

    await recordClaudeRateLimitQuotaEvidence({
      client: { sessionId: 'sess_r34_passive' },
    } as any, [passiveUtilizationDetails()], '[r34-test]');

    const call = deliveredQuotaCall();
    // 1. Real provider-account identity resolved from the materialized config and stamped.
    expect(call.sourceProviderAccountId).toBe('acct_live_uuid');

    // 2. Regression runs all the way to soft-switch eligibility: the delivered snapshot derives a
    // PROVEN (providerSubject) PAU whose source links survive the fail-closed proof guard.
    const pau = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: call.snapshot,
      sourceProviderAccountId: call.sourceProviderAccountId,
    });
    expect(pau.accountSubject.kind).toBe('providerSubject');
    expect(pau.recordKey.subjectKind).toBe('account');
    expect(canRecordProviderAccountUsageSourceLinks({
      snapshot: pau,
      sourceProviderAccountId: call.sourceProviderAccountId,
    })).toBe(true);
  });

  it('preserves burn history when repeated native Claude observations attest the same user and organization', async () => {
    await writeMaterializedClaudeConfig({ accountUuid: 'acct_live_uuid', organizationUuid: 'org-live' });
    const selection = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    if (!selection) throw new Error('Expected the connected-service selection fixture.');
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const firstAt = Date.now();
    const now = vi.spyOn(Date, 'now');
    try {
      for (const [index, utilization] of [10, 20].entries()) {
        now.mockReturnValue(firstAt + index * 1000);
        await recordClaudeRateLimitQuotaEvidence({ client: { sessionId: 'same-org-burn' } }, [{
          ...passiveUtilizationDetails(), resetAtMs: firstAt + 60_000, utilization,
        }], '[test]');
        const delivered = deliveredQuotaCall();
        await recordConnectedServiceRuntimeQuotaSnapshotForSession({
          getChildren: () => [{ startedBy: 'daemon', happySessionId: 'same-org-burn', pid: 123,
            spawnOptions: { directory: '/tmp/project', environmentVariables: {
              [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: selection,
            }, connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
              source: 'connected', selection: 'group', profileId: 'claude-main', groupId: 'team-pool',
            } } } },
          }],
          runtimeQuotaSnapshots, sessionId: 'same-org-burn', serviceId: 'claude-subscription',
          groupId: 'team-pool', groupGeneration: 4, sourceProviderAccountId: delivered.sourceProviderAccountId,
          snapshot: delivered.snapshot,
          resolveProviderQualifiedGroupSource: async (context) => {
            const profileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
              ...context, members: [{ profileId: 'claude-main' }],
              resolveProviderAccountIdentity: async () => readClaudeMaterializedOAuthAccountIdentity(tmpDir),
            });
            return profileId ? { profileId, groupGeneration: 4 } : null;
          },
        });
      }
      expect(runtimeQuotaSnapshots.getRecentBurn({ serviceId: 'claude-subscription', groupId: 'team-pool',
        profileId: 'claude-main', groupGeneration: 4, nowMs: firstAt + 1000, maxAgeMs: 60_000,
      })).toMatchObject({ remainingPercentPerMs: 0.01, remainingPercent: 80 });
      expect(deliveredQuotaCall().snapshot.activeAccountId).toBe('acct_live_uuid');
    } finally {
      now.mockRestore();
    }
  });

  it('stamps the live identity onto the rejected usage-limit snapshot too', async () => {
    await writeMaterializedClaudeConfig({ accountUuid: 'acct_live_uuid', organizationUuid: 'org-live' });
    const failTurn = createClaudeFailTurnSpy();

    await surfaceClaudeRateLimitRuntimeIssue({
      client: {
        sessionId: 'sess_r34_rejected',
        sessionTurnLifecycle: { failTurn },
      },
    } as any, {
      ...passiveUtilizationDetails(),
      limitCategory: 'usage_limit' as const,
      sourceProviderOrganizationId: 'org-live',
      utilization: 100,
    }, '[r34-test]');

    expect(deliveredQuotaCall().sourceProviderAccountId).toBe('acct_live_uuid');
    expect(deliveredQuotaCall().snapshot.providerOrganizationId).toBe('org-live');
    expect(failTurn.mock.calls[0]?.[0].issue?.usageLimit).not.toHaveProperty('sourceProviderOrganizationId');
    expect(mockNotifyDaemonConnectedServiceRuntimeAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_r34_rejected',
        classification: expect.objectContaining({
          sourceProviderAccountId: 'acct_live_uuid',
          sourceProviderOrganizationId: 'org-live',
        }),
      }),
      expect.anything(),
    );
  });

  it('fails closed when the materialized config has no oauth account (identity genuinely unknown)', async () => {
    await writeMaterializedClaudeConfig(null);

    await recordClaudeRateLimitQuotaEvidence({
      client: { sessionId: 'sess_r34_unproven' },
    } as any, [passiveUtilizationDetails()], '[r34-test]');

    const call = deliveredQuotaCall();
    expect(call.sourceProviderAccountId).toBeUndefined();
    // No proven identity ⇒ source links cannot form ⇒ predictive soft-switch stays fail-closed.
    const pau = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: call.snapshot,
      sourceProviderAccountId: call.sourceProviderAccountId,
    });
    expect(canRecordProviderAccountUsageSourceLinks({
      snapshot: pau,
      sourceProviderAccountId: call.sourceProviderAccountId,
    })).toBe(false);
  });

  it('does not overwrite an already-proven source identity supplied on the details', async () => {
    await writeMaterializedClaudeConfig({ accountUuid: 'acct_live_uuid' });

    await recordClaudeRateLimitQuotaEvidence({
      client: { sessionId: 'sess_r34_preset' },
    } as any, [{
      ...passiveUtilizationDetails(),
      sourceProviderAccountId: 'acct_supplied',
    }], '[r34-test]');

    expect(deliveredQuotaCall().sourceProviderAccountId).toBe('acct_supplied');
  });
});
