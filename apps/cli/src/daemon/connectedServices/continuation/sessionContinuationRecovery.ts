import { createHash } from 'node:crypto';

import {
  SESSION_CONTINUATION_RECOVERY_METADATA_KEY,
  SessionContinuationRecoveryV1Schema,
  type SessionContinuationRecoveryAttemptV1,
  type SessionContinuationRecoveryIdentityV1,
  type SessionContinuationReplayModeV1,
  type SessionContinuationRecoveryV1,
  type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';

import { buildContinuationResumePrompt } from './continuationResumePrompt';

export type ContinuationStore = Readonly<{
  read: (sessionId: string) => Promise<unknown | null> | unknown | null;
  write: (sessionId: string, state: unknown) => Promise<void> | void;
}>;

type SessionContinuationRecoveryControllerDeps = Readonly<{
  nowMs: () => number;
  providerActivityTimeoutMs?: number;
  store: ContinuationStore;
  /** Account-level custom resume prompt text (used when an attempt's mode is 'custom'). */
  readCustomResumePrompt?: () => string | null | undefined;
}>;

type BeginContinuationAttemptInput = Readonly<{
  sessionId: string;
  attemptId: string;
  failureAtMs: number;
  resumePromptMode: SessionContinuationResumePromptModeV1;
  replayMode?: SessionContinuationReplayModeV1;
  recoveryIdentity?: SessionContinuationRecoveryIdentityV1;
  continuationRequired?: boolean;
}>;

type ResolveContinuationAttemptInput = BeginContinuationAttemptInput & Readonly<{
  exactProviderContextAvailable: boolean;
  hasUserMessageAfterFailure: () => Promise<boolean> | boolean;
  canRetryOriginalUserMessage?: () =>
    | Promise<'allowed' | 'blocked_provider_activity' | 'unknown'>
    | 'allowed'
    | 'blocked_provider_activity'
    | 'unknown';
  sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
  retryOriginalUserMessage?: (input: { localId: string }) => Promise<void> | void;
}>;

type ResolveContinuationAttemptResult = Readonly<{
  status:
    | 'awaiting_provider_activity'
    | 'provider_activity_observed'
    | 'provider_activity_timeout'
    | 'already_awaiting_provider_activity'
    | 'already_observed_provider_activity'
    | 'already_sent'
    | 'suppressed_no_interrupted_turn'
    | 'suppressed_newer_user_input'
    | 'retry_required'
    | 'continuity_failed';
}>;

export function isContinuationRecoveryAwaitingProviderActivityStatus(status: string): boolean {
  return status === 'awaiting_provider_activity'
    || status === 'already_awaiting_provider_activity';
}

const terminalStatuses = new Set<SessionContinuationRecoveryAttemptV1['status']>([
  'provider_activity_observed',
  'provider_activity_timeout',
  'sent',
  'suppressed_no_interrupted_turn',
  'suppressed_newer_user_input',
  'retry_required',
  'continuity_failed',
]);
const DEFAULT_PROVIDER_ACTIVITY_TIMEOUT_MS = 5 * 60_000;

function createEmptyRecovery(): SessionContinuationRecoveryV1 {
  return {
    v: 1,
    attemptsById: {},
  };
}

function cloneAttempt(attempt: SessionContinuationRecoveryAttemptV1): SessionContinuationRecoveryAttemptV1 {
  return {
    ...attempt,
    ...(attempt.recoveryIdentity ? { recoveryIdentity: { ...attempt.recoveryIdentity } } : {}),
  };
}

function cloneRecovery(recovery: SessionContinuationRecoveryV1): SessionContinuationRecoveryV1 {
  return {
    v: 1,
    attemptsById: Object.fromEntries(
      Object.entries(recovery.attemptsById).map(([attemptId, attempt]) => [
        attemptId,
        cloneAttempt(attempt),
      ]),
    ),
  };
}

function parseRecovery(value: unknown): SessionContinuationRecoveryV1 | null {
  const direct = SessionContinuationRecoveryV1Schema.safeParse(value);
  if (direct.success) return direct.data;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>)[SESSION_CONTINUATION_RECOVERY_METADATA_KEY];
    const parsedNested = SessionContinuationRecoveryV1Schema.safeParse(nested);
    if (parsedNested.success) return parsedNested.data;
  }
  return null;
}

function selectNewestAttempt(
  left: SessionContinuationRecoveryAttemptV1 | undefined,
  right: SessionContinuationRecoveryAttemptV1 | undefined,
): SessionContinuationRecoveryAttemptV1 | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.updatedAtMs > left.updatedAtMs ? right : left;
}

function mergeRecoveryStates(
  left: SessionContinuationRecoveryV1 | null,
  right: SessionContinuationRecoveryV1 | null,
): SessionContinuationRecoveryV1 | null {
  if (!left) return right ? cloneRecovery(right) : null;
  if (!right) return cloneRecovery(left);
  const attemptsById: SessionContinuationRecoveryV1['attemptsById'] = {};
  const attemptIds = new Set([
    ...Object.keys(left.attemptsById),
    ...Object.keys(right.attemptsById),
  ]);
  for (const attemptId of attemptIds) {
    const selected = selectNewestAttempt(left.attemptsById[attemptId], right.attemptsById[attemptId]);
    if (selected) attemptsById[attemptId] = cloneAttempt(selected);
  }
  return { v: 1, attemptsById };
}

export function createSessionContinuationRecoveryOverlayStore(params: Readonly<{
  durableStore: ContinuationStore;
}>): ContinuationStore {
  const cache = new Map<string, SessionContinuationRecoveryV1>();
  return {
    async read(sessionId) {
      const durable = parseRecovery(await params.durableStore.read(sessionId));
      const cached = cache.get(sessionId) ?? null;
      return mergeRecoveryStates(durable, cached) ?? null;
    },
    async write(sessionId, state) {
      await params.durableStore.write(sessionId, state);
      const parsed = parseRecovery(state);
      if (parsed) {
        cache.set(sessionId, cloneRecovery(parsed));
      } else {
        cache.delete(sessionId);
      }
    },
  };
}

async function readRecovery(store: ContinuationStore, sessionId: string): Promise<SessionContinuationRecoveryV1> {
  return parseRecovery(await store.read(sessionId)) ?? createEmptyRecovery();
}

async function writeRecovery(
  store: ContinuationStore,
  sessionId: string,
  recovery: SessionContinuationRecoveryV1,
): Promise<void> {
  await store.write(sessionId, recovery);
}

function buildAttempt(
  input: BeginContinuationAttemptInput,
  status: SessionContinuationRecoveryAttemptV1['status'],
  updatedAtMs: number,
  extra?: Readonly<Pick<SessionContinuationRecoveryAttemptV1, 'sentAtMs' | 'errorCode'>>,
): SessionContinuationRecoveryAttemptV1 {
  return {
    v: 1,
    attemptId: input.attemptId,
    status,
    failureAtMs: input.failureAtMs,
    updatedAtMs,
    resumePromptMode: input.resumePromptMode,
    ...(input.replayMode === undefined ? {} : { replayMode: input.replayMode }),
    ...(input.recoveryIdentity === undefined ? {} : { recoveryIdentity: input.recoveryIdentity }),
    ...(input.continuationRequired === undefined ? {} : { continuationRequired: input.continuationRequired }),
    ...(extra?.sentAtMs === undefined ? {} : { sentAtMs: extra.sentAtMs }),
    ...(extra?.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
  };
}

function resolveTerminalStatus(
  status: SessionContinuationRecoveryAttemptV1['status'],
): ResolveContinuationAttemptResult | null {
  if (status === 'sent') return { status: 'already_sent' };
  if (status === 'provider_activity_observed') return { status: 'already_observed_provider_activity' };
  if (status === 'provider_activity_timeout') return { status };
  if (status === 'suppressed_no_interrupted_turn') return { status };
  if (status === 'suppressed_newer_user_input') return { status };
  if (status === 'retry_required') return { status };
  if (status === 'continuity_failed') return { status };
  return null;
}

function resolveProviderActivityTimeoutMs(deps: SessionContinuationRecoveryControllerDeps): number {
  const configured = deps.providerActivityTimeoutMs;
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_PROVIDER_ACTIVITY_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.trunc(configured));
}

function isProviderActivityWaitExpired(input: Readonly<{
  attempt: SessionContinuationRecoveryAttemptV1;
  nowMs: number;
  timeoutMs: number;
}>): boolean {
  if (input.attempt.status !== 'awaiting_provider_activity') return false;
  if (input.attempt.sentAtMs === undefined) return false;
  return input.nowMs - input.attempt.sentAtMs >= input.timeoutMs;
}

function resolveContinuationRequired(input: Readonly<{
  existing?: SessionContinuationRecoveryAttemptV1 | null;
  fallback?: boolean;
}>): boolean {
  if (input.existing?.continuationRequired === false) return false;
  if (input.existing?.continuationRequired === true) return true;
  return input.fallback !== false;
}

function buildContinuationPromptLocalId(input: Readonly<{
  sessionId: string;
  attemptId: string;
}>): string {
  const digest = createHash('sha256')
    .update(input.sessionId)
    .update('\0')
    .update(input.attemptId)
    .digest('hex')
    .slice(0, 32);
  return `connected-service-continuation:${digest}`;
}

function buildOriginalUserMessageRetryLocalId(input: Readonly<{
  sessionId: string;
  attemptId: string;
}>): string {
  const digest = createHash('sha256')
    .update(input.sessionId)
    .update('\0')
    .update(input.attemptId)
    .digest('hex')
    .slice(0, 32);
  return `connected-service-original-retry:${digest}`;
}

function isSameRecoveryIdentity(
  left: SessionContinuationRecoveryIdentityV1 | undefined,
  right: SessionContinuationRecoveryIdentityV1 | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.serviceId !== right.serviceId) return false;
  if (left.selectionKind !== right.selectionKind) return false;
  if (right.groupId !== undefined && (left.groupId ?? null) !== right.groupId) return false;
  if (right.profileId !== undefined && (left.profileId ?? null) !== right.profileId) return false;
  if (right.failureFingerprint !== undefined && (left.failureFingerprint ?? null) !== right.failureFingerprint) return false;
  if (right.targetGeneration !== undefined && (left.targetGeneration ?? null) !== right.targetGeneration) return false;
  return true;
}

function shouldRecordProviderActivityForAttempt(input: Readonly<{
  attempt: SessionContinuationRecoveryAttemptV1;
  activityAtMs: number;
  recoveryIdentity?: SessionContinuationRecoveryIdentityV1;
}>): boolean {
  if (input.attempt.status !== 'awaiting_provider_activity') return false;
  if (input.attempt.sentAtMs !== undefined && input.activityAtMs < input.attempt.sentAtMs) {
    return false;
  }
  if (!input.recoveryIdentity) return !input.attempt.recoveryIdentity;
  return isSameRecoveryIdentity(input.attempt.recoveryIdentity, input.recoveryIdentity);
}

export function createSessionContinuationRecoveryController(
  deps: SessionContinuationRecoveryControllerDeps,
) {
  const providerActivityTimeoutMs = resolveProviderActivityTimeoutMs(deps);

  async function setAttempt(
    input: BeginContinuationAttemptInput,
    status: SessionContinuationRecoveryAttemptV1['status'],
    extra?: Readonly<Pick<SessionContinuationRecoveryAttemptV1, 'sentAtMs' | 'errorCode'>>,
  ): Promise<SessionContinuationRecoveryV1> {
    const recovery = await readRecovery(deps.store, input.sessionId);
    recovery.attemptsById[input.attemptId] = buildAttempt(input, status, deps.nowMs(), extra);
    await writeRecovery(deps.store, input.sessionId, recovery);
    return recovery;
  }

  async function resolveAttempt(input: ResolveContinuationAttemptInput): Promise<ResolveContinuationAttemptResult> {
    const recovery = await readRecovery(deps.store, input.sessionId);
    const existing = recovery.attemptsById[input.attemptId];
    const terminalResult = existing ? resolveTerminalStatus(existing.status) : null;
    if (terminalResult) return terminalResult;
    if (existing?.status === 'sending') {
      if (existing.sentAtMs !== undefined) {
        await setAttempt(
          { ...input, continuationRequired: resolveContinuationRequired({ existing, fallback: input.continuationRequired }) },
          'awaiting_provider_activity',
          { sentAtMs: existing.sentAtMs },
        );
        return { status: 'already_awaiting_provider_activity' };
      }
    }
    if (existing?.status === 'awaiting_provider_activity') {
      if (isProviderActivityWaitExpired({ attempt: existing, nowMs: deps.nowMs(), timeoutMs: providerActivityTimeoutMs })) {
        await setAttempt(
          {
            sessionId: input.sessionId,
            attemptId: existing.attemptId,
            failureAtMs: existing.failureAtMs,
            resumePromptMode: existing.resumePromptMode,
            replayMode: existing.replayMode,
            recoveryIdentity: existing.recoveryIdentity,
            continuationRequired: existing.continuationRequired,
          },
          'provider_activity_timeout',
          {
            ...(existing.sentAtMs === undefined ? {} : { sentAtMs: existing.sentAtMs }),
            errorCode: 'provider_activity_timeout',
          },
        );
        return { status: 'provider_activity_timeout' };
      }
      return { status: 'already_awaiting_provider_activity' };
    }

    const continuationRequired = resolveContinuationRequired({
      existing,
      fallback: input.continuationRequired,
    });
    const attemptInput = {
      ...input,
      continuationRequired,
    };
    const replayMode = attemptInput.replayMode ?? 'continuation_prompt';

    if (!continuationRequired || replayMode === 'suppress') {
      await setAttempt(attemptInput, 'suppressed_no_interrupted_turn');
      return { status: 'suppressed_no_interrupted_turn' };
    }

    if (input.resumePromptMode === 'off') {
      await setAttempt(attemptInput, 'retry_required', { errorCode: 'resume_prompt_disabled' });
      return { status: 'retry_required' };
    }
    if (!input.exactProviderContextAvailable && replayMode === 'continuation_prompt') {
      await setAttempt(attemptInput, 'retry_required', { errorCode: 'provider_context_unavailable' });
      return { status: 'retry_required' };
    }
    if (await input.hasUserMessageAfterFailure()) {
      await setAttempt(attemptInput, 'suppressed_newer_user_input');
      return { status: 'suppressed_newer_user_input' };
    }

    await setAttempt(attemptInput, 'sending');
    try {
      if (replayMode === 'retry_original_user_message') {
        const retrySafety = input.canRetryOriginalUserMessage
          ? await input.canRetryOriginalUserMessage()
          : 'allowed';
        if (!input.retryOriginalUserMessage) {
          await setAttempt(attemptInput, 'retry_required', { errorCode: 'original_user_message_retry_unavailable' });
          return { status: 'retry_required' };
        }
        if (retrySafety !== 'allowed') {
          await setAttempt(attemptInput, 'retry_required', {
            errorCode: retrySafety === 'blocked_provider_activity'
              ? 'original_user_message_retry_provider_activity_detected'
              : 'original_user_message_retry_evidence_unavailable',
          });
          return { status: 'retry_required' };
        }
        await input.retryOriginalUserMessage({
          localId: buildOriginalUserMessageRetryLocalId(input),
        });
      } else {
        await input.sendContinuationPrompt({
          prompt: buildContinuationResumePrompt({
            resumePromptMode: input.resumePromptMode,
            customResumePrompt: deps.readCustomResumePrompt?.() ?? null,
          }),
          localId: buildContinuationPromptLocalId(input),
        });
      }
    } catch {
      await setAttempt(attemptInput, 'retry_required', { errorCode: 'continuation_prompt_failed' });
      return { status: 'retry_required' };
    }
    const sentAtMs = deps.nowMs();
    await setAttempt(attemptInput, 'sending', { sentAtMs });
    await setAttempt(attemptInput, 'awaiting_provider_activity', { sentAtMs });
    return { status: 'awaiting_provider_activity' };
  }

  return {
    async beginAttempt(input: BeginContinuationAttemptInput): Promise<SessionContinuationRecoveryV1> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      const existing = recovery.attemptsById[input.attemptId];
      if (existing && terminalStatuses.has(existing.status)) return recovery;
      recovery.attemptsById[input.attemptId] = buildAttempt(
        input,
        'pending_provider_context',
        deps.nowMs(),
      );
      await writeRecovery(deps.store, input.sessionId, recovery);
      return recovery;
    },

    resolveAttempt,

    async recordProviderActivity(input: Readonly<{
      sessionId: string;
      recoveryIdentity?: SessionContinuationRecoveryIdentityV1;
      activityAtMs?: number;
    }>): Promise<{ observed: number }> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      let observed = 0;
      const activityAtMs = input.activityAtMs ?? deps.nowMs();
      for (const attempt of Object.values(recovery.attemptsById)) {
        if (!shouldRecordProviderActivityForAttempt({
          attempt,
          activityAtMs,
          recoveryIdentity: input.recoveryIdentity,
        })) continue;
        recovery.attemptsById[attempt.attemptId] = buildAttempt(
          {
            sessionId: input.sessionId,
            attemptId: attempt.attemptId,
            failureAtMs: attempt.failureAtMs,
            resumePromptMode: attempt.resumePromptMode,
            replayMode: attempt.replayMode,
            recoveryIdentity: attempt.recoveryIdentity,
            continuationRequired: attempt.continuationRequired,
          },
          'provider_activity_observed',
          deps.nowMs(),
          attempt.sentAtMs === undefined ? undefined : { sentAtMs: attempt.sentAtMs },
        );
        observed += 1;
      }
      if (observed > 0) {
        await writeRecovery(deps.store, input.sessionId, recovery);
      }
      return { observed };
    },

    async expireProviderActivityWaits(input: Readonly<{
      sessionId: string;
    }>): Promise<{ expired: number }> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      let expired = 0;
      const nowMs = deps.nowMs();
      for (const attempt of Object.values(recovery.attemptsById)) {
        if (!isProviderActivityWaitExpired({ attempt, nowMs, timeoutMs: providerActivityTimeoutMs })) continue;
        recovery.attemptsById[attempt.attemptId] = buildAttempt(
          {
            sessionId: input.sessionId,
            attemptId: attempt.attemptId,
            failureAtMs: attempt.failureAtMs,
            resumePromptMode: attempt.resumePromptMode,
            replayMode: attempt.replayMode,
            recoveryIdentity: attempt.recoveryIdentity,
            continuationRequired: attempt.continuationRequired,
          },
          'provider_activity_timeout',
          nowMs,
          {
            ...(attempt.sentAtMs === undefined ? {} : { sentAtMs: attempt.sentAtMs }),
            errorCode: 'provider_activity_timeout',
          },
        );
        expired += 1;
      }
      if (expired > 0) {
        await writeRecovery(deps.store, input.sessionId, recovery);
      }
      return { expired };
    },

    async suppressPendingAttempts(input: Readonly<{
      sessionId: string;
    }>): Promise<{ suppressed: number }> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      let suppressed = 0;
      for (const attempt of Object.values(recovery.attemptsById)) {
        if (terminalStatuses.has(attempt.status)) continue;
        recovery.attemptsById[attempt.attemptId] = buildAttempt(
          {
            sessionId: input.sessionId,
            attemptId: attempt.attemptId,
            failureAtMs: attempt.failureAtMs,
            resumePromptMode: attempt.resumePromptMode,
            replayMode: attempt.replayMode,
            recoveryIdentity: attempt.recoveryIdentity,
            continuationRequired: attempt.continuationRequired,
          },
          'suppressed_newer_user_input',
          deps.nowMs(),
          attempt.sentAtMs === undefined ? undefined : { sentAtMs: attempt.sentAtMs },
        );
        suppressed += 1;
      }
      if (suppressed > 0) {
        await writeRecovery(deps.store, input.sessionId, recovery);
      }
      return { suppressed };
    },

    async resolvePendingAttempts(input: Readonly<{
      sessionId: string;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: (input: { failureAtMs: number }) => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
      canRetryOriginalUserMessage?: (input: { attemptId: string; failureAtMs: number }) =>
        | Promise<'allowed' | 'blocked_provider_activity' | 'unknown'>
        | 'allowed'
        | 'blocked_provider_activity'
        | 'unknown';
      retryOriginalUserMessage?: (input: { attemptId: string; localId: string; failureAtMs: number }) => Promise<void> | void;
    }>): Promise<{ resolved: Array<{ attemptId: string; status: ResolveContinuationAttemptResult['status'] }> }> {
      const recovery = await readRecovery(deps.store, input.sessionId);
      const unresolvedAttempts = Object.values(recovery.attemptsById)
        .filter((attempt) => !terminalStatuses.has(attempt.status));
      const resolved: Array<{ attemptId: string; status: ResolveContinuationAttemptResult['status'] }> = [];
      for (const attempt of unresolvedAttempts) {
        const result = await resolveAttempt({
          sessionId: input.sessionId,
          attemptId: attempt.attemptId,
          failureAtMs: attempt.failureAtMs,
          resumePromptMode: attempt.resumePromptMode,
          replayMode: attempt.replayMode,
          recoveryIdentity: attempt.recoveryIdentity,
          continuationRequired: attempt.continuationRequired,
          exactProviderContextAvailable: input.exactProviderContextAvailable,
          hasUserMessageAfterFailure: () =>
            input.hasUserMessageAfterFailure({ failureAtMs: attempt.failureAtMs }),
          sendContinuationPrompt: input.sendContinuationPrompt,
          canRetryOriginalUserMessage: input.canRetryOriginalUserMessage
            ? () => input.canRetryOriginalUserMessage?.({
                attemptId: attempt.attemptId,
                failureAtMs: attempt.failureAtMs,
              }) ?? 'unknown'
            : undefined,
          retryOriginalUserMessage: input.retryOriginalUserMessage
            ? ({ localId }) => input.retryOriginalUserMessage?.({
                attemptId: attempt.attemptId,
                localId,
                failureAtMs: attempt.failureAtMs,
              })
            : undefined,
        });
        resolved.push({ attemptId: attempt.attemptId, status: result.status });
      }
      return { resolved };
    },
  };
}
