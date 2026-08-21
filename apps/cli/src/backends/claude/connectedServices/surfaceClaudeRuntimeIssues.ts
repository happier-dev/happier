import {
    readConnectedServiceLimitCategoryV1,
    type ConnectedServiceQuotaSnapshotV1,
    type ConnectedServiceLimitCategoryV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import type { SessionEventMessage } from '@/api/session/sessionMessageTypes';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import {
    connectedServiceRuntimeAuthRecoveryWillContinue,
    projectConnectedServiceRuntimeAuthRecoveryReport,
} from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoverySessionEvent';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { buildNativeProviderAccountUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';
import { createConnectedServiceQuotaSnapshotDeliveryOutbox } from '@/daemon/connectedServices/quotas/connectedServiceQuotaSnapshotDeliveryOutbox';
import { deliverConnectedServiceQuotaSnapshotToDaemon } from '@/daemon/connectedServices/quotas/deliverConnectedServiceQuotaSnapshotToDaemon';
import { logger } from '@/ui/logger';
import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';

import { resolveClaudeRuntimeAuthRetryDecision } from './claudeRuntimeAuthRetryDecision';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import type { NormalizedProviderUsageLimitDetailsV1 } from './mapClaudeRateLimitEventToUsageDetails';
import { resolveClaudeRuntimeProviderAccountIdentity } from './resolveClaudeRuntimeProviderAccountIdentity';

type RuntimeIssueSession = Readonly<{
    client: {
        sessionId: string;
        sendSessionEvent?: (event: SessionEventMessage) => void;
        updateMetadata?: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
        sessionTurnLifecycle?: {
            failTurn?: (params: { provider: 'claude'; issue: SessionRuntimeIssueV1 }) => Promise<void> | void;
        };
    };
}>;

type RuntimeIssueUsageLimitDetails = NonNullable<SessionRuntimeIssueV1['usageLimit']>;
type RuntimeIssueConnectedService = NonNullable<RuntimeIssueUsageLimitDetails['connectedService']>;
type RuntimeIssueRecoveryProjectionDeduperState = Readonly<{
    key: string;
    surfacedAtMs: number;
}>;
type ClaudeQuotaSnapshotSource = NonNullable<ConnectedServiceQuotaSnapshotV1['source']>;
type ClaudeQuotaSnapshotEvidenceKind = 'claude_runtime_usage_limit' | 'claude_runtime_quota_utilization';

const CLAUDE_RUNTIME_ISSUE_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS = 15_000;
const recentRecoveryProjectionByClient = new WeakMap<
    RuntimeIssueSession['client'],
    RuntimeIssueRecoveryProjectionDeduperState
>();
const continuingRuntimeAuthRecoveries = new WeakSet<object>();

function beginConnectedClaudeTurnFailure(
    session: RuntimeIssueSession,
    issue: SessionRuntimeIssueV1,
    logPrefix: string,
): void {
    try {
        // `failTurn` commits the local terminal transition synchronously before its returned
        // promise waits for the durable session-event write. Connected Services recovery must
        // not be serialized behind that unrelated durable acknowledgement: doing so leaves the
        // selected account unchanged whenever the event write stalls, even though the provider
        // has already rejected the turn. Keep the write owned by the turn lifecycle and observe
        // its failure, while allowing the canonical recovery report to proceed immediately.
        const settlement = session.client.sessionTurnLifecycle?.failTurn?.({
            provider: 'claude',
            issue,
        });
        void Promise.resolve(settlement).catch((error) => {
            logger.debug(`${logPrefix} Failed to persist Claude terminal turn failure`, error);
        });
    } catch (error) {
        logger.debug(`${logPrefix} Failed to begin Claude terminal turn failure`, error);
    }
}

export function isClaudeRuntimeAuthRecoveryContinuing(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return continuingRuntimeAuthRecoveries.has(error);
}

function markClaudeRuntimeAuthRecoveryContinuing(error: unknown): void {
    if (error && typeof error === 'object') {
        continuingRuntimeAuthRecoveries.add(error);
    }
}

const claudeQuotaSnapshotDeliveryOutbox = createConnectedServiceQuotaSnapshotDeliveryOutbox({
    // CS-FIX-3: route through the ONE shared full-payload daemon deliver helper (forwards
    // `sourceProviderAccountId`) instead of a hand-rolled per-site closure.
    deliver: deliverConnectedServiceQuotaSnapshotToDaemon,
    retryDelayMs: 1_000,
    onDiagnostic: (diagnostic) => {
        logger.debug('[claude] Connected-service quota snapshot delivery diagnostic', diagnostic);
    },
});

function normalizeClaudePublicLimitCategory(
    value: NormalizedProviderUsageLimitDetailsV1['limitCategory'] | null | undefined,
): ConnectedServiceLimitCategoryV1 {
    return readConnectedServiceLimitCategoryV1(value) ?? 'usage_limit';
}

function buildRuntimeAuthRecoveryProjectionDeduperKey(input: Readonly<{
    classification: ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>;
    recoveryReport: Awaited<ReturnType<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>>;
}>): string {
    const transcriptEvent = input.recoveryReport.projection?.transcriptEvent as
        | Readonly<Record<string, unknown>>
        | undefined;
    // Stable identity only (incident Jun-11 H-C): `retryAfterMs`/`nextRetryAtMs`/`statusMessage`
    // are recomputed from Date.now() per trigger, so embedding them made every key unique and
    // the deduper never matched.
    return JSON.stringify({
        statusCode: input.recoveryReport.statusCode ?? null,
        serviceId: input.classification?.serviceId ?? null,
        profileId: input.classification?.profileId ?? null,
        groupId: input.classification?.groupId ?? null,
        kind: input.classification?.kind ?? null,
        limitCategory: input.classification?.limitCategory ?? null,
        resetsAtMs: input.classification?.resetsAtMs ?? null,
        transcriptStatus: typeof transcriptEvent?.status === 'string' ? transcriptEvent.status : null,
    });
}

function shouldSuppressDuplicateRuntimeAuthRecoveryProjection(input: Readonly<{
    client: RuntimeIssueSession['client'];
    key: string;
    nowMs: number;
}>): boolean {
    const current = recentRecoveryProjectionByClient.get(input.client);
    if (!current) return false;
    if (current.key !== input.key) return false;
    return input.nowMs - current.surfacedAtMs <= CLAUDE_RUNTIME_ISSUE_RECOVERY_PROJECTION_DEDUPE_WINDOW_MS;
}

function rememberRuntimeAuthRecoveryProjection(input: Readonly<{
    client: RuntimeIssueSession['client'];
    key: string;
    surfacedAtMs: number;
}>): void {
    recentRecoveryProjectionByClient.set(input.client, {
        key: input.key,
        surfacedAtMs: input.surfacedAtMs,
    });
}

function projectClaudeRuntimeAuthRecoveryReport(input: Readonly<{
    session: RuntimeIssueSession;
    recoveryReport: Awaited<ReturnType<typeof reportConnectedServiceRuntimeAuthFailureToDaemon>>;
    classification: NonNullable<ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>>;
    logPrefix: string;
}>): void {
    const projectionKey = buildRuntimeAuthRecoveryProjectionDeduperKey({
        classification: input.classification,
        recoveryReport: input.recoveryReport,
    });
    const nowMs = Date.now();
    if (shouldSuppressDuplicateRuntimeAuthRecoveryProjection({
        client: input.session.client,
        key: projectionKey,
        nowMs,
    })) {
        return;
    }
    const result = projectConnectedServiceRuntimeAuthRecoveryReport({
        report: input.recoveryReport,
        classification: input.classification,
        sendGenericStatusMessage: (message) => {
            if (!input.session.client.sendSessionEvent) return false;
            input.session.client.sendSessionEvent({ type: 'message', message });
            return true;
        },
        commitTypedProjection: (projection) => {
            if (!projection.transcriptEvent) return false;
            input.session.client.sendSessionEvent?.(projection.transcriptEvent);
            return Boolean(input.session.client.sendSessionEvent);
        },
    });
    if (result.emitted) {
        rememberRuntimeAuthRecoveryProjection({
            client: input.session.client,
            key: projectionKey,
            surfacedAtMs: nowMs,
        });
    }
}

/**
 * R3-4: the rate_limit tap runs in the agent child process whose materialized `CLAUDE_CONFIG_DIR`
 * names the live account. Stamp that real provider-account UUID onto the evidence as
 * `sourceProviderAccountId` so the emitted quota snapshot forms a PROVEN source link — the
 * precondition the predictive soft-switch policy requires. Without this the field is never set and
 * Claude runtime evidence stays unproven, so predictive pool switching correctly fails closed and
 * never fires (the flagship Claude soft-swap). An already-supplied identity is respected; a
 * genuinely-unknown identity (no `oauthAccount`, e.g. api-key sessions) stays unset = fail closed.
 */
async function enrichClaudeUsageDetailsWithRuntimeAccountIdentity(
    details: NormalizedProviderUsageLimitDetailsV1,
): Promise<NormalizedProviderUsageLimitDetailsV1> {
    if (typeof details.sourceProviderAccountId === 'string' && details.sourceProviderAccountId.trim().length > 0) {
        return details;
    }
    // Only connected-service (pool) sessions carry a source identity: the soft-switch is a pool
    // feature, and source links are attributed to a connected-service account. Native sessions
    // have no pool to switch within, so they stay unstamped (and must not read the ambient home).
    const hasConnectedServiceSelection = Boolean(
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic'),
    );
    if (!hasConnectedServiceSelection) return details;
    const identity = await resolveClaudeRuntimeProviderAccountIdentity({ env: process.env }).catch(() => null);
    const providerAccountId = identity?.providerAccountId ?? null;
    if (!providerAccountId) return details;
    return { ...details, sourceProviderAccountId: providerAccountId };
}

function buildNativeClaudeQuotaProfileId(): string {
    return buildNativeProviderAccountUsageSourceProfileId({
        kind: 'localCredential',
        providerId: 'claude',
        material: resolveConfiguredClaudeConfigDir({ env: process.env }),
    });
}

function buildClaudeRuntimeQuotaSnapshot(params: Readonly<{
    details: NormalizedProviderUsageLimitDetailsV1;
    fetchedAt: number;
    serviceId: RuntimeIssueConnectedService['serviceId'];
    profileId: string;
    source?: ClaudeQuotaSnapshotSource;
    evidenceKind?: ClaudeQuotaSnapshotEvidenceKind;
}>): ConnectedServiceQuotaSnapshotV1 {
    const providerLimitId = params.details.providerLimitId ?? params.details.limitCategory ?? 'account';
    const resetAtMs = params.details.resetAtMs ?? params.details.overage?.resetAtMs ?? null;
    const utilizationPct = params.details.utilization;
    const source = params.source ?? 'runtime_event';
    const evidenceKind = params.evidenceKind ?? 'claude_runtime_usage_limit';
    return {
        v: 1,
        serviceId: params.serviceId,
        profileId: params.profileId,
        providerId: 'claude',
        fetchedAt: params.fetchedAt,
        fetchedAtMs: params.fetchedAt,
        staleAfterMs: 300_000,
        staleAtMs: params.fetchedAt + 300_000,
        planLabel: params.details.planType,
        accountLabel: null,
        source,
        confidence: utilizationPct === null ? 'derived' : 'exact',
        evidence: {
            kind: evidenceKind,
            providerLimitId,
            observedAtMs: params.fetchedAt,
        },
        meters: [{
            meterId: providerLimitId,
            label: 'Usage limit',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct,
            usedPct: utilizationPct,
            remainingPct: utilizationPct === null ? null : Math.max(0, 100 - utilizationPct),
            resetsAt: resetAtMs,
            resetAtMs: resetAtMs,
            resetSource: resetAtMs === null
                ? 'unknown'
                : source === 'in_band_provider_snapshot'
                    ? 'in_band_snapshot'
                    : 'provider_event',
            status: 'ok',
            source,
            scope: 'unknown',
            limitScope: params.details.quotaScope,
            confidence: utilizationPct === null ? 'derived' : 'exact',
            providerLimitId,
            details: {
                providerLimitId,
                limitCategory: normalizeClaudePublicLimitCategory(params.details.limitCategory),
            },
        }],
    };
}

function resolveClaudeQuotaSnapshotTarget(input: Readonly<{
    serviceId?: RuntimeIssueConnectedService['serviceId'] | null;
    profileId?: string | null;
    groupId?: string | null;
}>): Readonly<{
    serviceId: RuntimeIssueConnectedService['serviceId'];
    profileId: string | null;
    groupId: string | null;
    groupGeneration: number | null;
}> {
    const selection =
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic')
        ?? undefined;
    const selectedGroup = selection?.kind === 'group' ? selection : null;
    const serviceId = input.serviceId
        ?? (selection?.serviceId === 'anthropic' ? 'anthropic' : 'claude-subscription');
    const groupId = input.groupId ?? selectedGroup?.groupId ?? null;
    const profileId = input.profileId
        ?? (selection?.kind === 'group' ? selection.activeProfileId : selection?.kind === 'profile' ? selection.profileId : null)
        ?? (selection ? null : buildNativeClaudeQuotaProfileId());
    return {
        serviceId,
        profileId,
        groupId,
        groupGeneration: selectedGroup && groupId === selectedGroup.groupId ? selectedGroup.generation : null,
    };
}

export async function recordClaudeRateLimitQuotaEvidence(
    session: RuntimeIssueSession,
    details: NormalizedProviderUsageLimitDetailsV1,
    logPrefix: string,
): Promise<void> {
    void logPrefix;
    const target = resolveClaudeQuotaSnapshotTarget({});
    if (!target.profileId) return;
    const enrichedDetails = await enrichClaudeUsageDetailsWithRuntimeAccountIdentity(details);
    const observedAt = Date.now();
    await claudeQuotaSnapshotDeliveryOutbox.enqueueAndFlush({
        sessionId: session.client.sessionId,
        serviceId: target.serviceId,
        ...(target.groupId ? { groupId: target.groupId } : {}),
        ...(target.groupGeneration !== null ? { groupGeneration: target.groupGeneration } : {}),
        ...(enrichedDetails.sourceProviderAccountId !== undefined ? { sourceProviderAccountId: enrichedDetails.sourceProviderAccountId } : {}),
        snapshot: buildClaudeRuntimeQuotaSnapshot({
            details: enrichedDetails,
            fetchedAt: observedAt,
            serviceId: target.serviceId,
            profileId: target.profileId,
            source: 'in_band_provider_snapshot',
            evidenceKind: 'claude_runtime_quota_utilization',
        }),
    }).catch(() => undefined);
}

function buildClaudeRuntimeIssueUsageLimit(params: Readonly<{
    details: NormalizedProviderUsageLimitDetailsV1;
    connectedService: RuntimeIssueConnectedService;
}>): RuntimeIssueUsageLimitDetails {
    const providerLimitId = params.details.providerLimitId ?? params.details.limitCategory ?? 'account';
    const resetAtMs = params.details.resetAtMs ?? params.details.overage?.resetAtMs ?? null;
    const remainingPct = params.details.utilization === null
        ? null
        : Math.max(0, 100 - params.details.utilization);
    return {
        ...params.details,
        limitCategory: normalizeClaudePublicLimitCategory(params.details.limitCategory),
        connectedService: params.connectedService,
        ...(remainingPct === null
            ? {}
            : {
                effectiveMeterId: providerLimitId,
                effectiveRemainingPct: remainingPct,
                allWindows: [{
                    meterId: providerLimitId,
                    scope: params.details.quotaScope,
                    remainingPct,
                    ...(resetAtMs === null ? {} : { resetAtMs }),
                    status: 'ok',
                }],
            }),
    };
}

function buildClaudeRateLimitRuntimeIssue(params: Readonly<{
    details: NormalizedProviderUsageLimitDetailsV1;
    classification: NonNullable<ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>>;
    connectedService: RuntimeIssueConnectedService;
    occurredAt: number;
}>): SessionRuntimeIssueV1 {
    if (params.classification.kind === 'temporary_throttle') {
        return {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'provider_temporary_throttle',
            source: 'provider_status_error',
            occurredAt: params.occurredAt,
            provider: 'claude',
            sanitizedPreview: 'Provider is temporarily limiting requests',
            temporaryThrottle: {
                v: 1,
                retryAfterMs: params.classification.retryAfterMs ?? params.details.retryAfterMs ?? null,
                recoverability: 'retry',
            },
        };
    }
    const isProviderCapacity =
        params.classification.kind === 'capacity'
        || params.classification.limitCategory === 'capacity';
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: isProviderCapacity ? 'provider_status_error' : 'usage_limit',
        source: isProviderCapacity ? 'provider_status_error' : 'usage_limit',
        occurredAt: params.occurredAt,
        provider: 'claude',
        sanitizedPreview: isProviderCapacity ? 'Provider reported an error' : 'Usage limit reached',
        usageLimit: buildClaudeRuntimeIssueUsageLimit({
            details: params.details,
            connectedService: params.connectedService,
        }),
    };
}

export async function surfaceClaudeRateLimitRuntimeIssue(
    session: RuntimeIssueSession,
    details: NormalizedProviderUsageLimitDetailsV1,
    logPrefix: string,
): Promise<void> {
    const selection =
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic')
        ?? undefined;
    const enrichedDetailsPromise = enrichClaudeUsageDetailsWithRuntimeAccountIdentity(details);
    const initialClassification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        details,
        selection,
    });
    if (!initialClassification) return;
    const connectedServiceId: RuntimeIssueConnectedService['serviceId'] =
        initialClassification.serviceId === 'anthropic' ? 'anthropic' : 'claude-subscription';
    const profileId = initialClassification.profileId ?? (selection ? null : buildNativeClaudeQuotaProfileId());
    const selectedGroup = selection?.kind === 'group' ? selection : null;
    const effectiveGroupId = initialClassification.groupId ?? selectedGroup?.groupId ?? null;
    const effectiveGroupGeneration = selectedGroup && effectiveGroupId === selectedGroup.groupId
        ? selectedGroup.generation
        : null;
    const connectedService: RuntimeIssueConnectedService = {
        serviceId: connectedServiceId,
        profileId,
        groupId: effectiveGroupId,
    };
    // Incident Jun-11 H-B (trigger half) / FIX-3: rows imported from `subagents/agent-*.jsonl`
    // (isSidechain) describe a SUBAGENT request, not the parent turn. They must not fail the
    // parent turn and must not drive runtime-auth recovery. A sidechain LIMIT is still real
    // account-level evidence, so quota-snapshot recording below keeps consuming it — only the
    // turn-failure + recovery triggering is parent-turn-only.
    const sidechainSourced = details.sourcedFromSidechain === true;
    const occurredAt = Date.now();
    if (!sidechainSourced) {
        const issue = buildClaudeRateLimitRuntimeIssue({
            details,
            classification: initialClassification,
            connectedService,
            occurredAt,
        });
        if (selection) {
            beginConnectedClaudeTurnFailure(session, issue, logPrefix);
        } else {
            await session.client.sessionTurnLifecycle?.failTurn?.({
                provider: 'claude',
                issue,
            });
        }
    }
    const enrichedDetails = await enrichedDetailsPromise;
    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        details: enrichedDetails,
        selection,
    });
    if (!classification) return;
    // RD-QUO-2: in-band rate-limit evidence is the freshest usage signal for the real quota
    // subject. Record it for BOTH the native identity and the selected member (mirroring Codex)
    // so the canonical quota row does not lag behind the background fetcher for group sessions.
    if (profileId) {
        await claudeQuotaSnapshotDeliveryOutbox.enqueueAndFlush({
            sessionId: session.client.sessionId,
            serviceId: connectedServiceId,
            ...(effectiveGroupId ? { groupId: effectiveGroupId } : {}),
            ...(effectiveGroupGeneration !== null ? { groupGeneration: effectiveGroupGeneration } : {}),
            ...(enrichedDetails.sourceProviderAccountId !== undefined ? { sourceProviderAccountId: enrichedDetails.sourceProviderAccountId } : {}),
            snapshot: buildClaudeRuntimeQuotaSnapshot({
                details: enrichedDetails,
                fetchedAt: occurredAt,
                serviceId: connectedServiceId,
                profileId,
            }),
        }).catch(() => undefined);
    }
    if (sidechainSourced) return;
    if (!selection) return;
    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: session.client.sessionId,
        switchesThisTurn: 0,
        classification,
        logPrefix,
    });
    projectClaudeRuntimeAuthRecoveryReport({
        session,
        recoveryReport,
        classification,
        logPrefix,
    });
}

function isSubagentScopedRuntimeAuthEvidence(error: unknown): boolean {
    // Incident 2026-06-12 cmq8y3nlx: a SUBAGENT transcript row ("Please run /login · API Error:
    // 401 Invalid authentication credentials", transient — auth was actually fine) was classified
    // as a session-level auth failure and the daemon restarted the healthy parent session,
    // killing all in-flight work. Subagent-scoped evidence describes a SUBAGENT request, not the
    // parent session's credentials: it must not fail the parent turn and must not drive
    // runtime-auth recovery. A REAL persistent auth failure also hits the parent's own requests
    // (shared credentials), which still routes to recovery. Mirrors the sidechain gating for
    // usage-limit evidence (Jun-11 H-B / FIX-3 in surfaceClaudeRateLimitRuntimeIssue).
    const record = error && typeof error === 'object' && !Array.isArray(error)
        ? error as Record<string, unknown>
        : null;
    if (!record) return false;
    if (record.isSidechain === true) return true;
    const parentToolUseId = record.parent_tool_use_id ?? record.parentToolUseId;
    return typeof parentToolUseId === 'string' && parentToolUseId.trim().length > 0;
}

function containsClaudeOAuthRevocationText(value: unknown, depth = 0): boolean {
    if (depth > 5 || value === null || value === undefined) return false;
    if (typeof value === 'string') {
        return /\boauth(?: access)? token (?:has been (?:revoked|expired)|has expired)\b/i.test(value);
    }
    if (Array.isArray(value)) {
        return value.some((entry) => containsClaudeOAuthRevocationText(entry, depth + 1));
    }
    if (typeof value !== 'object') return false;
    return Object.values(value as Record<string, unknown>).some((entry) =>
        containsClaudeOAuthRevocationText(entry, depth + 1),
    );
}

export function containsDefinitiveClaudeOAuthRevocationEvidence(value: unknown): boolean {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    if (!record) return false;
    const apiStatus = record.apiErrorStatus ?? record.status ?? record.statusCode;
    const exactApiFailure = record.isApiErrorMessage === true && apiStatus === 401;
    const hookEventName = record.hook_event_name ?? record.hookEventName;
    const errorCode = record.error ?? record.error_type ?? record.errorType;
    const exactHookFailure = hookEventName === 'StopFailure'
        && (errorCode === 'authentication_failed' || errorCode === 'invalid_grant');
    return (exactApiFailure || exactHookFailure) && containsClaudeOAuthRevocationText(record);
}

export async function surfaceClaudeRuntimeAuthFailure(
    session: RuntimeIssueSession,
    error: unknown,
    logPrefix: string,
): Promise<boolean> {
    const subagentScoped = isSubagentScopedRuntimeAuthEvidence(error);
    const definitiveSubagentOAuthRevocation = subagentScoped
        && containsDefinitiveClaudeOAuthRevocationEvidence(error);
    if (subagentScoped && !definitiveSubagentOAuthRevocation) return false;
    const selection =
        findConnectedServiceChildSelection(process.env, 'claude-subscription')
        ?? findConnectedServiceChildSelection(process.env, 'anthropic')
        ?? null;

    const classification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        error,
        selection: selection ?? undefined,
    });
    if (!classification) return false;

    const retryDecision = resolveClaudeRuntimeAuthRetryDecision(error);
    if (!definitiveSubagentOAuthRevocation && retryDecision.action === 'await_provider_retry') {
        return false;
    }

    const issue = classifyPrimarySessionRuntimeIssue({
        provider: 'claude',
        cause: 'auth_error',
        error,
    });
    if (!selection) {
        if (subagentScoped) return false;
        await session.client.sessionTurnLifecycle?.failTurn?.({
            provider: 'claude',
            issue,
        });
        return true;
    }

    // The provider has already rejected this exact turn. Begin its local terminal transition
    // before asking Connected Services to repair the account, but do not let the terminal event's
    // durable write prevent the recovery owner from receiving the rejection.
    if (!subagentScoped) {
        beginConnectedClaudeTurnFailure(session, issue, logPrefix);
    }
    const recoveryReport = await reportConnectedServiceRuntimeAuthFailureToDaemon({
        sessionId: session.client.sessionId,
        switchesThisTurn: 0,
        classification,
        logPrefix,
    });
    projectClaudeRuntimeAuthRecoveryReport({
        session,
        recoveryReport,
        classification,
        logPrefix,
    });
    if (connectedServiceRuntimeAuthRecoveryWillContinue(recoveryReport)) {
        markClaudeRuntimeAuthRecoveryContinuing(error);
        return true;
    }
    return true;
}
