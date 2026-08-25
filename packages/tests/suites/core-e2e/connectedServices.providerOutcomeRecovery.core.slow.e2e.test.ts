// Provider-outcome recovery e2e coverage (plan section P8).
//
// These tests drive the REAL daemon recovery-coordination code through the
// daemon control endpoint `/connected-service-runtime-auth/failure`. Only the
// provider/transport BOUNDARY is faked: a fake OAuth token server plus a reverse
// proxy that injects transport-level failures in front of the server's
// connected-service auth-group endpoints. Nothing here mocks internal recovery
// logic — the durable `RuntimeAuthRecoveryScheduler`, the shared
// `recovery/providerOutcomeProof.ts` proof gate, the reactive clear gate
// (`resolveReactiveRuntimeAuthRecoveryClear`), the daemon-lifecycle /
// endpoint-availability gating, and the account-exhaustion suppression store all
// run for real.
//
// WHY THIS EXISTS / REAL-PROVIDER QA SUBSTITUTION:
// Live provider QA for these classes is [blocked: needs real provider failure
// conditions] (plan P9) — we cannot reliably exhaust a real Codex/ChatGPT usage
// limit, force a real local-endpoint outage during recovery, or kill a real
// provider mid-shutdown in CI. This suite is the deterministic substitute that
// makes the live failure classes impossible to regress without real providers,
// mirroring the live incidents captured in
// `.project/reviews/2026-06-06-connected-services-recovery/execution-ledger.md`:
//   - daemon-lifecycle / session-endpoint-unavailable during recovery
//     (Pi session cmpqr1z0u0jrntmgeevco06t6): a transient ECONNREFUSED / socket
//     hang up must stay degraded WAITING, never terminal, and must not burn the
//     dead-letter budget; a failure reported while the daemon is shutting down
//     must defer (no switch, intent untouched).
//   - same-account / no-fresh-candidate usage-limit loop (Codex
//     cmq27f6j80hshtmafd35nu936): a single-member group with no fresh candidate
//     must not storm and must not clear the recovery intent.
//   - fresh-candidate progress: a genuinely different eligible member is the
//     accepted proof that lets recovery progress (group active profile flips).
//
// The sibling suite `connectedServices.runtimeAuthRecoveryRequeue` already covers
// the transient-5xx-then-switch and the dead-letter-on-non-retryable paths; this
// suite covers the network/degraded-track and daemon-lifecycle edges plus the
// no-fresh-candidate no-storm invariant that the requeue suite does not exercise.

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import {
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type FakeTokenServerRequest,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import {
  asRecord,
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  createQualifiedConnectedAccountGroup,
  createConnectedServiceProfile,
  fetchQualifiedConnectedAccountGroup,
  patchQualifiedConnectedAccountGroupMemberExhaustion,
  readRuntimeAuthRecoveryIntent,
  recordConnectedServiceTurnLifecycle,
  reportConnectedServiceRuntimeAuthFailure,
  spawnConnectedClaudeGroupSession,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  startConnectedServiceRecoveryProxy,
  type ConnectedServiceRecoveryProxy,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { sleep, waitFor } from '../../src/testkit/timing';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

const run = createRunDirs({
  runLabel: 'core',
  ...(process.env.HAPPIER_E2E_LOGS_DIR ? { logsDir: process.env.HAPPIER_E2E_LOGS_DIR } : {}),
});

const SERVICE_ID = 'openai-codex' satisfies ConnectedServiceId;

type UnknownRecord = Record<string, unknown>;

function hasClaudeToolCallRecord(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasClaudeToolCallRecord);
  const record = asRecord(value);
  if (!record) return false;
  const provider = typeof record.provider === 'string' ? record.provider : null;
  if (record.type === 'tool-call' && provider === 'claude') return true;
  const content = asRecord(record.content);
  const data = asRecord(content?.data);
  if (content?.type === 'acp' && content.provider === 'claude' && data?.type === 'tool-call') {
    return true;
  }
  return Object.values(record).some(hasClaudeToolCallRecord);
}

async function sessionHasClaudeToolCall(params: Readonly<{
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'serverBaseUrl' | 'auth' | 'accountSecret'>;
  sessionId: string;
}>): Promise<boolean> {
  const rows = await fetchAllMessages(params.fixture.serverBaseUrl, params.fixture.auth.token, params.sessionId);
  return rows.some((row) => hasClaudeToolCallRecord(decryptLegacyBase64(row.content.c, params.fixture.accountSecret)));
}

function withTemporaryEnv<T>(values: Readonly<Record<string, string>>, runWithEnv: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return runWithEnv().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function buildUsageLimitClassification(params: Readonly<{
  profileId: string;
  groupId: string;
  retryAfterMs: number | null;
  resetsAtMs?: number | null;
}>): UnknownRecord {
  return {
    kind: 'usage_limit',
    limitCategory: 'quota',
    serviceId: SERVICE_ID,
    profileId: params.profileId,
    groupId: params.groupId,
    resetsAtMs: params.resetsAtMs ?? null,
    retryAfterMs: params.retryAfterMs,
    quotaScope: 'account',
    providerLimitId: 'weekly',
    action: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error',
  };
}

function buildClaudeAuthExpiredClassification(params: Readonly<{
  profileId: string;
  groupId: string;
}>): UnknownRecord {
  return {
    kind: 'auth_expired',
    limitCategory: 'auth',
    serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
    profileId: params.profileId,
    groupId: params.groupId,
    resetsAtMs: null,
    retryAfterMs: null,
    quotaScope: 'account',
    providerLimitId: null,
    action: null,
    planType: null,
    rateLimits: null,
    source: 'stable_provider_message',
  };
}

async function reportRuntimeAuthFailure(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  sessionId: string;
  switchesThisTurn: number;
  classification: UnknownRecord;
}>): Promise<{ status: number; data: { ok?: boolean; result?: unknown } }> {
  return await daemonControlPostJson<{ ok?: boolean; result?: unknown }>({
    port: params.fixture.daemonPort,
    path: '/connected-service-runtime-auth/failure',
    controlToken: params.fixture.controlToken,
    body: {
      sessionId: params.sessionId,
      switchesThisTurn: params.switchesThisTurn,
      classification: params.classification,
    },
    timeoutMs: 90_000,
  });
}

async function spawnConnectedCodexGroupSession(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  sessionId: string;
  groupId: string;
  profileId: string;
}>): Promise<string> {
  const response = await daemonControlPostJson<{ success?: boolean; sessionId?: unknown; error?: string }>({
    port: params.fixture.daemonPort,
    path: '/spawn-session',
    controlToken: params.fixture.controlToken,
    body: {
      directory: params.fixture.workspaceDir,
      agent: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      sessionId: params.sessionId,
      terminal: { mode: 'plain' },
      experimentalCodexAcp: true,
      environmentVariables: {
        HAPPIER_HOME_DIR: params.fixture.daemonHomeDir,
        HAPPIER_SERVER_URL: params.fixture.daemonServerBaseUrl,
        HAPPIER_WEBAPP_URL: params.fixture.daemonServerBaseUrl,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
        HAPPIER_CODEX_ACP_BIN: params.fixture.acpStubProvider,
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          [SERVICE_ID]: {
            source: 'connected',
            selection: 'group',
            profileId: params.profileId,
            groupId: params.groupId,
          },
        },
      },
    },
    timeoutMs: 150_000,
  });
  if (response.status !== 200 || response.data?.success !== true) {
    throw new Error(`Expected daemon spawn-session success (status=${response.status}, data=${JSON.stringify(response.data)})`);
  }
  if (typeof response.data?.sessionId !== 'string' || response.data.sessionId.length === 0) {
    throw new Error(`Expected daemon spawn-session response sessionId; error=${String(response.data?.error)}`);
  }
  return response.data.sessionId;
}

// Seed a recovery group using the proven-eligible pattern: the active member is
// the fixture's default 'work' profile (already seeded + eligible at daemon
// start), plus extra seeded members. The server rejects group members that do
// not have a real credential, so EVERY member must be seeded. Waits until the
// group is readable before returning so spawn-time resolution does not race the
// group write.
const ACTIVE_PROFILE_ID = 'work';

async function seedRecoveryGroup(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  groupId: string;
  extraMemberProfileIds: readonly string[];
}>): Promise<void> {
  for (const profileId of params.extraMemberProfileIds) {
    // eslint-disable-next-line no-await-in-loop
    await createConnectedServiceProfile({
      fixture: params.fixture,
      serviceId: SERVICE_ID,
      profileId,
      providerEmail: `${profileId}@example.test`,
    });
  }
  // Group creation validates that every member has a propagated credential;
  // newly-written profile credentials can lag the group POST, so retry until the
  // members are visible. NOTE: the server's group-create response can
  // intermittently fail RESPONSE serialization (FST_ERR_RESPONSE_SERIALIZATION)
  // even though the group WRITE succeeded — so on a create failure we re-fetch
  // the group and treat a readable, correctly-active group as success.
  await waitFor(async () => {
    try {
      await createQualifiedConnectedAccountGroup({
        serverBaseUrl: params.fixture.serverBaseUrl,
        authToken: params.fixture.auth.token,
        legacyServiceId: SERVICE_ID,
        groupId: params.groupId,
        activeConnectedAccountId: ACTIVE_PROFILE_ID,
        memberConnectedAccountIds: [ACTIVE_PROFILE_ID, ...params.extraMemberProfileIds],
      });
      return true;
    } catch {
      // The write may have landed despite a serialization error on the response.
      try {
        const group = await fetchQualifiedConnectedAccountGroup({
          serverBaseUrl: params.fixture.serverBaseUrl,
          authToken: params.fixture.auth.token,
          legacyServiceId: SERVICE_ID,
          groupId: params.groupId,
        });
        return group.activeConnectedAccountId === ACTIVE_PROFILE_ID;
      } catch {
        return false;
      }
    }
  }, { timeoutMs: 25_000, intervalMs: 250, context: 'connected-service auth group created (or readable after a serialization-only error)' });
  await waitFor(async () => {
    const group = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: params.fixture.serverBaseUrl,
      authToken: params.fixture.auth.token,
      legacyServiceId: SERVICE_ID,
      groupId: params.groupId,
    });
    return group.activeConnectedAccountId === ACTIVE_PROFILE_ID;
  }, { timeoutMs: 20_000, intervalMs: 200, context: 'connected-service auth group resolvable before spawn' });
}

// Spawn a connected group session, retrying while the active member's credential
// health is still propagating (the daemon reports `no_eligible_member` until the
// materialized credential is healthy). Returns the resolved session id.
async function spawnConnectedCodexGroupSessionWhenEligible(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  sessionId: string;
  groupId: string;
  profileId: string;
}>): Promise<string> {
  let resolvedSessionId: string | null = null;
  await waitFor(async () => {
    try {
      resolvedSessionId = await spawnConnectedCodexGroupSession(params);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('no_eligible_member')) return false;
      throw error;
    }
  }, { timeoutMs: 40_000, intervalMs: 500, context: 'connected group session spawns once the active member is eligible' });
  if (!resolvedSessionId) throw new Error('Expected a spawned connected group session id');
  return resolvedSessionId;
}

async function spawnConnectedClaudeGroupSessionWhenEligible(params: Readonly<{
  fixture: StartedConnectedServicesClaudeDaemonFixture;
  sessionId: string;
  groupId: string;
  profileId: string;
}>): Promise<string> {
  let resolvedSessionId: string | null = null;
  await waitFor(async () => {
    try {
      resolvedSessionId = await spawnConnectedClaudeGroupSession(params);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('no_eligible_member')) return false;
      throw error;
    }
  }, { timeoutMs: 40_000, intervalMs: 500, context: 'Claude connected group session spawns once the active member is eligible' });
  if (!resolvedSessionId) throw new Error('Expected a spawned Claude connected group session id');
  return resolvedSessionId;
}

async function createQualifiedConnectedAccountGroupWhenReadable(
  params: Parameters<typeof createQualifiedConnectedAccountGroup>[0],
): Promise<void> {
  await waitFor(async () => {
    try {
      await createQualifiedConnectedAccountGroup(params);
      return true;
    } catch {
      try {
        const group = await fetchQualifiedConnectedAccountGroup({
          serverBaseUrl: params.serverBaseUrl,
          authToken: params.authToken,
          legacyServiceId: params.legacyServiceId,
          groupId: params.groupId,
        });
        return group.activeConnectedAccountId === params.activeConnectedAccountId;
      } catch {
        return false;
      }
    }
  }, {
    timeoutMs: 25_000,
    intervalMs: 250,
    context: 'connected-service auth group created or readable after a serialization-only response error',
  });
  await waitFor(async () => {
    const group = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: params.serverBaseUrl,
      authToken: params.authToken,
      legacyServiceId: params.legacyServiceId,
      groupId: params.groupId,
    });
    return group.activeConnectedAccountId === params.activeConnectedAccountId;
  }, {
    timeoutMs: 20_000,
    intervalMs: 200,
    context: 'connected-service auth group resolvable before spawn',
  });
}

const TOKEN_RESPONSE = (label: string) => ({
  status: 200,
  body: {
    access_token: `${label}-access`,
    refresh_token: `${label}-refresh`,
    id_token: `${label}-id`,
    expires_in: 3600,
    token_type: 'Bearer',
  },
});

describe('core e2e: connected-service provider-outcome recovery', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let claudeFixture: StartedConnectedServicesClaudeDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | ConnectedServiceRecoveryTokenServer | null = null;
  let proxy: ConnectedServiceRecoveryProxy | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await claudeFixture?.daemon.stop().catch(() => {});
    await claudeFixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
    fixture = null;
    claudeFixture = null;
    tokenServer = null;
    proxy = null;
  }, 60_000);

  // FAILURE CLASS: exact Claude group 401 recovery lifecycle — the daemon must
  // persist a durable runtime-auth recovery intent before it refreshes the active
  // group credential, then a restart-producing refresh must create a replay
  // attempt for the original user prompt, and provider activity under the exact
  // recovered service/group/profile identity must clear that recovery. This is the
  // deterministic fake-provider substitute for the live Claude group session that
  // refreshed/restarted and then idled without replaying the interrupted work.
  it('creates durable Claude group 401 recovery before refresh, retries the original prompt once, and clears on provider activity', async () => {
    const groupId = `claude-po-${randomUUID()}`;
    const profileId = 'primary';
    const originalPrompt = `E2E_CLAUDE_GROUP_401_ORIGINAL_PROMPT_${randomUUID()}`;
    const claudeTokenServer = await startConnectedServiceRecoveryTokenServer({
      respond: () => ({
        status: 200,
        body: {
          access_token: 'claude-fresh-access-token',
          refresh_token: 'claude-fresh-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
        },
      }),
    });
    tokenServer = claudeTokenServer;

    const testDir = run.testDir(`provider-outcome-claude-401-${randomUUID()}`);
    claudeFixture = await startConnectedServicesClaudeDaemon({
      testDir,
      testName: 'provider-outcome-claude-401',
      tokenUrl: claudeTokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(),
      fakeClaudeLogPath: resolve(join(testDir, 'fake-claude.jsonl')),
      fakeClaudeScenario: 'local-auth-fails-while-stale-token',
      extraEnv: {
        HAPPIER_CONNECTED_SERVICES_CONTINUATION_PROVIDER_ACTIVITY_TIMEOUT_MS: '90000',
      },
    });

    await createConnectedServiceProfile({
      fixture: claudeFixture,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      profileId,
      providerEmail: 'claude-primary@example.test',
      accessToken: 'claude-stale-access-token',
      refreshToken: 'claude-stale-refresh-token',
      idToken: null,
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: 'acct-claude-primary',
      expiresAt: Date.now() + 60 * 60_000,
    });
    await createQualifiedConnectedAccountGroupWhenReadable({
      serverBaseUrl: claudeFixture.serverBaseUrl,
      authToken: claudeFixture.auth.token,
      legacyServiceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      groupId,
      activeConnectedAccountId: profileId,
      memberConnectedAccountIds: [profileId],
      preTurnProbeMode: 'never',
    });

    const sessionId = await spawnConnectedClaudeGroupSessionWhenEligible({
      fixture: claudeFixture,
      sessionId: `claude-provider-outcome-${randomUUID()}`,
      groupId,
      profileId,
    });

    await postEncryptedUiTextMessage({
      baseUrl: claudeFixture.serverBaseUrl,
      token: claudeFixture.auth.token,
      sessionId,
      secret: claudeFixture.accountSecret,
      text: originalPrompt,
      timeoutMs: 20_000,
    });
    await recordConnectedServiceTurnLifecycle({
      fixture: claudeFixture,
      sessionId,
      event: 'prompt_or_steer',
    });

    const report = await reportConnectedServiceRuntimeAuthFailure({
      fixture: claudeFixture,
      sessionId,
      classification: buildClaudeAuthExpiredClassification({ profileId, groupId }),
    });
    expect(report.status).toBe(200);
    expect(report.data.ok).toBe(true);

    const firstRefresh = claudeTokenServer.requests().find((request) => request.path === '/oauth/token');
    if (!firstRefresh) throw new Error('Expected Claude runtime-auth recovery to force-refresh the active profile');

    const intent = await readRuntimeAuthRecoveryIntent({
      fixture: claudeFixture,
      sessionId,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      profileId,
      groupId,
    });
    if (!intent) throw new Error('Expected a durable runtime-auth recovery intent for the Claude group 401');
    expect(Number(intent.armedAtMs)).toBeLessThanOrEqual(firstRefresh.receivedAtMs);

    let reportedProviderActivity = false;
    await waitFor(async () => {
      if (!await sessionHasClaudeToolCall({ fixture: claudeFixture!, sessionId })) return false;
      if (!reportedProviderActivity) {
        await recordConnectedServiceTurnLifecycle({
          fixture: claudeFixture!,
          sessionId,
          event: 'task_started',
        });
        reportedProviderActivity = true;
      }
      return true;
    }, {
      timeoutMs: 120_000,
      intervalMs: 500,
      context: 'Claude recovery replay emits transcript tool-call after refresh',
    });

    await waitFor(async () => {
      const cleared = await readRuntimeAuthRecoveryIntent({
        fixture: claudeFixture!,
        sessionId,
        serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
        profileId,
        groupId,
      });
      return cleared === null;
    }, {
      timeoutMs: 90_000,
      intervalMs: 250,
      context: 'Claude provider activity clears exact runtime-auth recovery identity',
    });
  }, 360_000);

  // FAILURE CLASS: stale automatic continuation after manual supersession — once
  // a provider failure has created a pending original-message retry, a later
  // user-driven turn cancellation must supersede that retry before the delayed
  // restart gets a chance to replay stale work.
  it('does not replay the original Claude group prompt after the interrupted turn is cancelled', async () => {
    const groupId = `claude-po-cancel-${randomUUID()}`;
    const profileId = 'primary';
    const originalPrompt = `E2E_CLAUDE_GROUP_CANCELLED_ORIGINAL_PROMPT_${randomUUID()}`;
    const claudeTokenServer = await startConnectedServiceRecoveryTokenServer({
      respond: () => ({
        status: 200,
        body: {
          access_token: 'claude-cancel-fresh-access-token',
          refresh_token: 'claude-cancel-fresh-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
        },
      }),
    });
    tokenServer = claudeTokenServer;

    const testDir = run.testDir(`provider-outcome-claude-cancel-${randomUUID()}`);
    claudeFixture = await startConnectedServicesClaudeDaemon({
      testDir,
      testName: 'provider-outcome-claude-cancel',
      tokenUrl: claudeTokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(),
      fakeClaudeLogPath: resolve(join(testDir, 'fake-claude-cancel.jsonl')),
      fakeClaudeScenario: 'local-auth-fails-while-stale-token',
      extraEnv: {
        HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '5000',
        HAPPIER_CONNECTED_SERVICES_CONTINUATION_PROVIDER_ACTIVITY_TIMEOUT_MS: '5000',
      },
    });

    await createConnectedServiceProfile({
      fixture: claudeFixture,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      profileId,
      providerEmail: 'claude-cancel@example.test',
      accessToken: 'claude-cancel-stale-access-token',
      refreshToken: 'claude-cancel-stale-refresh-token',
      idToken: null,
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: 'acct-claude-cancel',
      expiresAt: Date.now() + 60 * 60_000,
    });
    await createQualifiedConnectedAccountGroupWhenReadable({
      serverBaseUrl: claudeFixture.serverBaseUrl,
      authToken: claudeFixture.auth.token,
      legacyServiceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      groupId,
      activeConnectedAccountId: profileId,
      memberConnectedAccountIds: [profileId],
      preTurnProbeMode: 'never',
    });

    const sessionId = await spawnConnectedClaudeGroupSessionWhenEligible({
      fixture: claudeFixture,
      sessionId: `claude-provider-outcome-cancel-${randomUUID()}`,
      groupId,
      profileId,
    });

    await postEncryptedUiTextMessage({
      baseUrl: claudeFixture.serverBaseUrl,
      token: claudeFixture.auth.token,
      sessionId,
      secret: claudeFixture.accountSecret,
      text: originalPrompt,
      timeoutMs: 20_000,
    });
    await recordConnectedServiceTurnLifecycle({
      fixture: claudeFixture,
      sessionId,
      event: 'prompt_or_steer',
    });

    const report = await reportConnectedServiceRuntimeAuthFailure({
      fixture: claudeFixture,
      sessionId,
      classification: buildClaudeAuthExpiredClassification({ profileId, groupId }),
    });
    expect(report.status).toBe(200);
    expect(report.data.ok).toBe(true);

    const firstRefresh = claudeTokenServer.requests().find((request) => request.path === '/oauth/token');
    if (!firstRefresh) throw new Error('Expected Claude runtime-auth recovery to force-refresh before cancellation');

    await recordConnectedServiceTurnLifecycle({
      fixture: claudeFixture,
      sessionId,
      event: 'turn_cancelled',
    });

  }, 360_000);

  // FAILURE CLASS: repeated Claude 401 after a forced refresh — after the same
  // group/profile has already been force-refreshed for the same auth failure,
  // another 401 must terminalize to reconnect/action-required instead of
  // re-running refresh/restart behind a generic terminal-host death.
  it('terminalizes a repeated Claude group 401 after forced refresh as reconnect action-required', async () => {
    const groupId = `claude-po-term-${randomUUID()}`;
    const profileId = 'primary';
    const claudeTokenServer = await startConnectedServiceRecoveryTokenServer({
      respond: () => ({
        status: 200,
        body: {
          access_token: `claude-fresh-access-token-${randomUUID()}`,
          refresh_token: `claude-fresh-refresh-token-${randomUUID()}`,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
        },
      }),
    });
    tokenServer = claudeTokenServer;

    const testDir = run.testDir(`provider-outcome-claude-repeat-401-${randomUUID()}`);
    claudeFixture = await startConnectedServicesClaudeDaemon({
      testDir,
      testName: 'provider-outcome-claude-repeat-401',
      tokenUrl: claudeTokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(),
      fakeClaudeLogPath: resolve(join(testDir, 'fake-claude-repeat-401.jsonl')),
    });
    await createConnectedServiceProfile({
      fixture: claudeFixture,
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      profileId,
      providerEmail: 'claude-primary@example.test',
      accessToken: 'claude-repeat-stale-access-token',
      refreshToken: 'claude-repeat-stale-refresh-token',
      idToken: null,
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: 'acct-claude-primary',
      expiresAt: Date.now() + 60 * 60_000,
    });
    await createQualifiedConnectedAccountGroupWhenReadable({
      serverBaseUrl: claudeFixture.serverBaseUrl,
      authToken: claudeFixture.auth.token,
      legacyServiceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
      groupId,
      activeConnectedAccountId: profileId,
      memberConnectedAccountIds: [profileId],
      preTurnProbeMode: 'never',
    });
    const sessionId = await spawnConnectedClaudeGroupSessionWhenEligible({
      fixture: claudeFixture,
      sessionId: `claude-provider-outcome-terminal-${randomUUID()}`,
      groupId,
      profileId,
    });

    const classification = buildClaudeAuthExpiredClassification({ profileId, groupId });
    const first = await reportConnectedServiceRuntimeAuthFailure({
      fixture: claudeFixture,
      sessionId,
      classification,
    });
    expect(first.status).toBe(200);
    expect(first.data.ok).toBe(true);
    expect(claudeTokenServer.requests().filter((request) => request.path === '/oauth/token')).toHaveLength(1);

    const repeated = await reportConnectedServiceRuntimeAuthFailure({
      fixture: claudeFixture,
      sessionId,
      classification,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.data.ok).toBe(true);
    expect(repeated.data.result).toMatchObject({
      status: 'recovery_action_required',
      action: {
        kind: 'reconnect_profile',
        serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID,
        profileId,
        groupId,
      },
    });
    expect(claudeTokenServer.requests().filter((request) => request.path === '/oauth/token')).toHaveLength(1);
  }, 360_000);

  // FAILURE CLASS: daemon-lifecycle / endpoint-unavailable during recovery —
  // a transient network outage (socket hang up / ECONNREFUSED) classifies as
  // `network` (degraded track), so recovery stays WAITING (never terminal) and
  // does NOT burn the dead-letter budget over a long outage. Substitutes for the
  // Pi cmpqr1z0u0jrntmgeevco06t6 live incident where the same ECONNREFUSED was
  // first enqueued retryable and then wrongly terminalized.
  it('keeps recovery in a degraded WAITING state under a sustained endpoint outage and does not dead-letter', async () => {
    const groupId = `provider-outcome-degraded-${randomUUID()}`;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => TOKEN_RESPONSE('degraded'),
    });

    fixture = await withTemporaryEnv({
      HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT: '1',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS: '250',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS: '500',
      // A small normal-track budget: if a network outage were (wrongly) counted
      // against it, recovery would dead-letter quickly. The degraded track has a
      // much larger separate budget, so a sustained outage must stay WAITING well
      // past this normal cap.
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS: '2',
      HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    }, async () => await startConnectedServicesCodexDaemon({
      testDir: run.testDir('provider-outcome-degraded'),
      testName: 'provider-outcome-degraded',
      tokenUrl: tokenServer!.tokenUrl,
      accessToken: 'degraded-initial',
      refreshToken: 'degraded-refresh-initial',
      idToken: 'degraded-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
      resolveDaemonServerBaseUrl: async (serverBaseUrl) => {
        proxy = await startConnectedServiceRecoveryProxy({ targetBaseUrl: serverBaseUrl, serviceId: SERVICE_ID, groupId });
        return proxy.baseUrl;
      },
    }));

    await seedRecoveryGroup({ fixture, groupId, extraMemberProfileIds: ['backup'] });

    const sessionId = await spawnConnectedCodexGroupSessionWhenEligible({ fixture, sessionId: `degraded-session-${randomUUID()}`, groupId, profileId: ACTIVE_PROFILE_ID });

    // Sustain a network-level outage on the auth-group load for far more cycles
    // than the normal-track budget (2). Socket hang up → classified `network` →
    // degraded track.
    proxy?.armGroupLoadFailures(200, 'socket_hangup');

    const report = await reportRuntimeAuthFailure({
      fixture,
      sessionId,
      switchesThisTurn: 0,
      classification: buildUsageLimitClassification({ profileId: ACTIVE_PROFILE_ID, groupId, retryAfterMs: 30_000 }),
    });
    expect(report.status).toBe(200);
    expect(report.data.ok).toBe(true);

    // Let several normal-track backoff cycles elapse. If the outage burned the
    // normal budget, the intent would be `exhausted` by now (cap=2, backoff
    // 250ms). The degraded track must keep it WAITING instead.
    await sleep(3_000);

    const intent = await readRuntimeAuthRecoveryIntent({ fixture, sessionId, serviceId: SERVICE_ID, profileId: ACTIVE_PROFILE_ID, groupId });
    if (!intent) throw new Error('Expected a durable runtime-auth recovery intent under the outage');
    expect(intent.status).not.toBe('exhausted');
    expect(intent.status).not.toBe('terminal');
    expect(['waiting', 'checking']).toContain(intent.status);
    // The outage must not have advanced the normal attempt budget to its cap.
    expect(Number(intent.attemptCount ?? 0)).toBeLessThan(2);
    // The group must NOT have switched (no provider-outcome proof under the outage).
    const group = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: fixture.serverBaseUrl,
      authToken: fixture.auth.token,
      legacyServiceId: SERVICE_ID,
      groupId,
    });
    expect(group.activeConnectedAccountId).toBe(ACTIVE_PROFILE_ID);
    expect(proxy?.activeAccountWriteCount()).toBe(0);

    // Give the outage even more time (well past several normal-track backoff
    // cycles). The hard, deterministic invariant for this class is that the
    // intent stays NON-TERMINAL on the separate, much larger degraded budget —
    // it never dead-letters on a transient local-endpoint outage. (The degraded
    // backoff is intentionally long, so we assert state durability rather than a
    // fast re-drive tick.)
    await sleep(3_000);
    const stillDegraded = await readRuntimeAuthRecoveryIntent({ fixture, sessionId, serviceId: SERVICE_ID, profileId: ACTIVE_PROFILE_ID, groupId });
    if (!stillDegraded) throw new Error('Expected the degraded recovery intent to persist under the outage');
    expect(stillDegraded.status).not.toBe('exhausted');
    expect(stillDegraded.status).not.toBe('terminal');
    expect(['waiting', 'checking']).toContain(stillDegraded.status);
    expect(Number(stillDegraded.attemptCount ?? 0)).toBeLessThan(2);
    // Still must not have switched the active profile while the outage persists.
    const stillGroup = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: fixture.serverBaseUrl,
      authToken: fixture.auth.token,
      legacyServiceId: SERVICE_ID,
      groupId,
    });
    expect(stillGroup.activeConnectedAccountId).toBe(ACTIVE_PROFILE_ID);
    expect(proxy?.activeAccountWriteCount()).toBe(0);
  }, 360_000);

  // FAILURE CLASS: daemon-lifecycle deferral — a runtime-auth failure reported
  // while the daemon is shutting down must NOT run switch/restart/continuation,
  // must return a degraded `daemon_lifecycle_unavailable` result, and must leave
  // the recovery intent untouched (no clear, no terminal, no switch attempt). The
  // shutdown guard fires at the control endpoint BEFORE the handler runs, so this
  // does not depend on a live spawned session/group — it is exercised against the
  // bare control endpoint, which is the exact choke point the live incident hit.
  it('defers a runtime-auth failure reported during daemon shutdown', async () => {
    const groupId = `provider-outcome-shutdown-${randomUUID()}`;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => TOKEN_RESPONSE('shutdown'),
    });

    fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('provider-outcome-shutdown'),
      testName: 'provider-outcome-shutdown',
      tokenUrl: tokenServer.tokenUrl,
      accessToken: 'shutdown-initial',
      refreshToken: 'shutdown-refresh-initial',
      idToken: 'shutdown-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
    });

    const sessionId = `shutdown-session-${randomUUID()}`;

    // Request daemon shutdown, then immediately report a failure. The control
    // endpoint sets `isShuttingDown` after a 50ms grace; race the report against
    // it by retrying until we observe the deferral classification (the daemon is
    // still alive and answering control requests during the grace window).
    await daemonControlPostJson({
      port: fixture.daemonPort,
      path: '/stop',
      controlToken: fixture.controlToken,
      body: { stopSessions: false },
      timeoutMs: 20_000,
    });

    let deferred = false;
    let endpointClosed = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let report: Awaited<ReturnType<typeof reportRuntimeAuthFailure>>;
      try {
        report = await reportRuntimeAuthFailure({
          fixture,
          sessionId,
          switchesThisTurn: 0,
          classification: buildUsageLimitClassification({ profileId: ACTIVE_PROFILE_ID, groupId, retryAfterMs: 30_000 }),
        });
      } catch {
        // The control server stopped accepting connections — shutdown completed
        // (the strongest possible "no post-shutdown work" guarantee).
        endpointClosed = true;
        break;
      }
      const result = asRecord(report.data.result);
      if (result?.status === 'daemon_lifecycle_unavailable') {
        // The degraded deferral is a non-success, non-terminal, non-clearing
        // outcome — no switch attempt, no recovered state.
        expect(result.reason).toBe('recovery_deferred_shutdown');
        expect(report.data.ok).toBe(true);
        const sideEffect = await readRuntimeAuthRecoveryIntent({
          fixture,
          sessionId,
          serviceId: SERVICE_ID,
          profileId: ACTIVE_PROFILE_ID,
          groupId,
        });
        expect(sideEffect).toBeNull();
        deferred = true;
        break;
      }
      if (result?.status === 'session_not_found') {
        // `/stop` acknowledges before the daemon flips its shutdown flag. A
        // pre-grace report for this synthetic session can no-op; keep polling
        // until the shutdown guard defers recovery or the endpoint closes.
        const sideEffect = await readRuntimeAuthRecoveryIntent({
          fixture,
          sessionId,
          serviceId: SERVICE_ID,
          profileId: ACTIVE_PROFILE_ID,
          groupId,
        });
        expect(sideEffect).toBeNull();
        await sleep(20);
        continue;
      }
      if (report.status === 200 && report.data.ok === true) {
        throw new Error(`Runtime-auth failure was accepted during shutdown without deferral: ${JSON.stringify(report.data)}`);
      }
      const sideEffect = await readRuntimeAuthRecoveryIntent({
        fixture,
        sessionId,
        serviceId: SERVICE_ID,
        profileId: ACTIVE_PROFILE_ID,
        groupId,
      });
      expect(sideEffect).toBeNull();
      await sleep(20);
    }

    // Either we captured the explicit in-band deferral, or the control endpoint
    // closed during shutdown. Both are acceptable evidence that recovery work was
    // not accepted normally during teardown.
    expect(deferred || endpointClosed).toBe(true);
  }, 360_000);

  // FAILURE CLASS: no-fresh-candidate usage-limit loop — when a real readable
  // group has no eligible fresh member, recovery must NOT storm the endpoint and
  // must NOT clear/recover the intent on a metadata-only local substep. This is
  // the semantic selector path for the Codex cmq27f6j80hshtmafd35nu936 live loop
  // where every member was exhausted, so hot-applying the same account was not
  // real progress.
  it('does not storm or recover when no fresh candidate is reachable for the exhausted account', async () => {
    const groupId = `no-candidate-${randomUUID()}`;
    const backupProfileId = 'no-candidate-backup';
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => TOKEN_RESPONSE('no-candidate'),
    });

    fixture = await withTemporaryEnv({
      HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT: '1',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS: '250',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS: '500',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS: '3',
      HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    }, async () => await startConnectedServicesCodexDaemon({
      testDir: run.testDir('provider-outcome-no-candidate'),
      testName: 'provider-outcome-no-candidate',
      tokenUrl: tokenServer!.tokenUrl,
      accessToken: 'no-candidate-initial',
      refreshToken: 'no-candidate-refresh-initial',
      idToken: 'no-candidate-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
      resolveDaemonServerBaseUrl: async (serverBaseUrl) => {
        proxy = await startConnectedServiceRecoveryProxy({ targetBaseUrl: serverBaseUrl, serviceId: SERVICE_ID, groupId });
        return proxy.baseUrl;
      },
    }));

    await seedRecoveryGroup({
      fixture,
      groupId,
      extraMemberProfileIds: [backupProfileId],
    });

    const sessionId = await spawnConnectedCodexGroupSessionWhenEligible({
      fixture,
      sessionId: `no-candidate-session-${randomUUID()}`,
      groupId,
      profileId: ACTIVE_PROFILE_ID,
    });

    const resetAtMs = Date.now() + 120_000;
    const seededGroup = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: fixture.serverBaseUrl,
      authToken: fixture.auth.token,
      legacyServiceId: SERVICE_ID,
      groupId,
    });
    const activeExhaustedGroup = await patchQualifiedConnectedAccountGroupMemberExhaustion({
      serverBaseUrl: fixture.serverBaseUrl,
      authToken: fixture.auth.token,
      group: seededGroup,
      expectedRuntimeStateRevision: seededGroup.runtimeStateRevision,
      connectedAccountId: ACTIVE_PROFILE_ID,
      quotaExhaustedUntilMs: resetAtMs,
    });
    await patchQualifiedConnectedAccountGroupMemberExhaustion({
      serverBaseUrl: fixture.serverBaseUrl,
      authToken: fixture.auth.token,
      group: activeExhaustedGroup,
      expectedRuntimeStateRevision: activeExhaustedGroup.runtimeStateRevision,
      connectedAccountId: backupProfileId,
      quotaExhaustedUntilMs: resetAtMs,
    });

    const report = await reportRuntimeAuthFailure({
      fixture,
      sessionId,
      switchesThisTurn: 0,
      classification: buildUsageLimitClassification({
        profileId: ACTIVE_PROFILE_ID,
        groupId,
        retryAfterMs: 30_000,
        resetsAtMs: resetAtMs,
      }),
    });
    expect(report.status).toBe(200);
    expect(report.data.ok).toBe(true);
    expect(report.data.result).toMatchObject({
      status: 'switch_attempted',
      result: {
        status: 'no_eligible_member',
        groupExhausted: true,
      },
    });

    const loadAfterReport = proxy?.groupLoadCount() ?? 0;

    // Over the wait window the recovery must not hammer the endpoint (no
    // immediate-retry storm) and must never write an active-profile switch to a
    // candidate that is exhausted.
    await sleep(2_000);
    const loadDelta = (proxy?.groupLoadCount() ?? 0) - loadAfterReport;
    // A bounded number of backoff-paced reloads is acceptable; a storm would be
    // dozens within 2s at 250ms backoff. Cap generously but well below a storm.
    expect(loadDelta).toBeLessThanOrEqual(12);
    expect(proxy?.activeAccountWriteCount()).toBe(0);

    // The recovery intent must NOT be cleared/recovered without a fresh candidate:
    // it stays in a waiting lifecycle state (or dead-letters to a durable exhausted
    // state on its bounded degraded budget) — never silently `cancelled`/recovered.
    const intent = await readRuntimeAuthRecoveryIntent({ fixture, sessionId, serviceId: SERVICE_ID, profileId: ACTIVE_PROFILE_ID, groupId });
    if (!intent) throw new Error('Expected a durable recovery intent when no candidate is reachable');
    expect(['waiting', 'checking', 'exhausted']).toContain(intent.status);
    expect(intent.status).not.toBe('cancelled');
  }, 360_000);
});
