import { randomUUID } from 'node:crypto';
import type { PermissionResult } from '@/agent/permissions/permissionResult';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { Metadata, PermissionMode } from '@/api/types';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import { configuration } from '@/configuration';
import {
    type SessionRollbackRpcParams,
    type SessionRollbackRpcResult,
    SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
    SESSION_MEDIA_MESSAGE_META_KIND_V1,
    ReviewStartInputSchema,
    type SessionMediaItemV1,
    type SessionMediaUnavailableV1,
    type SessionInitialGoalRequestV1,
    type SessionConnectedServiceAuthApplyGenerationRequestV1,
    type SessionConnectedServiceAuthApplyGenerationResponseV1,
    SessionConnectedServiceAuthCurrentGroupTruthV1Schema,
    type SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
    type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
    SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
    resolveSessionUsageLimitRecoveryResumePromptModeV1,
    type SessionRuntimeIssueV1,
    type SessionRuntimeUsageLimitDetailsV1,
    type SessionUsageLimitRecoveryAuthSelectionV1,
    SessionUsageLimitRecoveryV1Schema,
    type SessionUsageLimitRecoveryV1,
    readPendingLocalId,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isChangeTitleToolNameAlias, normalizePatchInputRecord } from '@happier-dev/protocol/tools/v2';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import { createSerializedWorkQueueDiagnostics, type SerializedWorkDiagnosticContext } from '@/utils/serializedWorkQueueDiagnostics';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import type {
    ActiveTurnPendingPumpOptions,
    DrainPendingOptions,
    DrainPendingResult,
} from '@/agent/runtime/sessionInput/types';
import {
    classifyPrimarySessionRuntimeIssue,
    recordSessionTurnCompleted,
    recordSessionTurnInProgress,
    surfacePrimarySessionRuntimeIssue,
} from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import {
    resolveRecoverableTurnFailureRetryDecision,
    resolveRecoverableTurnFailureSecondFailure,
    type RecoverableTurnFailurePromptMode,
} from '@/agent/runtime/session/recoverableTurnFailurePolicy';
import { publishCodexSessionIdMetadata } from '../utils/codexSessionIdMetadata';
import { resolveApprovalChoiceLabel } from '../runtime/codexRequestUserInputBridge';
import {
    buildCodexRequestUserInputAnswers,
    looksLikeCodexApprovalRequestUserInput,
    normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput,
} from '../runtime/codexRequestUserInputQuestions';
import { canonicalizeCodexMcpToolName } from '../utils/canonicalizeCodexMcpToolName';
import {
    readCodexEnvironmentAuthState,
    readCodexEnvironmentAuthTokens,
} from '../cli/auth/readCodexEnvironmentAuthState';
import { resolveTrustedSessionAttachmentLocalImagePaths } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from '@/session/usageLimitRecoveryControls/persistUsageLimitRecoveryFieldDurably';

import {
    createCodexAppServerClient,
    isCodexAppServerJsonLineTooLargeError,
    type DisposableCodexAppServerClient,
} from './client/createCodexAppServerClient';
import {
    readCodexAppServerResumeRecoveryTimeoutMs,
    readCodexAppServerRpcTimeoutMs,
} from './client/codexAppServerRpcTimeout';
import {
    createCodexAppServerStreamEventBridge,
    type CodexAppServerStreamUpdate,
} from './streamEventBridge';
import type { AgentMessage } from '@/agent';
import { resolveSessionMediaDedupeKey } from '@/session/sessionMedia/sessionMediaDedupeKey';
import type { SessionMediaPersistResult } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { boundSessionMediaEnvelopeEntries } from '@/session/sessionMedia/boundSessionMediaEnvelopeEntries';
import {
    publishCodexAppServerSessionControlsMetadata,
    publishCodexAppServerRuntimeModelContextWindowMetadata,
    resolveCodexAppServerCollaborationModeSelection,
} from './sessionControlsMetadata';
import { isCodexAppServerFastServiceTier } from './speedEligibility';
import { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';
import {
    captureCompletedTurnSeqRange,
    publishRollbackRangeMetadata,
    publishLatestTurnRollbackRangeMetadata,
} from './rollbackMetadata';
import {
    isCodexAppServerInvalidRequestForMethodError,
    isCodexAppServerInvalidRequestMapExpectedStringError,
    isCodexAppServerInvalidParamsForFieldError,
    isCodexAppServerInvalidParamsError,
    isCodexAppServerMethodNotFoundError,
    isCodexAppServerNoActiveTurnToSteerError,
} from './appServerCompatibility';
import { readCodexRateLimitsSnapshot } from './readCodexRateLimitsSnapshot';
import {
    buildCodexAppServerLegacyPermissionParams,
    buildCodexAppServerPermissionsParams,
    readCodexAppServerActivePermissionProfile,
} from './permissionProfile';
import { buildCodexAppServerTurnInput, type CodexAppServerTurnInputItem } from './turnInput';
import {
    listCodexAppServerSkills,
    listCodexVendorPlugins,
} from './pluginAndSkillCatalog';
import {
    mergeCodexGoalIntoSessionWorkStateMetadata,
    removeCodexGoalFromSessionWorkStateMetadata,
} from './workState';
import {
    isCodexRateLimitSnapshotExhausted,
    readCodexRateLimitPlanType,
    readEarliestCodexRateLimitResetAtMs,
} from './rateLimitSnapshot';
import { mapCodexRateLimitResetCreditsToQuotaRecoveryCredits } from '../quota/codexQuotaRecoveryCredits';
import { fetchCodexRateLimitResetCredits } from '../quota/codexRateLimitResetCreditsClient';
import { buildCodexNativeReviewFindingsV2Payload } from '@/agent/reviews/normalize/codex/buildCodexNativeReviewFindingsV2Payload';
import { resolveCodexAppServerNativeReviewRequest } from './reviews/resolveCodexAppServerNativeReviewRequest';
import { createCodexAppServerSessionTurnTracker } from './turns/codexAppServerSessionTurnTracker';
import { CodexAppServerHistoryBoundary } from './codexAppServerHistoryBoundary';
import {
    classifyCodexConnectedServiceAuthFailure,
    isCodexProviderCapacityFailure,
    type CodexConnectedServiceRuntimeFailureClassification,
} from '../connectedServices/classifyCodexConnectedServiceAuthFailure';
import {
    readCodexLiveAccountIdentityFromClient,
    readCodexLiveAccountIdentity,
    type CodexLiveAccountIdentity,
} from '../connectedServices/codexLiveAccountIdentity';
import type { CodexChatGptTokensRefreshBridgeResponse } from '../connectedServices/refreshCodexChatGptTokensForBridge';
import type { CodexConnectedServiceAppliedIdentity } from '../connectedServices/runtimeAppliedIdentity';
import { applyCodexConnectedServiceAuthGeneration } from '../connectedServices/applyCodexConnectedServiceAuthGeneration';
import { writeCodexAuthStoreFile } from '../connectedServices/writeCodexAuthStoreFile';
import type {
    CodexConnectedServiceRefreshSelection,
    CodexConnectedServiceRuntimeIdentitySeed,
} from '../connectedServices/authApplication/types';
import {
    parseCodexConnectedServiceRuntimeAuthApplyRequest,
} from '../connectedServices/codexConnectedServiceRuntimeAuthContract';
import {
    resolveConnectedServiceRuntimeAuthContextFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { resolveOpenAiCodexDaemonRefreshSelection } from '../connectedServices/resolveOpenAiCodexDaemonRefreshSelection';
import {
    UsageLimitRecoveryScheduler,
    type UsageLimitRecoveryIntentStore,
} from '@/daemon/connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import {
    resolveCodexUsageLimitSwitchProgress,
    type CodexUsageLimitSwitchAttemptStatus,
} from './recovery/resolveCodexUsageLimitSwitchProgress';
import { resolveCodexUsageLimitProbeFailureWait } from './recovery/resolveCodexUsageLimitProbeFailureWait';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';
import { deriveUsageLimitRecoveryTiming } from '@/session/usageLimitRecoveryControls/deriveUsageLimitRecoveryTiming';
import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';
import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { isCommittedRuntimeAuthRecoveryDisposition } from '@/daemon/connectedServices/runtimeAuth/resolveRuntimeAuthRecoveryCommitDisposition';

type CodexAppServerStartOrLoadOptions = Readonly<{
    resumeId?: string | null;
    existingSessionId?: string | null;
    /** A matching machine-local native-return record requires exact identity acceptance. */
    strictNativeResumeIdentity?: boolean;
    importHistory?: boolean;
    initialGoal?: SessionInitialGoalRequestV1 | null;
}>;

/** The app server explicitly named a different thread for the requested resume. */
export class CodexAppServerResumeIdentityMismatchError extends Error {
    readonly code = 'codex_app_server_resume_identity_mismatch';
    readonly happierNativeResumeIdentityMismatch = true;

    constructor(
        readonly requestedThreadId: string,
        readonly observedThreadId: string,
    ) {
        super('Codex resumed a different provider thread than requested.');
        this.name = 'CodexAppServerResumeIdentityMismatchError';
    }
}

type CodexAppServerThreadResponse = Readonly<{
    threadId?: unknown;
    id?: unknown;
    thread?: Readonly<{ id?: unknown; threadId?: unknown }> | null;
}>;

type CodexAppServerTurnResponse = Readonly<{
    turnId?: unknown;
    id?: unknown;
    turn?: Readonly<{ id?: unknown; turnId?: unknown }> | null;
}>;

type CodexRateLimitSnapshotPublishContext = CodexLiveAccountIdentity & Readonly<{
    rawResetCredits?: unknown;
    appliedIdentity?: CodexConnectedServiceAppliedIdentity;
    policyDisposition?: 'evidence_only';
}>;

type CodexConnectedServiceRuntimeAppliedIdentitySource =
    CodexConnectedServiceRuntimeIdentitySeed['source'] | 'live_account_read' | 'token_refresh';

type CodexConnectedServiceRuntimeAppliedIdentity = Readonly<{
    serviceId: 'openai-codex';
    activeAccountId: string;
    accountLabel: string | null;
    profileId: string;
    groupId?: string;
    generation?: string | number;
    credentialRevision?: import('@happier-dev/protocol').ConnectedServiceCredentialRevisionV1 | null;
    credentialFingerprint: string | null;
    source: CodexConnectedServiceRuntimeAppliedIdentitySource;
}>;

class CodexConnectedServiceAuthGroupUnavailableError extends Error {
    readonly code = 'connected_service_auth_group_unavailable';

    constructor(readonly groupId: string, readonly unavailableReason: string) {
        super('connected_service_auth_group_unavailable');
        this.name = 'CodexConnectedServiceAuthGroupUnavailableError';
    }
}

type CodexConnectedServiceAuthApplyGenerationResult = SessionConnectedServiceAuthApplyGenerationResponseV1;
type CodexConnectedServiceAuthReadRuntimeIdentityResult = SessionConnectedServiceAuthReadRuntimeIdentityResponseV1;

type UnsupportedSessionRuntimeMethodResult = Readonly<{
    ok: false;
    errorCode: 'unsupported_session_runtime_method';
    error: string;
}>;

const CODEX_REVIEW_COMMAND = '/codex.review';

type GoalControlNotFoundResult = Readonly<{
    ok: false;
    errorCode: 'goal_not_found';
    error: string;
}>;

type InvalidGoalStatusResult = Readonly<{
    ok: false;
    errorCode: 'invalid_goal_status';
    error: 'invalid_goal_status';
}>;

function unsupportedSessionRuntimeMethod(method: string): UnsupportedSessionRuntimeMethodResult {
    return {
        ok: false,
        errorCode: 'unsupported_session_runtime_method',
        error: `unsupported_session_runtime_method:${method}`,
    };
}

function invalidGoalStatus(): InvalidGoalStatusResult {
    return { ok: false, errorCode: 'invalid_goal_status', error: 'invalid_goal_status' };
}

function normalizeNativeGoalSetStatus(status: string | undefined): 'active' | 'paused' | 'complete' | undefined | null {
    if (status === undefined) return undefined;
    const trimmed = status.trim();
    if (!trimmed) return undefined;
    if (trimmed === 'active' || trimmed === 'paused' || trimmed === 'complete') return trimmed;
    return null;
}

function parseCodexReviewCommand(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (trimmed !== CODEX_REVIEW_COMMAND && !trimmed.startsWith(`${CODEX_REVIEW_COMMAND} `)) {
        return null;
    }
    return {
        engineIds: ['codex'],
        instructions: trimmed.slice(CODEX_REVIEW_COMMAND.length).trim(),
        runLocation: 'current_session',
        changeType: 'uncommitted',
        base: { kind: 'none' },
    };
}

function isCodexAppServerGoalMethodUnavailableError(error: unknown, appServerMethod: string): boolean {
    return isCodexAppServerMethodNotFoundError(error)
        || isCodexAppServerInvalidParamsError(error)
        || isCodexAppServerInvalidRequestForMethodError(error, appServerMethod);
}

function isCodexAppServerReviewStartUnavailableError(error: unknown): boolean {
    if (isCodexAppServerMethodNotFoundError(error)) return true;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /review\/start/i.test(message) && /method\s+(unavailable|unsupported)/i.test(message);
}

type PendingTurn = Readonly<{
    threadId: string;
    turnId: string | null;
    providerPrompt: CodexAppServerPendingProviderPrompt | null;
    connectedServiceRuntimeIdentityAtStart: CodexConnectedServiceRuntimeAppliedIdentity | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}>;

type DeferredUnacknowledgedTerminalNotification = Readonly<{
    ownerPromise: Promise<void>;
    method: string;
    notificationParams: unknown;
    terminalTurnId: string;
}>;

type StreamUpdateContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

const BLOCKING_CODEX_APP_SERVER_ITEM_TYPES = new Set([
    'commandexecution',
    'filechange',
    'mcptoolcall',
]);
const MAX_DEFERRED_UNACKNOWLEDGED_TERMINAL_NOTIFICATIONS = 32;
const CODEX_APP_SERVER_TERMINAL_BLOCKING_ITEM_DRAIN_MS = 100;

type PendingRawAssistantFinal = Readonly<{
    text: string;
    sidechainId: string | null;
    streamScopeId: string;
    itemId: string | null;
}>;

const CODEX_TRANSCRIPT_INITIAL_CHECKPOINT_DELAY_MS = 0;

type CodexAppServerPermissionSupport = 'unknown' | 'supported' | 'legacy';

type CodexAppServerPromptOptions = Readonly<{
    metadata?: unknown;
    localId?: string | null;
    localIds?: readonly string[] | null;
    trustedLocalImagePaths?: ReadonlySet<string>;
    userMessageSeq?: number | null;
    appliedModelId?: string | null;
    onProviderPromptAccepted?: () => void;
}>;

type CodexAppServerPromptAcceptedCallback = (input: Readonly<{
    localIds?: readonly string[] | null;
    userMessageSeq: number | null;
    providerTurnId: string;
    appliedModelId?: string;
}>) => void;

type CodexAppServerUndeliverablePrompt = Readonly<{
    localIds?: readonly string[] | null;
    text: string;
    userMessageSeq: number | null;
}>;

type CodexAppServerPendingProviderPrompt = CodexAppServerUndeliverablePrompt & {
    accepted: boolean;
    appliedModelId?: string;
};

type CodexAppServerUndeliverablePromptsCallback = (
    prompts: ReadonlyArray<CodexAppServerUndeliverablePrompt>,
) => void;

function normalizeCodexAppServerPromptLocalIds(options: CodexAppServerPromptOptions | undefined): string[] {
    const values = [
        ...(typeof options?.localId === 'string' ? [options.localId] : []),
        ...(options?.localIds ?? []),
    ];
    const seen = new Set<string>();
    const localIds: string[] = [];
    for (const value of values) {
        const localId = readPendingLocalId(value);
        if (localId === null || seen.has(localId)) continue;
        seen.add(localId);
        localIds.push(localId);
    }
    return localIds;
}

function assertCodexAppServerPendingIdentity(options: CodexAppServerPromptOptions | undefined): void {
    const supplied = [
        ...(options?.localId === undefined || options.localId === null ? [] : [options.localId]),
        ...(options?.localIds ?? []),
    ];
    if (supplied.length === 0) return;
    const localIds = normalizeCodexAppServerPromptLocalIds(options);
    if (localIds.length !== 1 || supplied.length !== 1) {
        throw new Error('Pending localId must not be blank and must identify exactly one input');
    }
}

function codexAppServerPromptLocalIdPayload(localIds: readonly string[] | null | undefined): {
    localIds?: readonly string[];
} {
    return localIds && localIds.length > 0 ? { localIds } : {};
}

function codexAppServerPromptHasDeliveryIdentity(
    prompt: Pick<CodexAppServerPendingProviderPrompt, 'localIds' | 'userMessageSeq'>,
): boolean {
    return (prompt.localIds?.length ?? 0) > 0 || prompt.userMessageSeq !== null;
}

function buildCodexAppServerRetryDeliveryIdentityOptions(
    pending: CodexAppServerPendingProviderPrompt | null | undefined,
): CodexAppServerPromptOptions | undefined {
    if (!pending || pending.accepted || !codexAppServerPromptHasDeliveryIdentity(pending)) {
        return undefined;
    }
    return {
        ...codexAppServerPromptLocalIdPayload(pending.localIds),
        ...(pending.userMessageSeq === null ? {} : { userMessageSeq: pending.userMessageSeq }),
    };
}

async function buildCodexTurnInputForPrompt(
    prompt: string,
    cwd: string,
    options?: CodexAppServerPromptOptions,
): Promise<CodexAppServerTurnInputItem[]> {
    const trustedLocalImagePaths = options?.trustedLocalImagePaths
        ?? (options?.metadata
            ? await resolveTrustedSessionAttachmentLocalImagePaths({
                cwd,
                metadata: options.metadata,
            })
            : undefined);
    return buildCodexAppServerTurnInput({
        text: prompt,
        metadata: options?.metadata,
        trustedLocalImagePaths,
    });
}

export type CodexAppServerReviewTarget =
    | Readonly<{ type: 'uncommittedChanges' }>
    | Readonly<{ type: 'baseBranch'; branch: string }>
    | Readonly<{ type: 'commit'; sha: string; title?: string }>
    | Readonly<{ type: 'custom'; instructions: string }>
    | Readonly<Record<string, unknown>>;

export type CodexAppServerReviewStartRequest = Readonly<{
    target: CodexAppServerReviewTarget;
    delivery?: 'inline' | 'detached';
}>;

type PermissionHandlerSubset = Readonly<{
    handleToolCall: (toolCallId: string, toolName: string, input: unknown) => Promise<PermissionResult>;
}>;

type RuntimeSession = ApiSessionClient;
type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;
type RuntimeSessionMediaSource = RuntimeSessionMediaMessage['media'][number];
type RuntimeSessionMediaPersistResult = SessionMediaPersistResult;

function readLastObservedMessageSeq(session: RuntimeSession): number {
    const raw = typeof session.getLastObservedMessageSeq === 'function'
        ? session.getLastObservedMessageSeq()
        : 0;
    return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function readUsageLimitRecoveryIntentFromMetadata(session: RuntimeSession): unknown {
    const metadata = typeof session.getMetadataSnapshot === 'function' ? session.getMetadataSnapshot() : null;
    if (!metadata || typeof metadata !== 'object') return null;
    return (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] ?? null;
}

export async function writeUsageLimitRecoveryIntentToMetadata(
    session: RuntimeSession,
    intent: SessionUsageLimitRecoveryV1,
): Promise<void> {
    await session.updateMetadata((metadata) => mergeUsageLimitRecoveryFieldIntoMetadata({
        latestMetadata: metadata,
        baseMetadata: metadata,
        candidateMetadata: {
            [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent,
        },
    }) as Metadata);
}

function createCodexUsageLimitRecoveryIntentStore(session: RuntimeSession): UsageLimitRecoveryIntentStore {
    return {
        read: () => readUsageLimitRecoveryIntentFromMetadata(session),
        write: async (_sessionId, intent) => {
            await writeUsageLimitRecoveryIntentToMetadata(session, intent);
        },
        merge: async (_sessionId, next, merge) => {
            let committed: SessionUsageLimitRecoveryV1 | null = null;
            let updaterRan = false;
            await session.updateMetadata((latestMetadata) => {
                const parsedCurrent = SessionUsageLimitRecoveryV1Schema.safeParse(
                    (latestMetadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
                );
                committed = merge(parsedCurrent.success ? parsedCurrent.data : null, next);
                updaterRan = true;
                if (committed) {
                    return {
                        ...latestMetadata,
                        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: committed,
                    } as Metadata;
                }
                const withoutRecovery = { ...latestMetadata } as Record<string, unknown>;
                delete withoutRecovery[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
                return withoutRecovery as Metadata;
            });
            if (!updaterRan) throw new Error('usage_limit_recovery_metadata_transaction_not_applied');
            return committed;
        },
    };
}

function readFiniteNumber(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

type CodexUsageLimitGroupRecoveryOutcome = ConnectedServiceRuntimeAuthFailureDaemonReport;

function readSwitchAttemptResult(value: CodexUsageLimitGroupRecoveryOutcome): Record<string, unknown> | null {
    const envelope = readRecord(value.report);
    const outer = readRecord(envelope?.result);
    if (outer?.status !== 'switch_attempted') return null;
    return readRecord(outer.result);
}

function readSwitchAttemptVerificationStatus(
    switchAttemptResult: Record<string, unknown> | null,
    serviceId: string,
): 'verified' | 'weakly_verified' | null {
    const verificationByServiceId = readRecord(switchAttemptResult?.verificationByServiceId);
    const verification = readRecord(verificationByServiceId?.[serviceId]);
    return verification?.status === 'verified' || verification?.status === 'weakly_verified'
        ? verification.status
        : null;
}

function buildUsageLimitIssueFingerprint(issue: SessionRuntimeIssueV1): string {
    return [
        'usage-limit',
        issue.provider ?? 'codex',
        issue.providerTurnId ?? 'unknown-turn',
        String(issue.occurredAt),
        issue.usageLimit?.resetAtMs === null || issue.usageLimit?.resetAtMs === undefined
            ? 'no-reset'
            : String(issue.usageLimit.resetAtMs),
    ].join(':');
}

function deriveCodexUsageLimitRecoveryTiming(issue: SessionRuntimeIssueV1): ReturnType<typeof deriveUsageLimitRecoveryTiming> {
    return deriveUsageLimitRecoveryTiming({
        occurredAtMs: issue.occurredAt,
        resetAtMs: issue.usageLimit?.resetAtMs,
        retryAfterMs: issue.usageLimit?.retryAfterMs,
    });
}

function resolveUsageLimitRecoveryAuthSelection(input: Readonly<{
    runtimeEnv: Pick<NodeJS.ProcessEnv, string>;
    usageLimit: SessionRuntimeUsageLimitDetailsV1;
}>): SessionUsageLimitRecoveryAuthSelectionV1 {
    const connectedService = input.usageLimit.connectedService;
    if (connectedService?.groupId && connectedService.profileId) {
        return {
            kind: 'group',
            serviceId: connectedService.serviceId,
            groupId: connectedService.groupId,
            profileId: connectedService.profileId,
        };
    }
    if (connectedService?.profileId) {
        return {
            kind: 'profile',
            serviceId: connectedService.serviceId,
            profileId: connectedService.profileId,
        };
    }

    const runtimeContext = resolveConnectedServiceRuntimeAuthContextFromEnv(input.runtimeEnv, 'openai-codex');
    if (runtimeContext.groupId && runtimeContext.profileId) {
        return {
            kind: 'group',
            serviceId: runtimeContext.serviceId,
            groupId: runtimeContext.groupId,
            profileId: runtimeContext.profileId,
        };
    }
    if (runtimeContext.profileId) {
        return {
            kind: 'profile',
            serviceId: runtimeContext.serviceId,
            profileId: runtimeContext.profileId,
        };
    }
    return { kind: 'native', serviceId: 'openai-codex' };
}

function shouldAutoArmUsageLimitRecovery(): boolean {
    return getActiveAccountSettingsSnapshot()?.settings?.usageLimitRecoverySettingsV1?.mode === 'auto_wait';
}

function readThreadId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as CodexAppServerThreadResponse;
    const candidates = [response.threadId, response.id, response.thread?.threadId, response.thread?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

function readTurnId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as CodexAppServerTurnResponse;
    const candidates = [response.turnId, response.id, response.turn?.turnId, response.turn?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

function readProviderEventTurnId(
    value: unknown,
    options?: Readonly<{ allowTopLevelId?: boolean }>,
): string | null {
    const record = readRecord(value);
    if (!record) return null;
    const turn = readRecord(record.turn);
    const candidates = [
        record.turnId,
        record.turn_id,
        turn?.turnId,
        turn?.turn_id,
        turn?.id,
        options?.allowTopLevelId === true ? readTopLevelProviderTurnId(record) : null,
    ];
    for (const candidate of candidates) {
        const turnId = trimStringValue(candidate);
        if (turnId) return turnId;
    }
    return null;
}

function readTopLevelProviderTurnId(record: Record<string, unknown>): string | null {
    const hasTopLevelItemIdentity = Boolean(
        readRecord(record.item)
        || trimStringValue(record.itemId)
        || trimStringValue(record.item_id)
        || trimStringValue(record.callId)
        || trimStringValue(record.call_id)
        || trimStringValue(record.type),
    );
    return hasTopLevelItemIdentity ? null : trimStringValue(record.id);
}

function readProviderEventItemRecord(value: unknown): Record<string, unknown> | null {
    const record = readRecord(value);
    if (!record) return null;
    return readRecord(record.item) ?? record;
}

function readProviderEventItemId(value: unknown): string | null {
    const item = readProviderEventItemRecord(value);
    if (!item) return null;
    const candidates = [
        item.itemId,
        item.item_id,
        item.id,
        item.callId,
        item.call_id,
    ];
    for (const candidate of candidates) {
        const itemId = trimStringValue(candidate);
        if (itemId) return itemId;
    }
    return null;
}

function readNormalizedProviderEventItemType(value: unknown): string | null {
    const item = readProviderEventItemRecord(value);
    const rawType = item ? trimStringValue(item.type) ?? trimStringValue(item.itemType) ?? trimStringValue(item.item_type) : null;
    if (!rawType) return null;
    const normalized = rawType.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

function readProviderUserMessageClientId(value: unknown): string | null {
    if (readNormalizedProviderEventItemType(value) !== 'usermessage') return null;
    const item = readProviderEventItemRecord(value);
    if (!item) return null;
    return readPendingLocalId(item.clientId) ?? readPendingLocalId(item.client_id);
}

function isBlockingCodexAppServerItemStart(value: unknown): boolean {
    const itemId = readProviderEventItemId(value);
    if (!itemId) return false;
    const itemType = readNormalizedProviderEventItemType(value);
    return itemType !== null && BLOCKING_CODEX_APP_SERVER_ITEM_TYPES.has(itemType);
}

function trimSessionId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function trimStringValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readHappierTitleToolTitle(input: unknown): string | null {
    const record = readRecord(input);
    return record ? trimStringValue(record.title) : null;
}

function readMcpContentTextPayloads(record: Record<string, unknown>): unknown[] {
    const content = Array.isArray(record.content) ? record.content : [];
    const parsed: unknown[] = [];
    for (const entry of content) {
        const entryRecord = readRecord(entry);
        const text = entryRecord ? trimStringValue(entryRecord.text) : null;
        if (!text) continue;
        try {
            parsed.push(JSON.parse(text));
        } catch {
            // Ignore non-JSON MCP text payloads.
        }
    }
    return parsed;
}

function didHappierTitleToolSucceed(output: unknown, depth = 0): boolean {
    if (depth > 2) return false;
    const record = readRecord(output);
    if (!record) return false;
    if (record.success === true || record.ok === true) return true;
    if (record.isError === true) return false;
    return readMcpContentTextPayloads(record).some((payload) => didHappierTitleToolSucceed(payload, depth + 1));
}

function readRollbackUnsupportedErrorMessage(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    const message = error.message.trim();
    if (message.length === 0) return null;
    const normalized = message.toLowerCase();
    if (normalized.includes('method not found') || normalized.includes('invalid params')) {
        return message;
    }
    return null;
}

function isNoActiveTurnToInterruptError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /no\s+active\s+turn\s+to\s+interrupt/i.test(error.message);
}

const CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_WINDOW_MS = 1_000;
const CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_INTERVAL_MS = 50;

async function waitForPromiseSettlementWithin(
    promise: Promise<unknown>,
    timeoutMs: number,
): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        void promise.then(
            () => finish(true),
            () => finish(true),
        );
    });
}

async function requestCodexTurnInterruptWithStartupRetry(params: Readonly<{
    client: DisposableCodexAppServerClient;
    threadId: string;
    turnId: string;
    waitForProviderTerminal: (waitKind: 'startup_gap' | 'ambiguous_request') => Promise<boolean>;
}>): Promise<'requested' | 'providerTerminal'> {
    const startedAtMs = Date.now();
    for (;;) {
        try {
            await params.client.request('turn/interrupt', {
                threadId: params.threadId,
                turnId: params.turnId,
            });
            return 'requested';
        } catch (error) {
            const startupGap = isNoActiveTurnToInterruptError(error);
            if (await params.waitForProviderTerminal(startupGap ? 'startup_gap' : 'ambiguous_request')) {
                return 'providerTerminal';
            }
            if (!startupGap) throw error;
            if (Date.now() - startedAtMs >= CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_WINDOW_MS) {
                throw error;
            }
        }
    }
}

function readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function mergeSparseCodexSnapshotUpdate(previous: unknown, next: unknown): unknown {
    const previousRecord = readRecord(previous);
    const nextRecord = readRecord(next);
    if (!previousRecord || !nextRecord) return next;
    const merged: Record<string, unknown> = { ...previousRecord };
    for (const [key, value] of Object.entries(nextRecord)) {
        const previousValue = previousRecord[key];
        if (readRecord(previousValue) && readRecord(value)) {
            merged[key] = mergeSparseCodexSnapshotUpdate(previousValue, value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

const CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE =
    'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
// Emitted ONLY when Happier intentionally invalidates the connected-service auth transports to
// apply an account switch (NOT on the real native account-changed error, which defers to the
// prompt loop). The copy must describe the deliberate switch/restart, never "refused to continue".
const CODEX_APP_SERVER_CONNECTED_SERVICE_SWITCH_RESTART_STATUS_MESSAGE =
    'Happier is applying a connected-service account switch and restarting the Codex runtime...';
const CODEX_APP_SERVER_CONTEXT_WINDOW_EXHAUSTED_MESSAGE_MARKERS = [
    'codex ran out of room',
    'context window',
] as const;
const CODEX_CONTEXT_WINDOW_RECOVERY_MODE_ENV_KEY = 'HAPPIER_CODEX_CONTEXT_WINDOW_RECOVERY_MODE';
const CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT_ENV_KEY = 'HAPPIER_CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT';
const CODEX_CONTEXT_WINDOW_RECOVERY_CONTINUATION_PROMPT =
    'Please continue the interrupted work from the compacted Codex context. Do not restart or repeat completed work.';

type CodexAppServerContextWindowRecoveryMode = RecoverableTurnFailurePromptMode;

type CodexAppServerContextWindowRecoveryConfig = Readonly<{
    mode: CodexAppServerContextWindowRecoveryMode;
    continuationPrompt: string;
}>;

type CodexAppServerErrorPayload = Readonly<{
    message: string | null;
    additionalDetails: string | null;
    codexErrorInfo: string | null;
}>;

class CodexAppServerTurnFailure extends Error {
    readonly isAuthAccountChanged: boolean;
    readonly isContextWindowExhausted: boolean;
    readonly isTemporaryRecoverableTurnFailure: boolean;
    readonly runtimeAuthClassification: CodexConnectedServiceRuntimeFailureClassification | null;

    constructor(message: string, options: Readonly<{
        isAuthAccountChanged: boolean;
        isContextWindowExhausted: boolean;
        isTemporaryRecoverableTurnFailure: boolean;
        runtimeAuthClassification: CodexConnectedServiceRuntimeFailureClassification | null;
    }>) {
        super(message);
        this.name = 'CodexAppServerTurnFailure';
        this.isAuthAccountChanged = options.isAuthAccountChanged;
        this.isContextWindowExhausted = options.isContextWindowExhausted;
        this.isTemporaryRecoverableTurnFailure = options.isTemporaryRecoverableTurnFailure;
        this.runtimeAuthClassification = options.runtimeAuthClassification;
    }
}

class CodexAppServerConnectedServiceAuthTransportInvalidatedTurn extends Error {
    constructor() {
        super('Codex app-server connected-service auth transport invalidated the active turn');
        this.name = 'CodexAppServerConnectedServiceAuthTransportInvalidatedTurn';
    }
}

function isCodexAppServerConnectedServiceAuthTransportInvalidatedTurn(
    error: unknown,
): error is CodexAppServerConnectedServiceAuthTransportInvalidatedTurn {
    return error instanceof CodexAppServerConnectedServiceAuthTransportInvalidatedTurn;
}

function readModelId(value: unknown): string | null {
    const record = readRecord(value);
    return record ? trimStringValue(record.model) : null;
}

function readServiceTier(value: unknown): string | null {
    const record = readRecord(value);
    if (!record) return null;
    const serviceTier = trimStringValue(record.serviceTier) ?? trimStringValue(record.service_tier);
    return isCodexAppServerFastServiceTier(serviceTier) ? 'fast' : serviceTier;
}

function readNonNegativeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null;
    }
    return Math.trunc(value);
}

function readCodexRuntimeContextWindowTokens(value: unknown): number | null {
    const record = readRecord(value);
    if (!record) return null;

    const direct = readNonNegativeInteger(record.modelContextWindow ?? record.model_context_window);
    if (direct !== null) return direct;

    const turn = readRecord(record.turn);
    return readNonNegativeInteger(turn?.modelContextWindow ?? turn?.model_context_window);
}

function readCodexTurnStatus(value: unknown): string | null {
    const record = readRecord(value);
    const turn = readRecord(record?.turn);
    return trimStringValue(turn?.status) ?? trimStringValue(record?.status);
}

function isCodexTurnInterruptedStatus(status: string | null): boolean {
    return status === 'interrupted'
        || status === 'cancelled'
        || status === 'canceled'
        || status === 'aborted';
}

function readCodexAppServerErrorPayload(value: unknown): CodexAppServerErrorPayload | null {
    const record = readRecord(value);
    if (!record) return null;

    const directError = readRecord(record.error);
    const turn = readRecord(record.turn);
    const turnError = readRecord(turn?.error);
    const error = directError ?? turnError;
    if (!error) return null;

    return {
        message: trimStringValue(error.message),
        additionalDetails: trimStringValue(error.additionalDetails ?? error.additional_details),
        codexErrorInfo: trimStringValue(error.codexErrorInfo ?? error.codex_error_info),
    };
}

function formatCodexAppServerErrorPayloadMessage(payload: CodexAppServerErrorPayload): string | null {
    if (payload.message && payload.additionalDetails) {
        return `${payload.message}\n\n${payload.additionalDetails}`;
    }
    return payload.message ?? payload.additionalDetails;
}

function isCodexAppServerAuthAccountChangedPayload(payload: CodexAppServerErrorPayload): boolean {
    const codexErrorInfo = payload.codexErrorInfo?.toLowerCase() ?? null;
    const hasAuthAccountChangedMessage = [payload.message, payload.additionalDetails].some((value) =>
        value?.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE),
    );
    return hasAuthAccountChangedMessage && (!codexErrorInfo || codexErrorInfo === 'unauthorized');
}

function isCodexAppServerAuthAccountChangedError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isAuthAccountChanged;
    }
    if (!(error instanceof Error)) return false;
    return error.message.includes(CODEX_APP_SERVER_AUTH_ACCOUNT_CHANGED_MESSAGE);
}

function normalizeCodexErrorInfo(value: string | null): string | null {
    return value ? value.replace(/[_\-\s]/g, '').toLowerCase() : null;
}

function textMatchesCodexContextWindowExhaustedMessage(value: string | null): boolean {
    const normalized = value?.toLowerCase() ?? '';
    return CODEX_APP_SERVER_CONTEXT_WINDOW_EXHAUSTED_MESSAGE_MARKERS.every((marker) => normalized.includes(marker));
}

function isCodexAppServerContextWindowExhaustedPayload(payload: CodexAppServerErrorPayload): boolean {
    return normalizeCodexErrorInfo(payload.codexErrorInfo) === 'contextwindowexceeded'
        || [payload.message, payload.additionalDetails].some(textMatchesCodexContextWindowExhaustedMessage);
}

function isCodexAppServerContextWindowExhaustedError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isContextWindowExhausted;
    }
    if (!(error instanceof Error)) return false;
    return textMatchesCodexContextWindowExhaustedMessage(error.message);
}

function isCodexAppServerTemporaryRecoverableTurnFailureError(error: unknown): boolean {
    if (error instanceof CodexAppServerTurnFailure) {
        return error.isTemporaryRecoverableTurnFailure;
    }
    if (!(error instanceof Error)) return false;
    return isCodexProviderCapacityFailure(error);
}

function shouldDeferCodexAppServerTurnFailureToPromptLoop(error: unknown): boolean {
    return isCodexAppServerAuthAccountChangedError(error)
        || isCodexAppServerContextWindowExhaustedError(error)
        || isCodexAppServerTemporaryRecoverableTurnFailureError(error);
}

function normalizeCodexContextWindowRecoveryMode(value: unknown): CodexAppServerContextWindowRecoveryMode | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/[\s-]+/g, '_').toLowerCase();
    if (normalized === 'activity_aware' || normalized === 'auto' || normalized === 'standard') return 'activity_aware';
    if (normalized === 'continue' || normalized === 'auto_continue') return 'continue';
    if (normalized === 'retry_original' || normalized === 'retry') return 'retry_original';
    if (normalized === 'off' || normalized === 'disabled' || normalized === 'disable') return 'off';
    return null;
}

function normalizeCodexContinuationPrompt(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function resolveCodexContextWindowRecoveryConfig(input: Readonly<{
    configured?: Readonly<{
        mode?: CodexAppServerContextWindowRecoveryMode | null;
        continuationPrompt?: string | null;
    }> | null;
    runtimeEnv: Pick<NodeJS.ProcessEnv, string>;
}>): CodexAppServerContextWindowRecoveryConfig {
    return {
        mode: normalizeCodexContextWindowRecoveryMode(input.configured?.mode)
            ?? normalizeCodexContextWindowRecoveryMode(input.runtimeEnv[CODEX_CONTEXT_WINDOW_RECOVERY_MODE_ENV_KEY])
            ?? 'activity_aware',
        continuationPrompt: normalizeCodexContinuationPrompt(input.configured?.continuationPrompt)
            ?? normalizeCodexContinuationPrompt(input.runtimeEnv[CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT_ENV_KEY])
            ?? CODEX_CONTEXT_WINDOW_RECOVERY_CONTINUATION_PROMPT,
    };
}

function isMeaningfulCodexContextWindowRecoveryActivity(update: CodexAppServerStreamUpdate): boolean {
    switch (update.type) {
        case 'context-compaction':
            return false;
        case 'assistant-text-delta':
        case 'assistant-text-final':
        case 'assistant-raw-final':
        case 'reasoning-delta':
        case 'reasoning-final':
            return update.text.trim().length > 0;
        case 'review-mode-started':
        case 'review-mode-completed':
            return true;
        case 'turn-diff-updated':
            return update.unifiedDiff.trim().length > 0;
        default:
            return true;
    }
}

function createCodexAppServerTurnFailure(
    value: unknown,
    sourceAccountIdentity?: Pick<
        CodexConnectedServiceRuntimeAppliedIdentity,
        'activeAccountId' | 'accountLabel' | 'profileId' | 'groupId' | 'generation' | 'credentialFingerprint'
        | 'credentialRevision'
    > | null,
): Error {
    const payload = readCodexAppServerErrorPayload(value);
    const runtimeAuthClassification = classifyCodexConnectedServiceAuthFailure({
        providerErrorPath: true,
        error: value,
        serviceId: 'openai-codex',
        profileId: sourceAccountIdentity?.profileId ?? null,
        groupId: sourceAccountIdentity?.groupId ?? null,
        sourceAccountIdentity: sourceAccountIdentity
            ? {
                providerAccountId: sourceAccountIdentity.activeAccountId,
                accountLabel: sourceAccountIdentity.accountLabel,
                groupGeneration: sourceAccountIdentity.generation,
                credentialRevision: sourceAccountIdentity.credentialRevision,
                credentialFingerprint: sourceAccountIdentity.credentialFingerprint,
            }
            : null,
    });
    return new CodexAppServerTurnFailure(
        payload ? formatCodexAppServerErrorPayloadMessage(payload) ?? 'Codex app-server turn failed' : 'Codex app-server turn failed',
        {
            isAuthAccountChanged: payload ? isCodexAppServerAuthAccountChangedPayload(payload) : false,
            isContextWindowExhausted: payload ? isCodexAppServerContextWindowExhaustedPayload(payload) : false,
            isTemporaryRecoverableTurnFailure: runtimeAuthClassification?.kind === 'capacity',
            runtimeAuthClassification,
        },
    );
}

function formatCodexAppServerErrorForUi(error: Error): string {
    const message = error.message.trim();
    if (!message) return 'Codex error';
    return /^error[:\s]/i.test(message) ? message : `Error: ${message}`;
}

function readCodexTokenUsageBreakdown(value: unknown): Record<string, number> | null {
    const record = readRecord(value);
    if (!record) return null;

    const total = readNonNegativeInteger(record.totalTokens ?? record.total_tokens);
    const input = readNonNegativeInteger(record.inputTokens ?? record.input_tokens);
    const cacheRead = readNonNegativeInteger(record.cachedInputTokens ?? record.cached_input_tokens);
    const output = readNonNegativeInteger(record.outputTokens ?? record.output_tokens);
    const thought = readNonNegativeInteger(record.reasoningOutputTokens ?? record.reasoning_output_tokens);

    const hasAnyPart = total !== null || input !== null || cacheRead !== null || output !== null || thought !== null;
    if (!hasAnyPart) return null;

    const tokens = Object.create(null) as Record<string, number>;
    tokens.total = total ?? ((input ?? 0) + (cacheRead ?? 0) + (output ?? 0) + (thought ?? 0));
    if (input !== null) tokens.input = input;
    if (cacheRead !== null) tokens.cache_read = cacheRead;
    if (output !== null) tokens.output = output;
    if (thought !== null) tokens.thought = thought;
    return tokens;
}

function buildThreadServiceTierParams(
    currentServiceTier: string | null,
    hasServiceTierOverride: boolean,
): { serviceTier?: 'fast' | null } {
    if (!hasServiceTierOverride) {
        return {};
    }
    return currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null };
}

function buildThreadConfigOverrideParams(
    currentReasoningEffort: string | null,
): { config?: Record<string, string> } {
    if (!currentReasoningEffort) {
        return {};
    }
    return {
        config: {
            model_reasoning_effort: currentReasoningEffort,
        },
    };
}

function createPendingTurn(
    threadId: string,
    options: Readonly<{
        providerPrompt?: CodexAppServerPendingProviderPrompt | null;
        connectedServiceRuntimeIdentityAtStart?: CodexConnectedServiceRuntimeAppliedIdentity | null;
    }> = {},
): PendingTurn {
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
    });
    return {
        threadId,
        turnId: null,
        providerPrompt: options.providerPrompt ?? null,
        connectedServiceRuntimeIdentityAtStart: options.connectedServiceRuntimeIdentityAtStart ?? null,
        promise,
        resolve: resolveTurn,
        reject: rejectTurn,
    };
}

export function createCodexAppServerRuntime(params: Readonly<{
    directory: string;
    activeServerDir?: string | null;
    daemonStatePath?: string | null;
    processEnv?: NodeJS.ProcessEnv;
    configOverrides?: ReadonlyArray<string>;
    contextWindowRecovery?: Readonly<{
        mode?: CodexAppServerContextWindowRecoveryMode | null;
        continuationPrompt?: string | null;
    }> | null;
    session: RuntimeSession;
    transcriptSession?: StreamedTranscriptWriterSession;
    onThinkingChange: (thinking: boolean) => void;
    permissionHandler?: PermissionHandlerSubset | null;
    getPermissionMode?: (() => PermissionMode) | null;
    permissionMode?: PermissionMode;
    pendingQueue?: Readonly<{
        drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
        pumpPendingWhileActive?: (opts: ActiveTurnPendingPumpOptions) => Promise<void>;
        shouldDrainPendingMessages?: () => boolean;
        maxPopPerWake?: number;
        drainAfterStartOrLoad?: boolean;
    }>;
    onInFlightSteerAvailabilityChange?: (available: boolean) => void;
    onRateLimitSnapshot?: (
        snapshot: unknown,
        context?: CodexRateLimitSnapshotPublishContext,
    ) => void | Promise<void>;
    onUsageLimitGroupRecovery?: (input: Readonly<{
        sessionId: string;
        classification: CodexConnectedServiceRuntimeFailureClassification;
    }>) => Promise<CodexUsageLimitGroupRecoveryOutcome> | CodexUsageLimitGroupRecoveryOutcome;
    initialConnectedServiceRuntimeIdentity?: CodexConnectedServiceRuntimeIdentitySeed | null;
    onChatGptAuthTokensRefresh?: (params: unknown) => Promise<CodexChatGptTokensRefreshBridgeResponse>;
    onConnectedServiceAuthGenerationApplied?: (params: Readonly<{
        selection: CodexConnectedServiceRefreshSelection;
    }>) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;
    sessionMedia?: Readonly<{
        persist: (message: RuntimeSessionMediaMessage) => Promise<RuntimeSessionMediaPersistResult> | RuntimeSessionMediaPersistResult;
    }>;
    rememberUsageLimitRecoveryPreference?: (() => Promise<void>) | null;
}>): Readonly<{
    getSessionId: () => string | null;
    getPublishedSessionId: () => string | null;
    supportsInFlightSteer: () => boolean;
    supportsInFlightConfigApply: () => boolean;
    canSteerPrompt: () => boolean;
    isTurnInFlight: () => boolean;
    hasActiveProviderTurn: () => boolean;
    beginTurn: () => void;
    cancel: () => Promise<void>;
    reset: () => Promise<void>;
    startOrLoad: (options: CodexAppServerStartOrLoadOptions) => Promise<void>;
    setSessionMode: (_mode: string) => Promise<void>;
    setSessionModel: (_model: string) => Promise<void>;
    setSessionConfigOption: (_key: string, _value: unknown) => Promise<void>;
    steerPrompt: (_prompt: string, _options?: CodexAppServerPromptOptions) => Promise<void>;
    compactContext: (_command: string) => Promise<void>;
    sendPrompt: (_prompt: string, _options?: CodexAppServerPromptOptions) => Promise<void>;
    setOnPromptAcceptedByProvider: (_callback: CodexAppServerPromptAcceptedCallback | null) => void;
    setOnUndeliverablePrompts: (_callback: CodexAppServerUndeliverablePromptsCallback | null) => void;
    startReview: (_request: CodexAppServerReviewStartRequest) => Promise<void | UnsupportedSessionRuntimeMethodResult>;
    startInlineReview: (_input: unknown) => Promise<Readonly<{ ok: true; reviewTurnId: string | null }> | UnsupportedSessionRuntimeMethodResult | Readonly<{ ok: false; errorCode: 'invalid_parameters' | 'inline_review_not_supported'; error: string }>>;
    handleUserMessage: (_request: Readonly<{
        text: string;
        localId?: string;
        meta: Record<string, unknown>;
    }>) => Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }>>;
    applyConnectedServiceAuthGeneration: (
        _request: Readonly<SessionConnectedServiceAuthApplyGenerationRequestV1>,
    ) => Promise<CodexConnectedServiceAuthApplyGenerationResult>;
    readConnectedServiceRuntimeIdentity: (
        _request: Readonly<SessionConnectedServiceAuthReadRuntimeIdentityRequestV1>,
    ) => Promise<CodexConnectedServiceAuthReadRuntimeIdentityResult>;
    invalidateConnectedServiceAuthTransports: () => Promise<Readonly<{ ok: true }> | UnsupportedSessionRuntimeMethodResult>;
    flushTurn: () => Promise<void>;
    setGoal: (_objective: string | undefined, _options?: Readonly<{ status?: string; tokenBudget?: number | null }>) => Promise<void | UnsupportedSessionRuntimeMethodResult | GoalControlNotFoundResult | InvalidGoalStatusResult>;
    clearGoal: () => Promise<void | UnsupportedSessionRuntimeMethodResult>;
    refreshGoal: () => Promise<void | UnsupportedSessionRuntimeMethodResult>;
    enableUsageLimitWaitResume: (_request: Readonly<{
        sessionId: string;
        issueFingerprint?: string;
        rememberPreference?: boolean;
        resumePromptMode?: 'standard' | 'off' | 'custom';
    }>) => Promise<Readonly<{ ok: true; recovery: unknown }> | UnsupportedSessionRuntimeMethodResult | Readonly<{ ok: false; errorCode: string; error: string }>>;
    cancelUsageLimitWaitResume: (_request: Readonly<{
        sessionId: string;
        issueFingerprint: string;
        armedAtMs: number;
        runtimeAuthRecoveryAttemptId?: string;
    }>) => Promise<Readonly<{ ok: true; recovery: unknown }> | Readonly<{ ok: false; errorCode: string; error: string }>>;
    checkUsageLimitRecoveryNow: (_request: Readonly<{
        sessionId: string;
        provider?: string;
        operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
        resumePromptMode?: 'standard' | 'off' | 'custom';
    }>) => Promise<Readonly<{ ok: true; status: string }> | UnsupportedSessionRuntimeMethodResult>;
    listVendorPlugins: (_options?: Readonly<{ cwd?: string }>) => ReturnType<typeof listCodexVendorPlugins>;
    listSkills: (_options?: Readonly<{ cwd?: string }>) => ReturnType<typeof listCodexAppServerSkills>;
    rollbackConversation: (request: SessionRollbackRpcParams) => Promise<SessionRollbackRpcResult>;
}> {
    const runtimeEnv = params.processEnv ?? process.env;
    const contextWindowRecoveryConfig = resolveCodexContextWindowRecoveryConfig({
        configured: params.contextWindowRecovery,
        runtimeEnv,
    });
    const lastPublishedThreadId: { value: string | null } = { value: null };
    let threadId: string | null = null;
    let turnInFlight = false;
    let thinking = false;
    let pendingTurn: PendingTurn | null = null;
    let latestPendingTurnId: string | null = null;
    let pendingTurnHasProviderAttributedActivity = false;
    const deferredUnacknowledgedTerminalNotifications = new Map<
        string,
        DeferredUnacknowledgedTerminalNotification
    >();
    const clearDeferredUnacknowledgedTerminalNotificationsForOwner = (ownerPromise: Promise<void>): void => {
        for (const [turnId, deferred] of deferredUnacknowledgedTerminalNotifications) {
            if (deferred.ownerPromise === ownerPromise) {
                deferredUnacknowledgedTerminalNotifications.delete(turnId);
            }
        }
    };
    const retainDeferredUnacknowledgedTerminalNotification = (
        deferred: DeferredUnacknowledgedTerminalNotification,
    ): void => {
        deferredUnacknowledgedTerminalNotifications.delete(deferred.terminalTurnId);
        deferredUnacknowledgedTerminalNotifications.set(deferred.terminalTurnId, deferred);
        while (
            deferredUnacknowledgedTerminalNotifications.size
            > MAX_DEFERRED_UNACKNOWLEDGED_TERMINAL_NOTIFICATIONS
        ) {
            const oldestTurnId = deferredUnacknowledgedTerminalNotifications.keys().next().value;
            if (typeof oldestTurnId !== 'string') break;
            deferredUnacknowledgedTerminalNotifications.delete(oldestTurnId);
        }
    };
    let clientLifecycleGeneration = 0;
    let nativeTurnHandoffBarrier: Promise<void> | null = null;
    const waitForNativeTurnHandoff = async (): Promise<void> => {
        while (nativeTurnHandoffBarrier) {
            await nativeTurnHandoffBarrier;
        }
    };
    let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;
    let connectedServiceAuthTransportInvalidationRecoveryPromise: Promise<void> | null = null;
    let currentModeId: string | null = null;
    let currentModelId: string | null = null;
    let currentReasoningEffort: string | null = null;
    let currentServiceTier: string | null = null;
    let hasServiceTierOverride = false;
    let pendingTurnStartSeqInclusive: number | null = null;
    let permissionSupport: CodexAppServerPermissionSupport = 'unknown';
    let lastRateLimitSnapshot: unknown = null;
    let onPromptAcceptedByProvider: CodexAppServerPromptAcceptedCallback | null = null;
    let onUndeliverablePrompts: CodexAppServerUndeliverablePromptsCallback | null = null;
    const pendingProviderPrompts = new Set<CodexAppServerPendingProviderPrompt>();
    const turnBoundaryTracker = createCodexAppServerSessionTurnTracker({
        session: params.session,
        getProviderThreadId: () => threadId,
        onMetadataWriteError: (error) => {
            logger.debug('[codex-app-server] Failed to publish session turn update (non-fatal)', error);
        },
    });
    let pendingTurnFinalizationTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTurnBlockingItemDrainTimer: ReturnType<typeof setTimeout> | null = null;
    let scheduledPendingTurnFlushReason: 'turn-end' | 'abort' | null = null;
    let activeTurnAcceptsSteer = false;
    let lastPublishedInFlightSteerAvailability: boolean | null = null;
    let activeTurnHasMeaningfulContextWindowRecoveryActivity = false;
    const activeProviderTurnItemIds = new Set<string>();
    let latestConnectedServiceRuntimeIdentity: CodexConnectedServiceRuntimeAppliedIdentity | null =
        params.initialConnectedServiceRuntimeIdentity ?? null;
    let unavailableConnectedServiceAuthGroup: Readonly<{
        groupId: string;
        unavailableReason: 'group_missing' | 'active_profile_missing';
    }> | null = null;
    const assertConnectedServiceAuthGroupAvailable = (): void => {
        if (!unavailableConnectedServiceAuthGroup) return;
        throw new CodexConnectedServiceAuthGroupUnavailableError(
            unavailableConnectedServiceAuthGroup.groupId,
            unavailableConnectedServiceAuthGroup.unavailableReason,
        );
    };
    const historyBoundary = new CodexAppServerHistoryBoundary();
    const streamEventBridge = createCodexAppServerStreamEventBridge();
    const turnChangeCollector = new TurnChangeSetCollector({
        provider: 'codex',
        snapshotUnifiedDiff: true,
    });
    const beginTurnChangeTracking = async (): Promise<void> => {
        turnChangeCollector.beginTurn();
    };
    const itemTranscriptBridge = createKeyedStreamedTranscriptBridge<{
        streamKey: string;
        sidechainId: string | null;
    }>({
        provider: 'codex',
        createSessionForStream: () => params.transcriptSession ?? params.session,
        initialCheckpointDelayMs: CODEX_TRANSCRIPT_INITIAL_CHECKPOINT_DELAY_MS,
    });
    const assistantTextByItemId = new Map<string, string>();
    const reasoningTextByItemId = new Map<string, string>();
    const latestAssistantItemIdByStreamScope = new Map<string, string>();

    const readLiveAccountIdentity = async (): Promise<CodexLiveAccountIdentity> => {
        const client = await ensureClient();
        return await readCodexLiveAccountIdentityFromClient({
            request: async (_method, params, options) => await client.request('account/read', params, options),
        }, { timeoutMs: null });
    };

    const verifyLiveAccountAgainstAppliedIdentity = (
        liveIdentity: CodexLiveAccountIdentity,
        appliedIdentity: CodexConnectedServiceRuntimeAppliedIdentity | null,
    ): CodexConnectedServiceRuntimeAppliedIdentity | null => {
        const activeAccountId = liveIdentity.activeAccountId?.trim();
        if (!appliedIdentity) return null;
        if (!activeAccountId) return appliedIdentity;
        if (activeAccountId !== appliedIdentity.activeAccountId) return null;
        return {
            ...appliedIdentity,
            accountLabel: liveIdentity.accountLabel ?? appliedIdentity.accountLabel,
            source: 'live_account_read',
        };
    };

    const runtimeIdentityMatchesRefreshSelection = (
        identity: CodexConnectedServiceRuntimeAppliedIdentity,
        refreshSelection: ReturnType<typeof resolveOpenAiCodexDaemonRefreshSelection>,
    ): boolean => {
        if (!refreshSelection) return true;
        const { selection } = refreshSelection;
        if (selection.kind === 'group') {
            return identity.profileId === selection.activeProfileId
                && identity.groupId === selection.groupId
                && String(identity.generation ?? '') === String(selection.generation);
        }
        return identity.profileId === selection.profileId
            && (identity.groupId ?? null) === refreshSelection.recoveryGroupId;
    };

    const refreshLiveAccountRuntimeIdentity = async (): Promise<CodexConnectedServiceRuntimeAppliedIdentity | null> => {
        const identityBeforeRead = latestConnectedServiceRuntimeIdentity;
        const liveIdentity = await readLiveAccountIdentity();
        if (latestConnectedServiceRuntimeIdentity !== identityBeforeRead) return null;
        const liveRuntimeIdentity = verifyLiveAccountAgainstAppliedIdentity(liveIdentity, identityBeforeRead);
        if (liveRuntimeIdentity) {
            latestConnectedServiceRuntimeIdentity = liveRuntimeIdentity;
        }
        return liveRuntimeIdentity;
    };

    const isProviderTurnInFlight = (): boolean => (
        turnInFlight
        || pendingTurn !== null
        || nativeTurnHandoffBarrier !== null
        || activeProviderTurnItemIds.size > 0
    );

    const readRateLimitResetCreditsRaw = async (): Promise<unknown | null> => {
        const tokens = readCodexEnvironmentAuthTokens(runtimeEnv);
        const accessToken = tokens.accessToken ?? tokens.idToken;
        if (!accessToken) return null;
        const result = await fetchCodexRateLimitResetCredits({
            accessToken,
            accountId: tokens.accountId,
        });
        return result.ok ? result.response : null;
    };

    const readRateLimitRecoveryCredits = async (): Promise<ReturnType<typeof mapCodexRateLimitResetCreditsToQuotaRecoveryCredits>> => {
        const rawResetCredits = await readRateLimitResetCreditsRaw();
        return mapCodexRateLimitResetCreditsToQuotaRecoveryCredits(rawResetCredits);
    };

    const buildQuotaAppliedIdentity = (
        identity: CodexConnectedServiceRuntimeAppliedIdentity,
    ): CodexConnectedServiceAppliedIdentity => {
        const numericGeneration = typeof identity.generation === 'string'
            ? Number(identity.generation)
            : identity.generation;
        return {
            serviceId: 'openai-codex',
            profileId: identity.profileId,
            groupId: identity.groupId ?? null,
            groupGeneration: typeof numericGeneration === 'number'
                && Number.isSafeInteger(numericGeneration)
                && numericGeneration >= 0
                ? numericGeneration
                : null,
            credentialRevision: identity.credentialRevision ?? null,
            activeAccountId: identity.activeAccountId,
            accountLabel: identity.accountLabel,
            credentialFingerprint: identity.credentialFingerprint,
            observedAtMs: Date.now(),
            source: identity.source,
        };
    };

    const publishRateLimitSnapshot = async (
        rawSnapshot: unknown,
        options?: Readonly<{
            mergeWithLast?: boolean;
            includeLiveAccountIdentity?: boolean;
            rawResetCredits?: unknown;
            operationIdentityAtStart?: CodexConnectedServiceRuntimeAppliedIdentity | null;
            policyDisposition?: 'evidence_only';
        }>,
    ): Promise<void> => {
        const snapshot = options?.mergeWithLast === true
            ? mergeSparseCodexSnapshotUpdate(lastRateLimitSnapshot, rawSnapshot)
            : rawSnapshot;
        lastRateLimitSnapshot = snapshot;
        let liveIdentity: CodexLiveAccountIdentity | null = null;
        const operationIdentity = options?.operationIdentityAtStart ?? null;
        let verifiedRuntimeIdentity = operationIdentity
            && latestConnectedServiceRuntimeIdentity === operationIdentity
            ? operationIdentity
            : null;
        if (options?.includeLiveAccountIdentity === true) {
            try {
                liveIdentity = await readLiveAccountIdentity();
                const liveRuntimeIdentity = operationIdentity
                    && latestConnectedServiceRuntimeIdentity === operationIdentity
                    ? verifyLiveAccountAgainstAppliedIdentity(liveIdentity, operationIdentity)
                    : null;
                verifiedRuntimeIdentity = liveRuntimeIdentity;
                if (liveRuntimeIdentity) {
                    latestConnectedServiceRuntimeIdentity = liveRuntimeIdentity;
                } else if (
                    operationIdentity
                    && latestConnectedServiceRuntimeIdentity === operationIdentity
                    && liveIdentity.activeAccountId?.trim()
                ) {
                    latestConnectedServiceRuntimeIdentity = null;
                }
            } catch (error) {
                verifiedRuntimeIdentity = null;
                logger.debug('[codex-app-server] Failed to read live account identity for rate-limit snapshot (non-fatal)', error);
            }
        }
        const runtimeIdentity = verifiedRuntimeIdentity;
        if (
            runtimeIdentity
            || options?.rawResetCredits !== undefined
        ) {
            await params.onRateLimitSnapshot?.(snapshot, {
                activeAccountId: runtimeIdentity?.activeAccountId ?? null,
                accountLabel: runtimeIdentity?.accountLabel ?? null,
                ...(runtimeIdentity ? { appliedIdentity: buildQuotaAppliedIdentity(runtimeIdentity) } : {}),
                ...(options?.rawResetCredits === undefined ? {} : { rawResetCredits: options.rawResetCredits ?? null }),
                ...(options?.policyDisposition ? { policyDisposition: options.policyDisposition } : {}),
            });
            return;
        }
        await params.onRateLimitSnapshot?.(snapshot, options?.rawResetCredits === undefined && !options?.policyDisposition
            ? undefined
            : {
                activeAccountId: null,
                accountLabel: null,
                ...(options?.rawResetCredits === undefined ? {} : { rawResetCredits: options.rawResetCredits }),
                ...(options?.policyDisposition ? { policyDisposition: options.policyDisposition } : {}),
            });
    };

    const trackPendingProviderPrompt = (
        text: string,
        options?: CodexAppServerPromptOptions,
    ): CodexAppServerPendingProviderPrompt => {
        const pending: CodexAppServerPendingProviderPrompt = {
            ...codexAppServerPromptLocalIdPayload(normalizeCodexAppServerPromptLocalIds(options)),
            text,
            userMessageSeq: typeof options?.userMessageSeq === 'number' ? options.userMessageSeq : null,
            accepted: false,
            ...(readNonBlankOpaqueIdentifier(options?.appliedModelId)
                ? { appliedModelId: readNonBlankOpaqueIdentifier(options?.appliedModelId)! }
                : {}),
        };
        pendingProviderPrompts.add(pending);
        return pending;
    };

    const markPendingProviderPromptAccepted = (
        pending: CodexAppServerPendingProviderPrompt | null | undefined,
        rawProviderTurnId: string | null | undefined,
    ): void => {
        if (!pending || !pendingProviderPrompts.has(pending)) return;
        pending.accepted = true;
        const providerTurnId = trimSessionId(rawProviderTurnId);
        if (!providerTurnId) return;
        pendingProviderPrompts.delete(pending);
        if (!codexAppServerPromptHasDeliveryIdentity(pending)) return;
        onPromptAcceptedByProvider?.({
            ...codexAppServerPromptLocalIdPayload(pending.localIds),
            userMessageSeq: pending.userMessageSeq,
            providerTurnId,
            ...(pending.appliedModelId ? { appliedModelId: pending.appliedModelId } : {}),
        });
    };

    const markCorrelatedProviderUserMessageAccepted = (
        notificationParams: unknown,
        rawProviderTurnId: string | null | undefined,
    ): void => {
        const clientUserMessageId = readProviderUserMessageClientId(notificationParams);
        if (!clientUserMessageId) return;
        const pending = Array.from(pendingProviderPrompts).find(
            (candidate) => candidate.localIds?.length === 1 && candidate.localIds[0] === clientUserMessageId,
        );
        markPendingProviderPromptAccepted(pending, rawProviderTurnId);
    };

    const clearPendingProviderPrompt = (pending: CodexAppServerPendingProviderPrompt | null | undefined): void => {
        if (!pending) return;
        pendingProviderPrompts.delete(pending);
    };

    const emitPendingProviderPromptAsUndeliverable = (
        pending: CodexAppServerPendingProviderPrompt | null | undefined,
    ): void => {
        if (!pending || pending.accepted || !pendingProviderPrompts.has(pending)) return;
        pendingProviderPrompts.delete(pending);
        onUndeliverablePrompts?.([{
            ...codexAppServerPromptLocalIdPayload(pending.localIds),
            text: pending.text,
            userMessageSeq: pending.userMessageSeq,
        }]);
    };

    const emitAllPendingProviderPromptsAsUndeliverable = (): void => {
        const prompts = Array.from(pendingProviderPrompts);
        pendingProviderPrompts.clear();
        const undeliverable = prompts
            .filter((pending) => !pending.accepted)
            .map((pending) => ({
                ...codexAppServerPromptLocalIdPayload(pending.localIds),
                text: pending.text,
                userMessageSeq: pending.userMessageSeq,
            }));
        if (undeliverable.length > 0) {
            onUndeliverablePrompts?.(undeliverable);
        }
    };
    const normalizedAssistantFinalItemKeys = new Set<string>();
    const nativeReviewCompletionTextByStreamScope = new Map<string, string>();
    const rawAssistantFinalByItemKey = new Map<string, PendingRawAssistantFinal>();
    const persistedMediaDedupeKeys = new Set<string>();
    let activeInlineReview = false;
    let latestUsageLimitIssue: SessionRuntimeIssueV1 | null = null;
    const usageLimitRecoveryScheduler = new UsageLimitRecoveryScheduler({
        nowMs: () => Date.now(),
        store: createCodexUsageLimitRecoveryIntentStore(params.session),
        recover: async (intent, _context) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                return { status: 'exhausted' as const, lastProbeError: 'codex_app_server_thread_not_started' };
            }
            const client = await ensureClient();
            const operationIdentityAtStart = latestConnectedServiceRuntimeIdentity;
            try {
                const rawSnapshot = await readCodexRateLimitsSnapshot({
                    request: async (_method, params) => await client.request('account/rateLimits/read', params),
                });
                const rawResetCredits = await readRateLimitResetCreditsRaw();
                const recoveryCredits = mapCodexRateLimitResetCreditsToQuotaRecoveryCredits(rawResetCredits)
                    ?? intent.recoveryCredits;
                await publishRateLimitSnapshot(rawSnapshot, {
                    includeLiveAccountIdentity: intent.selectedAuth.kind === 'group',
                    rawResetCredits,
                    operationIdentityAtStart,
                });
                if (isCodexRateLimitSnapshotExhausted(rawSnapshot)) {
                    const resetAtMs = readEarliestCodexRateLimitResetAtMs(rawSnapshot) ?? intent.nextCheckAtMs ?? intent.resetAtMs ?? null;
                    const nextCheckAtMs = resetAtMs ?? Date.now();
                    if (intent.selectedAuth.kind === 'group' && typeof params.onUsageLimitGroupRecovery === 'function') {
                        try {
                            const recoveryRequest = await params.onUsageLimitGroupRecovery({
                                sessionId: params.session.sessionId,
                                classification: {
                                    kind: 'usage_limit',
                                    serviceId: 'openai-codex',
                                    groupId: intent.selectedAuth.groupId,
                                    profileId: intent.selectedAuth.profileId,
                                    resetsAtMs: nextCheckAtMs,
                                    retryAfterMs: null,
                                    planType: readCodexRateLimitPlanType(rawSnapshot),
                                    rateLimits: rawSnapshot,
                                    source: 'provider_runtime_marker',
                                },
                            });
                            const switchAttemptResult = readSwitchAttemptResult(recoveryRequest);
                            const switchAttemptStatus = trimStringValue(switchAttemptResult?.status) as CodexUsageLimitSwitchAttemptStatus | null;
                            const selectedProfileId = trimStringValue(switchAttemptResult?.activeProfileId);
                            const progress = resolveCodexUsageLimitSwitchProgress({
                                switchAttemptStatus,
                                exhaustedProfileId: intent.selectedAuth.profileId,
                                selectedProfileId,
                                verificationStatus: readSwitchAttemptVerificationStatus(switchAttemptResult, 'openai-codex'),
                                resetAtMs,
                                nowMs: Date.now(),
                                fallbackNextCheckAtMs: nextCheckAtMs,
                                errorCode: trimStringValue(switchAttemptResult?.errorCode),
                            });
                            if (progress.kind === 'exhausted') {
                                return {
                                    status: 'exhausted' as const,
                                    lastProbeError: progress.reason,
                                    ...(recoveryCredits ? { recoveryCredits } : {}),
                                };
                            }
                            if (progress.kind === 'ready_to_try') {
                                // Exact application is enough to end the transition and let the
                                // ordinary Pending owner try the selected account. Pause this
                                // provider-owned recovery loop: it must not call thread/resume or
                                // manufacture provider activity merely to confirm recovery.
                                return {
                                    status: 'pause' as const,
                                    selectedAuth: {
                                        ...intent.selectedAuth,
                                        profileId: selectedProfileId ?? intent.selectedAuth.profileId,
                                    },
                                    ...(recoveryCredits ? { recoveryCredits } : {}),
                                };
                            }
                            return {
                                status: 'wait' as const,
                                nextCheckAtMs: progress.nextCheckAtMs,
                                ...(recoveryCredits ? { recoveryCredits } : {}),
                            };
                        } catch (error) {
                            logger.debug('[codex-app-server] Failed to request connected-service group recovery during usage-limit wait/resume', error);
                            return {
                                status: 'wait' as const,
                                nextCheckAtMs,
                                lastProbeError: 'connected_service_group_recovery_request_failed',
                                ...(recoveryCredits ? { recoveryCredits } : {}),
                            };
                        }
                    }
                    return {
                        status: 'wait' as const,
                        nextCheckAtMs,
                        ...(recoveryCredits ? { recoveryCredits } : {}),
                    };
                }
                return {
                    status: 'ready' as const,
                    ...(recoveryCredits ? { recoveryCredits } : {}),
                };
            } catch (error) {
                const appliedIdentity = latestConnectedServiceRuntimeIdentity === operationIdentityAtStart
                    ? operationIdentityAtStart
                    : null;
                const probeFailureClassification = classifyCodexConnectedServiceAuthFailure({
                    providerErrorPath: true,
                    error,
                    serviceId: 'openai-codex',
                    profileId: appliedIdentity?.profileId ?? null,
                    groupId: appliedIdentity?.groupId ?? null,
                    sourceAccountIdentity: {
                        providerAccountId: appliedIdentity?.activeAccountId ?? null,
                        accountLabel: appliedIdentity?.accountLabel ?? null,
                        groupGeneration: appliedIdentity?.generation ?? null,
                        credentialRevision: appliedIdentity?.credentialRevision ?? null,
                        credentialFingerprint: appliedIdentity?.credentialFingerprint ?? null,
                    },
                });
                if (
                    appliedIdentity
                    &&
                    probeFailureClassification
                    && probeFailureClassification.kind !== 'usage_limit'
                    && probeFailureClassification.kind !== 'capacity'
                    && probeFailureClassification.kind !== 'unknown'
                    && typeof params.onUsageLimitGroupRecovery === 'function'
                ) {
                    try {
                        const recoveryOutcome = await params.onUsageLimitGroupRecovery({
                            sessionId: params.session.sessionId,
                            classification: probeFailureClassification,
                        });
                        if (!isCommittedRuntimeAuthRecoveryDisposition(recoveryOutcome)) {
                            const wait = resolveCodexUsageLimitProbeFailureWait({
                                resetAtMs: intent.resetAtMs ?? null,
                                nextCheckAtMs: intent.nextCheckAtMs ?? null,
                                nowMs: Date.now(),
                            });
                            return {
                                ...wait,
                                lastProbeError: 'connected_service_probe_credential_recovery_uncommitted' as const,
                            };
                        }
                        return {
                            status: 'exhausted' as const,
                            lastProbeError: 'connected_service_probe_credential_recovery_committed',
                        };
                    } catch (recoveryError) {
                        logger.debug('[codex-app-server] Failed to commit connected credential recovery from quota probe', recoveryError);
                    }
                }
                // RD-CDX-8: a failed probe is never an authoritative provider verdict. Transient
                // transport/RPC failures (timeouts, conn resets, probes racing the hot-swap
                // app-server restart) must keep the durable intent WAITING. Parsed provider auth
                // verdicts above are different: they enter canonical credential/group recovery.
                logger.debug('[codex-app-server] Usage-limit recovery probe failed (transient, keep waiting)', error);
                return resolveCodexUsageLimitProbeFailureWait({
                    resetAtMs: intent.resetAtMs ?? null,
                    nextCheckAtMs: intent.nextCheckAtMs ?? null,
                    nowMs: Date.now(),
                });
            }
        },
        resume: async () => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('codex_app_server_thread_not_started');
            }
            const client = await ensureClient();
            const resumedThread = await resumeThread(client, activeThreadId, {
                preserveRequestedThreadId: true,
            });
            await applyStartOrLoadResponse(client, resumedThread.nextThreadId, resumedThread.response);
        },
    });
    const canSteerPrompt = (): boolean => {
        return Boolean(
            pendingTurn
            && turnInFlight
            && activeTurnAcceptsSteer,
        );
    };
    let activeTurnPendingPumpController: AbortController | null = null;
    const stopActiveTurnPendingPump = (): void => {
        const controller = activeTurnPendingPumpController;
        if (!controller) return;
        activeTurnPendingPumpController = null;
        controller.abort('codex-app-server:active-turn-no-longer-steerable');
    };
    const startActiveTurnPendingPump = (): void => {
        if (!canSteerPrompt() || !params.pendingQueue?.pumpPendingWhileActive) return;
        if (activeTurnPendingPumpController) return;
        const controller = new AbortController();
        activeTurnPendingPumpController = controller;
        void params.pendingQueue.pumpPendingWhileActive({
            abortSignal: controller.signal,
            maxPopPerWake: params.pendingQueue.maxPopPerWake,
            // Once the native turn exists, keep the consumer armed through terminal-settling
            // windows too. The server remains the sole owner of whether a row is eligible and
            // whether it resolves to steer or interrupt-and-send.
            shouldContinue: () => pendingTurn !== null && (params.pendingQueue?.shouldDrainPendingMessages?.() ?? true),
            logPrefix: '[CodexAppServer]',
            reason: 'active-turn',
        }).catch((error) => {
            logger.debug('[codex-app-server] Active-turn Pending pump stopped after non-fatal error', error);
        }).finally(() => {
            if (activeTurnPendingPumpController === controller) {
                activeTurnPendingPumpController = null;
            }
        });
    };
    const publishInFlightSteerAvailabilityIfChanged = (): void => {
        const next = canSteerPrompt();
        if (next === lastPublishedInFlightSteerAvailability) return;
        lastPublishedInFlightSteerAvailability = next;
        params.onInFlightSteerAvailabilityChange?.(next);
    };
    const markActiveTurnSteerable = (): void => {
        activeTurnAcceptsSteer = true;
        publishInFlightSteerAvailabilityIfChanged();
        startActiveTurnPendingPump();
    };
    const markActiveTurnNonSteerable = (): void => {
        activeTurnAcceptsSteer = false;
        publishInFlightSteerAvailabilityIfChanged();
    };
    const clearActiveTurnSteerability = (): void => {
        activeTurnAcceptsSteer = false;
        stopActiveTurnPendingPump();
        publishInFlightSteerAvailabilityIfChanged();
    };
    const pendingHappierTitleToolNamesByCallId = new Map<string, string>();
    const syntheticSubagentThreadIds = new Set<string>();
    const syntheticSubagentTracker = createCodexSyntheticSubagentTracker({
        session: params.session,
    });
    let bridgeWork = Promise.resolve();
    const bridgeWorkDiagnostics = createSerializedWorkQueueDiagnostics({
        queueName: 'codex-app-server-bridge',
        slowAfterMs: 30_000,
        report: (report) => {
            logger.infoFile('[codex-app-server] Serialized bridge queue diagnostic', report);
        },
    });

    const getCurrentPermissionMode = (): PermissionMode => params.getPermissionMode?.() ?? params.permissionMode ?? 'default';

    const buildCurrentPermissionParams = (target: 'thread' | 'turn'): Record<string, unknown> => {
        const permissionMode = getCurrentPermissionMode();
        if (permissionMode === 'default') return {};
        if (permissionSupport === 'legacy') {
            return buildCodexAppServerLegacyPermissionParams({
                permissionMode,
                directory: params.directory,
                target,
            });
        }
        return buildCodexAppServerPermissionsParams({ permissionMode });
    };

    const buildCurrentLegacyPermissionParams = (target: 'thread' | 'turn'): Record<string, unknown> => {
        const permissionMode = getCurrentPermissionMode();
        return buildCodexAppServerLegacyPermissionParams({
            permissionMode,
            directory: params.directory,
            target,
        });
    };

    const shouldRetryWithoutPermissionProfile = (error: unknown, requestParams: Record<string, unknown>): boolean => {
        return Object.prototype.hasOwnProperty.call(requestParams, 'permissions')
            && (isCodexAppServerMethodNotFoundError(error)
                || isCodexAppServerInvalidParamsForFieldError(error, 'permissions')
                || isCodexAppServerInvalidRequestMapExpectedStringError(error));
    };

    const setThinking = (nextThinking: boolean): void => {
        if (thinking === nextThinking) return;
        thinking = nextThinking;
        params.onThinkingChange(nextThinking);
    };
    const recordInProgressBestEffort = (providerTurnId?: string | null): void => {
        if (params.session.sessionTurnLifecycle) return;
        void recordSessionTurnInProgress({
            provider: 'codex',
            providerTurnId,
            session: params.session,
        }).catch((error) => {
            logger.debug('[codex-app-server] Failed to record session turn in-progress (non-fatal)', error);
        });
    };

    const recordCompletedBestEffort = async (providerTurnId?: string | null): Promise<void> => {
        // The turn ledger (sessionTurnLifecycle) owns turn-status persistence, but
        // usage-limit recovery settlement on normal completion is owned HERE for both
        // paths: a turn that completed normally supersedes any pending recovery intent.
        if (!params.session.sessionTurnLifecycle) {
            await recordSessionTurnCompleted({
                provider: 'codex',
                providerTurnId,
                session: params.session,
            }).catch((error) => {
                logger.debug('[codex-app-server] Failed to record session turn completion (non-fatal)', error);
            });
        }
        await usageLimitRecoveryScheduler.cancel({ sessionId: params.session.sessionId }).catch((error) => {
            logger.debug('[codex-app-server] Failed to cancel stale usage-limit recovery intent after completion (non-fatal)', error);
        });
        latestUsageLimitIssue = null;
    };

    // `turn/steer` and `turn/interrupt` require a turn id, but we may not have observed it yet
    // when the user acts immediately after sending a message (the id can arrive via the
    // `turn/start` response or the `turn/started` notification). Keep this bounded, but large
    // enough to survive transient event-loop delays in real runs.
    const turnIdWaitTimeoutMs = 1_000;
    const turnIdWaitPollMs = 20;
    const waitForActiveTurnId = async (): Promise<string | null> => {
        let turnId = pendingTurn?.turnId ?? latestPendingTurnId;
        if (turnId) return turnId;
        const waitStartedAt = Date.now();
        while (!turnId && Date.now() - waitStartedAt < turnIdWaitTimeoutMs) {
            await delay(turnIdWaitPollMs);
            turnId = pendingTurn?.turnId ?? latestPendingTurnId;
        }
        return turnId ?? null;
    };

    const publishThreadId = (): void => {
        void publishCodexSessionIdMetadata({
            session: params.session,
            getCodexThreadId: () => threadId,
            backendMode: 'appServer',
            transcriptStorage: runtimeEnv.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: runtimeEnv.CODEX_HOME ?? null,
            activeServerDir: params.activeServerDir ?? null,
            processEnv: runtimeEnv,
            lastPublished: lastPublishedThreadId,
        }).catch(() => undefined);
    };

    const acknowledgePendingTurnStart = (
        candidate: PendingTurn,
        observedTurnId: string | null,
    ): DeferredUnacknowledgedTerminalNotification | null => {
        if (pendingTurn?.promise !== candidate.promise) return null;
        if (!observedTurnId) return null;
        // `thread/start` can return an id before older Codex versions materialize resumable state.
        // A provider turn acknowledgement is the first boundary that proves the fresh thread has
        // accepted work, so only then may its id become Happier's durable resume identity.
        publishThreadId();
        const deferred = deferredUnacknowledgedTerminalNotifications.get(observedTurnId) ?? null;
        clearDeferredUnacknowledgedTerminalNotificationsForOwner(candidate.promise);
        return deferred?.ownerPromise === candidate.promise ? deferred : null;
    };

    // Ordinary resume/recovery retains its established optimistic publication.
    // A tracked cross-agent native return bypasses this and publishes only after
    // the strict provider response has accepted the requested thread.
    const publishRequestedResumeThreadId = (requestedThreadId: string): void => {
        const nextThreadId = trimSessionId(requestedThreadId);
        if (!nextThreadId) return;
        threadId = nextThreadId;
        publishThreadId();
    };

    const publishSessionControls = async (client: DisposableCodexAppServerClient): Promise<void> => {
        const environmentAuth = readCodexEnvironmentAuthState(runtimeEnv);
        await publishCodexAppServerSessionControlsMetadata({
            client,
            session: params.session,
            provider: 'codex',
            authMethod: environmentAuth.method,
            currentModeId,
            currentModelId,
            currentReasoningEffort,
            currentServiceTier,
        }).catch(() => undefined);
    };

    const publishRuntimeContextWindow = async (contextWindowTokens: number | null): Promise<void> => {
        if (contextWindowTokens === null) return;
        await publishCodexAppServerRuntimeModelContextWindowMetadata({
            session: params.session,
            provider: 'codex',
            currentModelId,
            contextWindowTokens,
        }).catch(() => undefined);
    };

    const publishActivePermissionProfile = async (response: unknown): Promise<void> => {
        const activePermissionProfile = readCodexAppServerActivePermissionProfile(response);
        if (!activePermissionProfile) return;
        await Promise.resolve(params.session.updateMetadata((metadata) => {
            const metadataRecord = readRecord(metadata) ?? {};
            return {
                ...metadata,
                codexAppServerV1: {
                    ...(readRecord(metadataRecord.codexAppServerV1) ?? {}),
                    activePermissionProfile,
                },
            };
        })).catch(() => undefined);
    };

    const readGoalFromResponse = (value: unknown): unknown | null => {
        const record = readRecord(value);
        return record && Object.prototype.hasOwnProperty.call(record, 'goal') ? record.goal : value;
    };

    const publishGoalWorkState = async (goal: unknown): Promise<void> => {
        const record = readRecord(readGoalFromResponse(goal));
        if (!record) {
            await Promise.resolve(params.session.updateMetadata((metadata) =>
                removeCodexGoalFromSessionWorkStateMetadata(metadata),
            )).catch(() => undefined);
            return;
        }
        await Promise.resolve(params.session.updateMetadata((metadata) =>
            mergeCodexGoalIntoSessionWorkStateMetadata(metadata, record),
        )).catch(() => undefined);
    };

    const clearGoalWorkState = async (): Promise<void> => {
        await Promise.resolve(params.session.updateMetadata((metadata) =>
            removeCodexGoalFromSessionWorkStateMetadata(metadata),
        )).catch(() => undefined);
    };

    const refreshGoalForThread = async (
        client: Pick<DisposableCodexAppServerClient, 'request'>,
        activeThreadId: string,
    ): Promise<boolean> => {
        try {
            const response = await client.request('thread/goal/get', { threadId: activeThreadId });
            await publishGoalWorkState(response);
            return true;
        } catch (error) {
            if (isCodexAppServerGoalMethodUnavailableError(error, 'thread/goal/get')) {
                return false;
            }
            throw error;
        }
    };

    const runBridgeWork = async <T>(
        context: SerializedWorkDiagnosticContext,
        work: () => Promise<T>,
    ): Promise<T> => {
        const tracked = bridgeWorkDiagnostics.track(context);
        const run = () => tracked.run(work);
        const next = bridgeWork.then(run, run);
        bridgeWork = next.then(() => undefined, () => undefined);
        return await next;
    };

    const appendStreamDelta = (itemKey: string, text: string, values: Map<string, string>, append: (deltaText: string) => void): void => {
        if (!text) return;
        append(text);
        values.set(itemKey, `${values.get(itemKey) ?? ''}${text}`);
    };

    const appendStreamFinal = (
        itemKey: string,
        text: string,
        values: Map<string, string>,
        append: (deltaText: string) => void,
        override: (finalText: string) => void,
    ): void => {
        const accumulated = values.get(itemKey) ?? '';
        values.delete(itemKey);
        if (!text) return;
        if (!accumulated) {
            append(text);
            return;
        }
        if (text.startsWith(accumulated)) {
            const suffix = text.slice(accumulated.length);
            if (suffix) append(suffix);
            return;
        }
        override(text);
    };

    const buildItemStateKey = (scopeId: string, itemId: string): string => `${scopeId}:${itemId}`;
    const buildRawFallbackStateKey = (scopeId: string): string => `${scopeId}:raw-response-item`;
    const buildItemStreamKey = (scopeId: string, kind: 'assistant' | 'reasoning', itemId: string): string =>
        `${scopeId}:${kind}:${itemId}`;
    const buildAssistantItemStreamKey = (scopeId: string, itemId: string): string =>
        buildItemStreamKey(scopeId, 'assistant', itemId);
    const hasNormalizedAssistantFinalInScope = (streamScopeId: string): boolean => {
        const keyPrefix = `${streamScopeId}:`;
        for (const itemKey of normalizedAssistantFinalItemKeys) {
            if (itemKey.startsWith(keyPrefix)) return true;
        }
        return false;
    };
    const deletePendingRawAssistantFinalForNormalizedItem = (streamScopeId: string, itemId: string): void => {
        rawAssistantFinalByItemKey.delete(buildItemStateKey(streamScopeId, itemId));
        rawAssistantFinalByItemKey.delete(buildRawFallbackStateKey(streamScopeId));
    };

    const commitRawAssistantFinal = (pending: PendingRawAssistantFinal): void => {
        const itemId = pending.itemId
            ?? latestAssistantItemIdByStreamScope.get(pending.streamScopeId)
            ?? 'raw-response-item';
        appendStreamFinal(
            buildItemStateKey(pending.streamScopeId, itemId),
            pending.text,
            assistantTextByItemId,
            (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildAssistantItemStreamKey(pending.streamScopeId, itemId),
                    sidechainId: pending.sidechainId,
                });
            },
            (finalText) => {
                itemTranscriptBridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildAssistantItemStreamKey(pending.streamScopeId, itemId),
                    sidechainId: pending.sidechainId,
                });
            },
        );
    };

    const commitPendingRawAssistantFinals = (options?: Readonly<{
        includeFallbackRawFinals?: boolean;
        sidechainId?: string | null;
    }>): void => {
        const includeFallbackRawFinals = options?.includeFallbackRawFinals !== false;
        for (const [itemKey, pendingRaw] of rawAssistantFinalByItemKey.entries()) {
            if (options && Object.prototype.hasOwnProperty.call(options, 'sidechainId') && pendingRaw.sidechainId !== options.sidechainId) {
                continue;
            }
            if (pendingRaw.itemId) {
                if (!normalizedAssistantFinalItemKeys.has(itemKey)) {
                    commitRawAssistantFinal(pendingRaw);
                }
                rawAssistantFinalByItemKey.delete(itemKey);
            } else if (includeFallbackRawFinals && !hasNormalizedAssistantFinalInScope(pendingRaw.streamScopeId)) {
                commitRawAssistantFinal(pendingRaw);
                rawAssistantFinalByItemKey.delete(itemKey);
            }
        }
    };

    const flushItemTranscriptBoundary = async (sidechainId: string | null): Promise<void> => {
        commitPendingRawAssistantFinals({ includeFallbackRawFinals: false, sidechainId });
        await itemTranscriptBridge.flushStreamsMatching({
            reason: 'tool-call-boundary',
            matches: (stream) => stream.sidechainId === sidechainId,
        });
    };

    const buildSessionMediaMeta = (
        media: readonly SessionMediaItemV1[],
        unavailable: readonly SessionMediaUnavailableV1[] = [],
    ): Record<string, unknown> => ({
        happier: {
            kind: SESSION_MEDIA_MESSAGE_META_KIND_V1,
            payload: {
                media,
                ...(unavailable.length > 0 ? { unavailable } : {}),
            },
        },
    });

    const filterNewSessionMedia = (media: readonly RuntimeSessionMediaSource[]): RuntimeSessionMediaSource[] => {
        const next: RuntimeSessionMediaSource[] = [];
        for (const item of media) {
            const dedupeKey = resolveSessionMediaDedupeKey(item);
            if (persistedMediaDedupeKeys.has(dedupeKey)) continue;
            next.push(item);
        }
        return next;
    };

    const ensureSyntheticSubagentThread = async (threadId: string): Promise<string> => {
        if (syntheticSubagentThreadIds.has(threadId)) return threadId;
        await flushItemTranscriptBoundary(null);
        await syntheticSubagentTracker.ensureStarted({ threadId });
        syntheticSubagentThreadIds.add(threadId);
        return threadId;
    };

    const finalizeSyntheticSubagentThread = async (threadId: string, status: 'completed' | 'interrupted'): Promise<void> => {
        await ensureSyntheticSubagentThread(threadId);
        await flushItemTranscriptBoundary(threadId);
        await syntheticSubagentTracker.finalize({ threadId, status });
    };

    const markActiveTurnMeaningfulContextWindowRecoveryActivity = (): void => {
        if (!pendingTurn) return;
        activeTurnHasMeaningfulContextWindowRecoveryActivity = true;
    };

    const commitInlineReviewFindings = async (
        update: Extract<CodexAppServerStreamUpdate, { type: 'review-mode-completed' }>,
    ): Promise<void> => {
        const reviewText = update.review.trim();
        if (!reviewText) return;

        const reviewTurnId = latestPendingTurnId ?? pendingTurn?.turnId ?? 'unknown-turn';
        const sessionId = trimSessionId(params.session.sessionId) ?? 'current-session';
        const payload = buildCodexNativeReviewFindingsV2Payload({
            runId: `session-review:${sessionId}:${reviewTurnId}`,
            callId: update.itemId,
            backendId: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            rawText: reviewText,
            generatedAtMs: Date.now(),
        });
        if (!payload) return;

        const commitSession = params.transcriptSession ?? params.session;
        if (typeof commitSession.sendAgentMessageCommitted !== 'function') return;
        await commitSession.sendAgentMessageCommitted(
            'codex',
            { type: 'message', message: reviewText },
            {
                localId: `codex-inline-review:${reviewTurnId}:${update.itemId}`,
                meta: {
                    happier: {
                        kind: 'review_findings.v2',
                        payload,
                    },
                },
            },
        );
    };

    const applyStreamUpdate = async (update: CodexAppServerStreamUpdate, context: StreamUpdateContext): Promise<void> => {
        if (isMeaningfulCodexContextWindowRecoveryActivity(update)) {
            markActiveTurnMeaningfulContextWindowRecoveryActivity();
        }

        if (update.type === 'assistant-text-delta') {
            latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
            appendStreamDelta(buildItemStateKey(context.streamScopeId, update.itemId), update.text, assistantTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildAssistantItemStreamKey(context.streamScopeId, update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'assistant-text-final') {
            const itemKey = buildItemStateKey(context.streamScopeId, update.itemId);
            const nativeReviewText = nativeReviewCompletionTextByStreamScope.get(context.streamScopeId);
            if (nativeReviewText && nativeReviewText.trim() === update.text.trim()) {
                normalizedAssistantFinalItemKeys.add(itemKey);
                deletePendingRawAssistantFinalForNormalizedItem(context.streamScopeId, update.itemId);
                return;
            }
            if (nativeReviewText) {
                await flushItemTranscriptBoundary(context.sidechainId);
                nativeReviewCompletionTextByStreamScope.delete(context.streamScopeId);
            }
            latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
            normalizedAssistantFinalItemKeys.add(itemKey);
            deletePendingRawAssistantFinalForNormalizedItem(context.streamScopeId, update.itemId);
            appendStreamFinal(itemKey, update.text, assistantTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildAssistantItemStreamKey(context.streamScopeId, update.itemId),
                    sidechainId: context.sidechainId,
                });
            }, (finalText) => {
                itemTranscriptBridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildAssistantItemStreamKey(context.streamScopeId, update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'assistant-raw-final') {
            const itemKey = update.itemId
                ? buildItemStateKey(context.streamScopeId, update.itemId)
                : buildRawFallbackStateKey(context.streamScopeId);
            if (update.itemId) {
                if (normalizedAssistantFinalItemKeys.has(itemKey)) return;
            } else if (hasNormalizedAssistantFinalInScope(context.streamScopeId)) {
                return;
            }
            rawAssistantFinalByItemKey.set(itemKey, {
                text: update.text,
                sidechainId: context.sidechainId,
                streamScopeId: context.streamScopeId,
                itemId: update.itemId,
            });
            return;
        }

        if (update.type === 'review-mode-started') {
            params.session.sendSessionEvent?.({
                type: 'message',
                message: `Codex review started: ${update.review}`,
            });
            return;
        }

        if (update.type === 'review-mode-completed') {
            latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
            const itemKey = buildItemStateKey(context.streamScopeId, update.itemId);
            normalizedAssistantFinalItemKeys.add(itemKey);
            deletePendingRawAssistantFinalForNormalizedItem(context.streamScopeId, update.itemId);
            nativeReviewCompletionTextByStreamScope.set(context.streamScopeId, update.review);
            if (activeInlineReview && !context.sidechainId) {
                await commitInlineReviewFindings(update);
                return;
            }
            appendStreamFinal(itemKey, update.review, assistantTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildAssistantItemStreamKey(context.streamScopeId, update.itemId),
                    sidechainId: context.sidechainId,
                });
            }, (finalText) => {
                itemTranscriptBridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildAssistantItemStreamKey(context.streamScopeId, update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'session-media') {
            if (!params.sessionMedia) return;
            const media = filterNewSessionMedia(update.media);
            if (media.length === 0) return;
            const persistedMedia: SessionMediaItemV1[] = [];
            const unavailableMedia: SessionMediaUnavailableV1[] = [];
            for (const item of media) {
                const persisted = await Promise.resolve(params.sessionMedia.persist({
                    type: 'session-media',
                    source: 'codex-app-server',
                    media: [item],
                }));
                if (persisted.media.length > 0) {
                    persistedMediaDedupeKeys.add(resolveSessionMediaDedupeKey(item));
                    persistedMedia.push(...persisted.media);
                }
                if (persisted.unavailable.length > 0) {
                    unavailableMedia.push(...persisted.unavailable);
                }
            }
            const boundedMedia = boundSessionMediaEnvelopeEntries({
                media: persistedMedia,
                unavailable: unavailableMedia,
                maxEntries: SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
            });
            if (boundedMedia.droppedCount > 0) {
                logger.debug('[codex-app-server] Bounded excess session media entries', {
                    droppedCount: boundedMedia.droppedCount,
                    maxEntries: SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
                });
            }
            if (boundedMedia.media.length === 0 && boundedMedia.unavailable.length === 0) return;
            const mediaMeta = buildSessionMediaMeta(boundedMedia.media, boundedMedia.unavailable);
            const assistantItemId = latestAssistantItemIdByStreamScope.get(context.streamScopeId) ?? update.itemId;
            const didAttach = itemTranscriptBridge.mergeAssistantMeta({
                streamKey: buildAssistantItemStreamKey(context.streamScopeId, assistantItemId),
                sidechainId: context.sidechainId,
                meta: mediaMeta,
            });
            if (didAttach) return;
            const body: ACPMessageData = context.sidechainId
                ? { type: 'message', message: '', sidechainId: context.sidechainId }
                : { type: 'message', message: '' };
            const commitSession = params.transcriptSession ?? params.session;
            if (typeof commitSession.sendAgentMessageCommitted !== 'function') return;
            await commitSession.sendAgentMessageCommitted(
                'codex',
                body,
                { localId: randomUUID(), meta: mediaMeta },
            );
            return;
        }

        if (update.type === 'reasoning-delta') {
            appendStreamDelta(buildItemStateKey(context.streamScopeId, update.itemId), update.text, reasoningTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendThinkingDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'reasoning-final') {
            appendStreamFinal(buildItemStateKey(context.streamScopeId, update.itemId), update.text, reasoningTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendThinkingDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                    sidechainId: context.sidechainId,
                });
            }, (finalText) => {
                itemTranscriptBridge.overrideThinkingText({
                    text: finalText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'turn-diff-updated') {
            if (context.sidechainId) return;
            const activeTurnId = pendingTurn?.turnId ?? null;
            if (update.turnId && activeTurnId && update.turnId !== activeTurnId) {
                return;
            }
            turnChangeCollector.observeUnifiedDiffSnapshot({
                unifiedDiff: update.unifiedDiff,
                source: 'provider_native',
                confidence: 'exact',
            });
            return;
        }

        if (update.type === 'context-compaction') {
            if (context.sidechainId) return;
            params.session.sendSessionEvent({
                type: 'context-compaction',
                phase: update.phase,
                lifecycleId: update.itemId,
                provider: 'codex',
                source: 'provider-event',
                providerEventId: update.itemId,
            });
            return;
        }

        if (update.type === 'tool-call') {
            await flushItemTranscriptBoundary(context.sidechainId);
            if (update.toolKind === 'mcp' && isChangeTitleToolNameAlias(update.name)) {
                const title = readHappierTitleToolTitle(update.input);
                if (title) {
                    pendingHappierTitleToolNamesByCallId.set(update.callId, title);
                }
            }
            if (update.toolKind === 'file-change') {
                const input = update.input && typeof update.input === 'object' && !Array.isArray(update.input)
                    ? normalizePatchInputRecord(update.input as Record<string, unknown>)
                    : null;
                const changes = input?.changes;
                if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
                    turnChangeCollector.observePatchChanges({
                        changes: changes as Record<string, unknown>,
                        source: 'provider_tool',
                        confidence: 'strong',
                    });
                }
            }
            if (context.sidechainId) {
                params.session.sendAgentMessage('codex', {
                    type: 'tool-call',
                    name: update.name,
                    callId: update.callId,
                    input: update.input,
                    id: randomUUID(),
                    sidechainId: context.sidechainId,
                });
            } else {
                params.session.sendCodexMessage({
                    type: 'tool-call',
                    name: update.name,
                    callId: update.callId,
                    input: update.input,
                    id: randomUUID(),
                });
            }
            return;
        }

        if (update.type === 'tool-result') {
            const completedTitleName = pendingHappierTitleToolNamesByCallId.get(update.callId) ?? null;
            pendingHappierTitleToolNamesByCallId.delete(update.callId);
            if (context.sidechainId) {
                params.session.sendAgentMessage('codex', {
                    type: 'tool-call-result',
                    callId: update.callId,
                    output: update.output,
                    id: randomUUID(),
                    sidechainId: context.sidechainId,
                });
            } else {
                params.session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: update.callId,
                    output: update.output,
                    id: randomUUID(),
                });
            }
            if (completedTitleName && didHappierTitleToolSucceed(update.output) && threadId && !context.sidechainId) {
                try {
                    const client = await ensureClient();
                    await client.request('thread/name/set', { threadId, name: completedTitleName });
                } catch (error) {
                    logger.debug('[codex-app-server] Failed to sync Happier title to Codex native thread name', {
                        threadId,
                        error,
                    });
                }
            }
        }
    };

    const flushStreamState = async (reason: 'turn-end' | 'abort'): Promise<void> => {
        assistantTextByItemId.clear();
        reasoningTextByItemId.clear();
        latestAssistantItemIdByStreamScope.clear();
        normalizedAssistantFinalItemKeys.clear();
        nativeReviewCompletionTextByStreamScope.clear();
        rawAssistantFinalByItemKey.clear();
        pendingHappierTitleToolNamesByCallId.clear();
        await itemTranscriptBridge.flushAll({
            reason,
            ...(reason === 'abort' ? { interruptedReason: 'app-server-turn-interrupted' } : {}),
        });
    };

    const mapApprovalDecision = (
        requestKind: 'command-execution' | 'file-change',
        result: PermissionResult,
    ): Readonly<Record<string, unknown>> => {
        if (requestKind === 'command-execution' && result.decision === 'approved_execpolicy_amendment') {
            const amendment = result.execPolicyAmendment?.command;
            if (Array.isArray(amendment) && amendment.length > 0) {
                return {
                    decision: {
                        acceptWithExecpolicyAmendment: {
                            execpolicy_amendment: amendment,
                        },
                    },
                };
            }
        }

        switch (result.decision) {
            case 'approved_for_session':
                return { decision: 'acceptForSession' };
            case 'approved_execpolicy_amendment':
            case 'approved':
                return { decision: 'accept' };
            case 'abort':
                return { decision: 'cancel' };
            case 'denied':
                return { decision: 'decline' };
        }
    };

    const mapPermissionsDecision = (
        update: Extract<CodexAppServerStreamUpdate, { type: 'permissions-request' }>,
        result: PermissionResult,
    ): Readonly<Record<string, unknown>> => {
        if (
            result.decision === 'approved'
            || result.decision === 'approved_for_session'
            || result.decision === 'approved_execpolicy_amendment'
        ) {
            return {
                permissions: update.permissions,
                scope: result.decision === 'approved_for_session' ? 'session' : 'turn',
            };
        }

        return {
            permissions: {},
            scope: 'turn',
        };
    };

    const buildUserInputResponse = (
        update: Extract<CodexAppServerStreamUpdate, { type: 'user-input-request' }>,
        result: PermissionResult,
        options?: Readonly<{ allowDecisionFallback?: boolean }>,
    ): Readonly<Record<string, unknown>> => {
        const answers = buildCodexRequestUserInputAnswers({
            questions: update.questions,
            answersByKey: result.answers ?? {},
        });

        if (options?.allowDecisionFallback === true && Object.keys(answers).length === 0) {
            const pickQuestionWithOptions = update.questions.find((question): question is Record<string, unknown> => {
                if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
                const options = (question as Record<string, unknown>).options;
                return Array.isArray(options) && options.some((option) => option && typeof option === 'object' && !Array.isArray(option));
            }) ?? update.questions.find((question): question is Record<string, unknown> => {
                return Boolean(question) && typeof question === 'object' && !Array.isArray(question);
            });

            const optionLabels = Array.isArray(pickQuestionWithOptions?.options)
                ? pickQuestionWithOptions.options
                    .map((option) => {
                        if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
                        const optionRecord = option as Record<string, unknown>;
                        const label = typeof optionRecord.label === 'string'
                            ? optionRecord.label.trim()
                            : '';
                        return label || null;
                    })
                    .filter((label): label is string => Boolean(label))
                : [];

            const choice = (() => {
                const explicit = resolveApprovalChoiceLabel({
                    decision: result.decision,
                    questions: [pickQuestionWithOptions].filter(Boolean),
                    logger: { debug: () => {} },
                });
                if (explicit) return explicit;
                if (result.decision === 'approved' || result.decision === 'approved_execpolicy_amendment' || result.decision === 'approved_for_session') {
                    return optionLabels.find((label) => /approve|allow/i.test(label)) ?? optionLabels[0] ?? null;
                }
                if (result.decision === 'denied') {
                    return optionLabels.find((label) => /deny|reject|decline/i.test(label)) ?? optionLabels.at(-1) ?? null;
                }
                if (result.decision === 'abort') {
                    return optionLabels.find((label) => /cancel|abort|stop/i.test(label)) ?? optionLabels.at(-1) ?? null;
                }
                return null;
            })();

            const questionId = typeof pickQuestionWithOptions?.id === 'string' ? pickQuestionWithOptions.id : null;
            if (choice && questionId) {
                answers[questionId] = { answers: [choice] };
            }
        }

        return { answers };
    };

    const readMcpElicitationInvocation = (
        params: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ): Readonly<{
        toolCallId: string;
        toolName: string;
        input: unknown;
    }> | null => {
        const record = readRecord(params);
        if (!record) return null;

        const invocation = readRecord(record.invocation) ?? record;
        const meta = readRecord(record._meta) ?? readRecord(record.meta) ?? null;
        const server =
            trimStringValue(invocation.server) ??
            trimStringValue(invocation.mcpServer) ??
            trimStringValue(invocation.mcp_server) ??
            trimStringValue(invocation.serverName) ??
            trimStringValue(invocation.server_name);

        const toolFromMessage = (() => {
            const messageText = trimStringValue(record.message);
            if (!messageText) return null;
            const match = messageText.match(/tool\s+\"([^\"]+)\"/i);
            return match && match[1] ? match[1].trim() : null;
        })();

        const tool =
            trimStringValue(invocation.tool) ??
            trimStringValue(invocation.name) ??
            trimStringValue(invocation.toolName) ??
            trimStringValue(invocation.tool_name) ??
            toolFromMessage ??
            (meta ? trimStringValue(meta.tool_title) ?? trimStringValue(meta.toolTitle) : null);

        const metaToolParams = meta ? (meta.tool_params ?? meta.toolParams ?? null) : null;
        const input = invocation.arguments ?? invocation.input ?? invocation.args ?? metaToolParams ?? {};

        const toolCallId =
            trimStringValue(record.callId) ??
            trimStringValue(record.call_id) ??
            trimStringValue(record.toolUseId) ??
            trimStringValue(record.tool_use_id) ??
            trimStringValue(record.toolCallId) ??
            trimStringValue(record.tool_call_id) ??
            trimStringValue(record.codexCallId) ??
            trimStringValue(record.codex_call_id) ??
            trimStringValue(record.codex_tool_call_id) ??
            trimStringValue(record.codex_mcp_tool_call_id) ??
            trimStringValue(record.itemId) ??
            trimStringValue(record.item_id) ??
            trimStringValue(record.id) ??
            (typeof message?.id === 'string' || typeof message?.id === 'number' ? String(message.id) : null);

        if (!toolCallId) return null;

        const toolName = server && tool ? canonicalizeCodexMcpToolName(`mcp__${server}__${tool}`) : tool;
        if (!toolName) return null;

        return { toolCallId, toolName, input };
    };

    type CodexAppServerMcpElicitationAction = 'accept' | 'decline' | 'cancel';

    const mapMcpElicitationResponse = (result: PermissionResult): Readonly<Record<string, unknown>> => {
        const action: CodexAppServerMcpElicitationAction = (() => {
            switch (result.decision) {
                case 'approved_for_session':
                case 'approved_execpolicy_amendment':
                case 'approved':
                    return 'accept';
                case 'abort':
                    return 'cancel';
                case 'denied':
                default:
                    return 'decline';
            }
        })();

        return action === 'accept' ? { action, content: {} } : { action };
    };

    const handleMcpElicitationRequest = async (
        requestParams: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ): Promise<unknown> => {
        if (!(await ensureActiveTurnForProviderRequest(requestParams))) {
            return mapMcpElicitationResponse({ decision: 'denied' });
        }
        const invocation = readMcpElicitationInvocation(requestParams, message);
        if (!invocation) {
            return mapMcpElicitationResponse({ decision: 'denied' });
        }

        markActiveTurnMeaningfulContextWindowRecoveryActivity();
        const result = params.permissionHandler
            ? await params.permissionHandler.handleToolCall(invocation.toolCallId, invocation.toolName, invocation.input)
            : { decision: 'denied' as const };

        return mapMcpElicitationResponse(result);
    };

    const handleServerRequest = async (
        method: string,
        requestParams: unknown,
        options?: Readonly<{ allowProviderEffects?: boolean }>,
    ): Promise<unknown> => {
        const updates = streamEventBridge.onServerRequest({ method, params: requestParams });
        const requestMatchesActiveTurn = options?.allowProviderEffects === false
            ? false
            : updates.length > 0
            ? await ensureActiveTurnForProviderRequest(requestParams)
            : true;
        for (const update of updates) {
            if (!requestMatchesActiveTurn) {
                if (update.type === 'approval-request') {
                    return mapApprovalDecision(update.requestKind, { decision: 'denied' });
                }
                if (update.type === 'permissions-request') {
                    return mapPermissionsDecision(update, { decision: 'denied' });
                }
                if (update.type === 'user-input-request') {
                    return buildUserInputResponse(update, { decision: 'abort' }, { allowDecisionFallback: false });
                }
            }
            if (isMeaningfulCodexContextWindowRecoveryActivity(update)) {
                markActiveTurnMeaningfulContextWindowRecoveryActivity();
            }

            if (update.type === 'approval-request') {
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, update.toolName, update.input)
                    : { decision: 'denied' as const };
                return mapApprovalDecision(update.requestKind, result);
            }

            if (update.type === 'permissions-request') {
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, update.toolName, update.input)
                    : { decision: 'denied' as const };
                return mapPermissionsDecision(update, result);
            }

        if (update.type === 'user-input-request') {
            const treatAsApproval = looksLikeCodexApprovalRequestUserInput({
                toolName: update.toolName,
                questions: update.questions,
            });
            logger.debug('[codex-app-server] requestUserInput received', {
                callId: update.callId,
                toolName: update.toolName,
                treatAsApproval,
                questionSummaries: update.questions.map((question) => {
                    if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
                    const record = question as Record<string, unknown>;
                    const options = Array.isArray(record.options)
                        ? record.options
                            .map((option) => {
                                if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
                                const optionRecord = option as Record<string, unknown>;
                                return typeof optionRecord.label === 'string' ? optionRecord.label : null;
                            })
                            .filter((label): label is string => Boolean(label))
                        : [];
                    return {
                        id: typeof record.id === 'string' ? record.id : null,
                        header: typeof record.header === 'string' ? record.header : null,
                        question: typeof record.question === 'string' ? record.question : null,
                        options,
                    };
                }).filter(Boolean),
            });
            const toolName = treatAsApproval ? update.toolName : 'AskUserQuestion';
            const toolInput = treatAsApproval
                ? {
                    ...(update.input && typeof update.input === 'object' && !Array.isArray(update.input)
                        ? update.input as Record<string, unknown>
                            : {}),
                        requestUserInput: {
                            questions: update.questions,
                        },
                    }
                    : normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput(update.questions);
            const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, toolName, toolInput)
                    : { decision: 'abort' as const };
            logger.debug('[codex-app-server] requestUserInput resolved', {
                callId: update.callId,
                toolName,
                decision: result.decision,
                answerKeys: result.answers ? Object.keys(result.answers) : [],
            });
            return buildUserInputResponse(update, result, { allowDecisionFallback: treatAsApproval });
        }
        }

        return null;
    };

    const finishPendingTurn = async (options?: Readonly<{
        error?: Error;
        emitUndeliverablePrompt?: boolean;
        failureIssue?: SessionRuntimeIssueV1 | null;
        flushReason?: 'turn-end' | 'abort' | 'failure';
        insideBridgeWork?: boolean;
    }>): Promise<void> => {
        if (pendingTurnFinalizationTimer) {
            clearTimeout(pendingTurnFinalizationTimer);
            pendingTurnFinalizationTimer = null;
        }
        if (pendingTurnBlockingItemDrainTimer) {
            clearTimeout(pendingTurnBlockingItemDrainTimer);
            pendingTurnBlockingItemDrainTimer = null;
        }
        scheduledPendingTurnFlushReason = null;
        const activeTurn = pendingTurn;
        const completedTurnStartSeqInclusive = pendingTurnStartSeqInclusive;
        const completedProviderThreadId = activeTurn?.threadId ?? threadId;
        const completedProviderTurnId = activeTurn?.turnId ?? latestPendingTurnId;
        if (activeTurn) {
            clearDeferredUnacknowledgedTerminalNotificationsForOwner(activeTurn.promise);
        }
        pendingTurn = null;
        pendingTurnHasProviderAttributedActivity = false;
        pendingTurnStartSeqInclusive = null;
        turnInFlight = false;
        activeProviderTurnItemIds.clear();
        clearActiveTurnSteerability();
        if (options?.flushReason) {
            const streamFlushReason = options.flushReason === 'failure' ? 'abort' : options.flushReason;
            if (options.insideBridgeWork === true) {
                if (options.flushReason === 'turn-end') {
                    commitPendingRawAssistantFinals();
                }
                await flushStreamState(streamFlushReason);
            } else {
                await runBridgeWork({
                    operation: 'flush-stream-state',
                    details: { flushReason: options.flushReason },
                }, async () => {
                    if (options.flushReason === 'turn-end') {
                        commitPendingRawAssistantFinals();
                    }
                    await flushStreamState(streamFlushReason);
                });
            }
        }
        if (options?.flushReason === 'turn-end' && activeTurn) {
            const turnChangeSetParams = {
                sessionId: params.session.sessionId ?? activeTurn.threadId,
                turnId: activeTurn.turnId ?? latestPendingTurnId ?? `codex-app-server-turn-${Date.now()}`,
                seqRange: {
                    startSeqInclusive: completedTurnStartSeqInclusive ?? 0,
                    endSeqInclusive: readLastObservedMessageSeq(params.session),
                },
                status: 'completed',
            } as const;
            const turnChangeSet = turnChangeCollector.flushTurn(turnChangeSetParams);
            if (turnChangeSet) {
                emitCanonicalTurnDiffTool({
                    turnChangeSet,
                    protocol: 'codex',
                    rawToolName: 'CodexDiff',
                    sendToolCall: ({ toolName, input, callId }) => {
                        const resolvedCallId = callId ?? randomUUID();
                        params.session.sendCodexMessage({
                            type: 'tool-call',
                            name: toolName,
                            callId: resolvedCallId,
                            input,
                            id: randomUUID(),
                        });
                        return resolvedCallId;
                    },
                    sendToolResult: ({ callId, output }) => {
                        params.session.sendCodexMessage({
                            type: 'tool-call-result',
                            callId,
                            output,
                            id: randomUUID(),
                        });
                    },
                });
            }
        } else {
            turnChangeCollector.beginTurn();
        }
        if (options?.flushReason === 'turn-end') {
            await turnBoundaryTracker.completeActiveTurn({
                endSeqInclusive: readLastObservedMessageSeq(params.session),
            });
        } else if (options?.flushReason === 'abort') {
            await turnBoundaryTracker.interruptActiveTurn({
                endSeqInclusive: readLastObservedMessageSeq(params.session),
            });
        } else if (options?.flushReason === 'failure') {
            await turnBoundaryTracker.failActiveTurn({
                endSeqInclusive: readLastObservedMessageSeq(params.session),
                issue: options.failureIssue,
            });
        }
        if (options?.flushReason === 'turn-end' && activeTurn) {
            await recordCompletedBestEffort(activeTurn.turnId ?? latestPendingTurnId);
        }
        if (options?.flushReason) {
            historyBoundary.rememberConsumedTurn(completedProviderThreadId, completedProviderTurnId);
        }
        latestPendingTurnId = null;
        setThinking(false);
        if (!activeTurn) return;
        if (options?.error) {
            if (options.emitUndeliverablePrompt === false) {
                clearPendingProviderPrompt(activeTurn.providerPrompt);
            } else {
                emitPendingProviderPromptAsUndeliverable(activeTurn.providerPrompt);
            }
            activeTurn.reject(options.error);
            return;
        }
        activeTurn.resolve();
    };

    const forcePendingTurnFinalizationAfterBlockingItemDrain = (): void => {
        if (pendingTurnBlockingItemDrainTimer || !pendingTurn) return;
        const drainMs = Math.max(
            configuration.codexAppServerTurnCompletionSettleMs,
            CODEX_APP_SERVER_TERMINAL_BLOCKING_ITEM_DRAIN_MS,
        );
        pendingTurnBlockingItemDrainTimer = setTimeout(() => {
            pendingTurnBlockingItemDrainTimer = null;
            if (!pendingTurn || scheduledPendingTurnFlushReason !== 'turn-end') return;
            activeProviderTurnItemIds.clear();
            scheduledPendingTurnFlushReason = null;
            void runBridgeWork({
                operation: 'finalize-turn-after-item-drain',
                details: { flushReason: 'turn-end' },
            }, async () => {
                if (!pendingTurn) return;
                await finishPendingTurn({
                    flushReason: 'turn-end',
                    insideBridgeWork: true,
                });
            });
        }, drainMs);
    };

    const schedulePendingTurnFinalization = (flushReason: 'turn-end' | 'abort'): void => {
        if (!pendingTurn) return;
        markActiveTurnNonSteerable();
        scheduledPendingTurnFlushReason =
            scheduledPendingTurnFlushReason === 'abort' || flushReason === 'abort'
                ? 'abort'
                : 'turn-end';
        if (scheduledPendingTurnFlushReason === 'turn-end' && activeProviderTurnItemIds.size > 0) {
            forcePendingTurnFinalizationAfterBlockingItemDrain();
            return;
        }
        if (pendingTurnFinalizationTimer) {
            return;
        }
        const settleMs = configuration.codexAppServerTurnCompletionSettleMs;
        pendingTurnFinalizationTimer = setTimeout(() => {
            pendingTurnFinalizationTimer = null;
            const nextFlushReason = scheduledPendingTurnFlushReason ?? flushReason;
            if (nextFlushReason === 'turn-end' && activeProviderTurnItemIds.size > 0) {
                forcePendingTurnFinalizationAfterBlockingItemDrain();
                return;
            }
            scheduledPendingTurnFlushReason = null;
            void runBridgeWork({
                operation: 'finalize-turn-after-settle',
                details: { flushReason: nextFlushReason },
            }, async () => {
                if (!pendingTurn) return;
                await finishPendingTurn({
                    flushReason: nextFlushReason,
                    insideBridgeWork: true,
                });
            });
        }, settleMs);
    };

    const publishCodexTurnAbortedMessage = (): void => {
        try {
            params.session.sendCodexMessage({
                type: 'turn_aborted',
                id: randomUUID(),
            });
        } catch (error) {
            logger.debug('[codex-app-server] Failed to publish provider turn-aborted message (non-fatal)', error);
        }
    };

    const surfaceCodexAppServerTurnFailure = async (
        failure: Error,
        providerTurnId: string | null,
    ): Promise<Awaited<ReturnType<typeof surfacePrimarySessionRuntimeIssue>> | null> => {
        try {
            params.session.sendCodexMessage({
                type: 'message',
                message: formatCodexAppServerErrorForUi(failure),
            });
        } catch (error) {
            logger.debug('[codex-app-server] Failed to publish provider failure message (non-fatal)', error);
        }
        const issueInput = {
            provider: 'codex',
            providerTurnId,
            cause: 'status_error' as const,
            error: failure,
        };
        const issue = params.session.sessionTurnLifecycle
            ? classifyPrimarySessionRuntimeIssue(issueInput)
            : await surfacePrimarySessionRuntimeIssue({
                ...issueInput,
                session: params.session,
            }).catch((error) => {
                logger.debug('[codex-app-server] Failed to surface primary runtime issue (non-fatal)', error);
                return null;
            });
        if (!params.session.sessionTurnLifecycle) {
            publishCodexTurnAbortedMessage();
        }
        return issue;
    };

    const updateUsageLimitRecoveryFromSurfacedIssue = async (
        issue: Awaited<ReturnType<typeof surfacePrimarySessionRuntimeIssue>> | null,
    ): Promise<void> => {
        latestUsageLimitIssue = issue?.source === 'usage_limit' && issue.usageLimit ? issue : null;
        const latestUsageLimit = latestUsageLimitIssue?.usageLimit;
        const selectedAuth = latestUsageLimit
            ? resolveUsageLimitRecoveryAuthSelection({
                runtimeEnv,
                usageLimit: latestUsageLimit,
            })
            : null;
        if (latestUsageLimitIssue && selectedAuth) {
            try {
                const client = await ensureClient();
                const operationIdentityAtStart = latestConnectedServiceRuntimeIdentity;
                const rawSnapshot = await readCodexRateLimitsSnapshot({
                    request: async (_method, params) => await client.request('account/rateLimits/read', params),
                });
                const rawResetCredits = await readRateLimitResetCreditsRaw();
                await publishRateLimitSnapshot(rawSnapshot, {
                    includeLiveAccountIdentity: true,
                    rawResetCredits,
                    operationIdentityAtStart,
                    policyDisposition: 'evidence_only',
                });
            } catch (error) {
                logger.debug('[codex-app-server] Failed to publish immediate usage-limit quota snapshot (non-fatal)', error);
            }
        }
        if (latestUsageLimitIssue && latestUsageLimit && selectedAuth && shouldAutoArmUsageLimitRecovery()) {
            const timing = deriveCodexUsageLimitRecoveryTiming(latestUsageLimitIssue);
            const recoveryCredits = await readRateLimitRecoveryCredits().catch((error) => {
                logger.debug('[codex-app-server] Failed to read usage-limit recovery reset credits while auto-arming (non-fatal)', error);
                return null;
            });
            const issueFingerprint = buildUsageLimitIssueFingerprint(latestUsageLimitIssue);
            // Auto-arm must honor the account's configured resume-prompt behavior — routed/manual
            // and daemon-report paths resolve it through the canonical precedence helper, so this
            // auto path does too instead of leaving `enable` to silently default to 'standard'.
            // Fingerprint-match an existing intent (same tier as `enable`'s own previous-intent
            // precedence) so a mid-wait resurfacing keeps its already-resolved mode, then fall back
            // to the account setting.
            const existingRecoveryIntent = usageLimitRecoveryScheduler.read(params.session.sessionId);
            const resumePromptMode = resolveSessionUsageLimitRecoveryResumePromptModeV1({
                existingIntent: existingRecoveryIntent?.issueFingerprint === issueFingerprint
                    ? existingRecoveryIntent
                    : undefined,
                accountSettings: getActiveAccountSettingsSnapshot()?.settings,
            });
            await usageLimitRecoveryScheduler.enable({
                sessionId: params.session.sessionId,
                issueFingerprint,
                resetAtMs: timing.resetAtMs,
                nextCheckAtMs: timing.nextCheckAtMs,
                resumePromptMode,
                selectedAuth,
                ...(recoveryCredits ? { recoveryCredits } : {}),
            }).catch((error) => {
                logger.debug('[codex-app-server] Failed to auto-arm usage-limit recovery intent (non-fatal)', error);
            });
        }
        if (!latestUsageLimitIssue) {
            await usageLimitRecoveryScheduler.cancel({ sessionId: params.session.sessionId }).catch((error) => {
                logger.debug('[codex-app-server] Failed to cancel stale usage-limit recovery intent after non-usage issue (non-fatal)', error);
            });
        }
    };

    const abortPendingTurnWithFailure = async (failure: Error): Promise<void> => {
        const providerTurnId = pendingTurn?.turnId ?? latestPendingTurnId;
        // Publish the provider-qualified issue before the boundary tracker performs its
        // generic terminal bookkeeping. Otherwise the generic fail wins the one terminal
        // lifecycle slot and permanently hides the exact auth/quota classification.
        let issue: Awaited<ReturnType<typeof surfacePrimarySessionRuntimeIssue>> | null = null;
        try {
            issue = await surfaceCodexAppServerTurnFailure(failure, providerTurnId);
        } finally {
            // Diagnostics and lifecycle persistence must never retain native turn
            // ownership after the provider process/turn has already terminated.
            try {
                await finishPendingTurn({
                    error: failure,
                    failureIssue: issue,
                    flushReason: 'failure',
                    insideBridgeWork: true,
                });
            } finally {
                // Lifecycle-backed sessions must observe the exact classified failure
                // before the legacy presentation marker can be interpreted as cancel.
                if (params.session.sessionTurnLifecycle) {
                    publishCodexTurnAbortedMessage();
                }
            }
        }
        await updateUsageLimitRecoveryFromSurfacedIssue(issue);
    };

    const requestUsageLimitGroupRecoveryForTerminalFailure = async (
        classification: CodexConnectedServiceRuntimeFailureClassification | null,
    ): Promise<void> => {
        if (
            classification?.kind !== 'usage_limit'
            || !classification.groupId
            || !classification.profileId
            || typeof params.onUsageLimitGroupRecovery !== 'function'
        ) {
            return;
        }
        try {
            await params.onUsageLimitGroupRecovery({
                sessionId: params.session.sessionId,
                classification,
            });
        } catch (error) {
            logger.debug('[codex-app-server] Failed to request connected-service group recovery after terminal usage limit', error);
        }
    };

    // Settle the tracked primary pending turn from a terminal (`turn/completed` /
    // `turn/interrupted`) notification. Both the terminal-status write
    // (`turnBoundaryTracker.completeActiveTurn`) and the `thinking` reset live inside
    // `finishPendingTurn`, which this schedules — so a terminal notification that reaches
    // the pending turn MUST route here, never get dropped, or the session latches
    // `thinking=true` with no terminal status (stuck "working" forever, republished by the
    // 2s keepalive).
    const settleTerminalPendingTurn = async (
        method: string,
        notificationParams: unknown,
        terminalTurnId: string | null,
    ): Promise<void> => {
        const activeTurn = pendingTurn;
        if (activeTurn) {
            // Adopt/reconcile the provider's terminal turnId onto the tracked pending turn
            // rather than dropping the completion when the id drifted.
            await bindActiveNativeTurnIdFromProviderActivity(activeTurn, notificationParams, {
                turnId: terminalTurnId,
            });
        }
        markActiveTurnNonSteerable();
        const terminalStatus = method === 'turn/completed'
            ? readCodexTurnStatus(notificationParams)
            : null;
        if (method === 'turn/completed' && terminalStatus === 'failed') {
            const failure = createCodexAppServerTurnFailure(
                notificationParams,
                activeTurn?.connectedServiceRuntimeIdentityAtStart ?? null,
            );
            if (shouldDeferCodexAppServerTurnFailureToPromptLoop(failure)) {
                await finishPendingTurn({
                    error: failure,
                    flushReason: 'abort',
                    insideBridgeWork: true,
                });
                return;
            }
            await abortPendingTurnWithFailure(failure);
            const usageLimitGroupRecoveryClassification = failure instanceof CodexAppServerTurnFailure
                && failure.runtimeAuthClassification?.kind === 'usage_limit'
                ? failure.runtimeAuthClassification
                : null;
            // The daemon may hot-apply a replacement credential back through this same
            // runtime. Start recovery only after the terminal boundary and quota evidence
            // are published, but do not await it while a notification bridge owns the
            // runtime queue or the hot-apply callback can deadlock behind that bridge.
            void requestUsageLimitGroupRecoveryForTerminalFailure(
                usageLimitGroupRecoveryClassification,
            );
            return;
        }
        if (method !== 'turn/completed' || isCodexTurnInterruptedStatus(terminalStatus)) {
            await surfacePrimarySessionRuntimeIssue({
                provider: 'codex',
                cause: 'cancelled',
                providerTurnId: terminalTurnId,
                session: {
                    sendAgentMessage: (_provider, body) => params.session.sendCodexMessage(body),
                },
            }).catch((error) => {
                logger.debug('[codex-app-server] Failed to surface cancelled turn issue (non-fatal)', error);
            });
            schedulePendingTurnFinalization('abort');
            return;
        }
        schedulePendingTurnFinalization('turn-end');
    };

    const hasProviderTurnAlreadyTerminated = (
        activityParams: unknown,
        providerTurnId: string | null,
    ): boolean => {
        if (!providerTurnId) return false;
        const activityThreadId = readThreadId(activityParams);
        return historyBoundary.hasConsumedTurn(providerTurnId, [activityThreadId, threadId]);
    };

    const trackActiveProviderTurnItemStart = (notificationParams: unknown): void => {
        if (!pendingTurn || !notificationMatchesPendingTurn(notificationParams)) return;
        if (!isBlockingCodexAppServerItemStart(notificationParams)) return;
        const itemId = readProviderEventItemId(notificationParams);
        if (itemId) activeProviderTurnItemIds.add(itemId);
    };

    const trackActiveProviderTurnItemCompletion = (notificationParams: unknown): boolean => {
        const itemId = readProviderEventItemId(notificationParams);
        return itemId ? activeProviderTurnItemIds.delete(itemId) : false;
    };

    const shouldSkipDuplicateBlockingProviderItemCompletion = (
        context: StreamUpdateContext,
        notificationParams: unknown,
    ): boolean => {
        const itemId = readProviderEventItemId(notificationParams);
        if (!itemId) return false;
        const itemType = readNormalizedProviderEventItemType(notificationParams);
        if (!itemType || !BLOCKING_CODEX_APP_SERVER_ITEM_TYPES.has(itemType)) return false;
        return !historyBoundary.rememberConsumedItem(
            context.streamScopeId,
            itemId,
            readProviderEventTurnId(notificationParams),
        );
    };

    const adoptNativeTurnFromProviderActivity = async (
        activityParams: unknown,
        options?: Readonly<{ turnId?: string | null }>,
    ): Promise<PendingTurn | null> => {
        const activityThreadId = readThreadId(activityParams);
        const startedTurnId = Object.prototype.hasOwnProperty.call(options ?? {}, 'turnId')
            ? options?.turnId ?? null
            : readTurnId(activityParams);
        const trackedTurn = pendingTurn;
        if (trackedTurn) {
            const isSameThreadSuccessorDuringTerminalSettle =
                scheduledPendingTurnFlushReason === 'turn-end'
                && activityThreadId === trackedTurn.threadId
                && Boolean(startedTurnId)
                && Boolean(trackedTurn.turnId)
                && startedTurnId !== trackedTurn.turnId
                && !hasProviderTurnAlreadyTerminated(activityParams, startedTurnId);
            if (!isSameThreadSuccessorDuringTerminalSettle) {
                return trackedTurn;
            }

            // Native goals can start their successor turn immediately after `turn/completed`,
            // before Happier's short terminal settle window has flushed the predecessor. The
            // provider has now supplied an authoritative new same-thread turn id, so retaining
            // the predecessor as the active owner would either drop the successor stream or
            // misclassify its completion as turn-id drift. Close the terminal predecessor first,
            // then let the canonical adoption path below own the successor end to end.
            let releaseHandoffBarrier!: () => void;
            const handoffBarrier = new Promise<void>((resolve) => {
                releaseHandoffBarrier = resolve;
            });
            const handoffClientGeneration = clientLifecycleGeneration;
            nativeTurnHandoffBarrier = handoffBarrier;
            logger.debug('[codex-app-server] Handing off terminal predecessor to native same-thread successor', {
                threadId: trackedTurn.threadId,
                predecessorTurnId: trackedTurn.turnId,
                successorTurnId: startedTurnId,
            });
            try {
                await finishPendingTurn({
                    flushReason: 'turn-end',
                    insideBridgeWork: true,
                });
                if (clientLifecycleGeneration !== handoffClientGeneration) {
                    logger.debug('[codex-app-server] Native successor handoff cancelled by client disposal', {
                        threadId: trackedTurn.threadId,
                        successorTurnId: startedTurnId,
                    });
                    return null;
                }
                return await adoptNativeTurnFromProviderActivity(activityParams, options);
            } finally {
                if (nativeTurnHandoffBarrier === handoffBarrier) {
                    nativeTurnHandoffBarrier = null;
                }
                releaseHandoffBarrier();
            }
        }

        if (threadId && activityThreadId && activityThreadId !== threadId) {
            return null;
        }
        const activeThreadId = threadId ?? activityThreadId;
        if (!activeThreadId) return null;

        if (!threadId && activityThreadId) {
            threadId = activityThreadId;
            publishThreadId();
        }

        if (hasProviderTurnAlreadyTerminated(activityParams, startedTurnId)) {
            logger.debug('[codex-app-server] Ignoring activity for already-terminal native turn', {
                threadId: activeThreadId,
                turnId: startedTurnId,
            });
            return null;
        }

        pendingTurnStartSeqInclusive = readLastObservedMessageSeq(params.session);
        activeTurnHasMeaningfulContextWindowRecoveryActivity = false;
        const changeTrackingReady = beginTurnChangeTracking();
        const adoptedTurn = createPendingTurn(activeThreadId, {
            // Provider-originated work has no request-local fact proving which credential epoch
            // launched it. The identity current at first observation may have been hot-applied
            // after the provider turn started, so exact account attribution must fail closed.
            connectedServiceRuntimeIdentityAtStart: null,
        });
        adoptedTurn.promise.catch(() => undefined);
        pendingTurn = startedTurnId ? { ...adoptedTurn, turnId: startedTurnId } : adoptedTurn;
        pendingTurnHasProviderAttributedActivity = true;
        latestPendingTurnId = startedTurnId ?? null;
        activeProviderTurnItemIds.clear();
        persistedMediaDedupeKeys.clear();
        turnInFlight = true;
        // Codex starts extension-owned idle work, including goal continuations, as regular turns.
        // Regular turns accept explicit turn/steer; queue-vs-live delivery remains a host policy
        // decision, while review/compaction and terminal-settling windows are fenced separately.
        markActiveTurnSteerable();
        setThinking(true);
        recordInProgressBestEffort(pendingTurn.turnId);
        await changeTrackingReady;
        await turnBoundaryTracker.beginTurn({
            turnId: startedTurnId,
            startUserMessageLocalId: null,
            startSeqInclusive: pendingTurnStartSeqInclusive,
        });
        return pendingTurn;
    };

    const bindActiveNativeTurnIdFromProviderActivity = async (
        activeTurn: PendingTurn,
        activityParams: unknown,
        options?: Readonly<{ turnId?: string | null }>,
    ): Promise<void> => {
        const startedTurnId = Object.prototype.hasOwnProperty.call(options ?? {}, 'turnId')
            ? options?.turnId ?? null
            : readTurnId(activityParams);
        pendingTurnHasProviderAttributedActivity = true;
        if (!startedTurnId || activeTurn.turnId === startedTurnId) return;
        pendingTurn = { ...activeTurn, turnId: startedTurnId };
        const deferredTerminal = acknowledgePendingTurnStart(activeTurn, startedTurnId);
        latestPendingTurnId = startedTurnId;
        await turnBoundaryTracker.updateActiveTurnId(startedTurnId);
        recordInProgressBestEffort(startedTurnId);
        if (deferredTerminal) {
            await settleTerminalPendingTurn(
                deferredTerminal.method,
                deferredTerminal.notificationParams,
                deferredTerminal.terminalTurnId,
            );
        }
    };

    const ensureActiveTurnForProviderRequest = async (requestParams: unknown): Promise<boolean> => {
        const requestTurnId = readProviderEventTurnId(requestParams);
        if (hasProviderTurnAlreadyTerminated(requestParams, requestTurnId)) {
            return false;
        }
        if (!pendingTurn && !requestTurnId) {
            logger.debug('[codex-app-server] Ignoring provider request without an active turn or provider turn id');
            return false;
        }
        const activeTurn = await adoptNativeTurnFromProviderActivity(requestParams, {
            turnId: requestTurnId,
        });
        if (!activeTurn || !notificationMatchesPendingTurn(requestParams)) return false;
        await bindActiveNativeTurnIdFromProviderActivity(activeTurn, requestParams, {
            turnId: requestTurnId,
        });
        return true;
    };

    const notificationMatchesPendingTurn = (notificationParams: unknown): boolean => {
        const activeTurn = pendingTurn;
        if (!activeTurn) return false;
        const notificationThreadId = readThreadId(notificationParams);
        if (notificationThreadId && notificationThreadId !== activeTurn.threadId) {
            return false;
        }
        const notificationTurnId = readProviderEventTurnId(notificationParams);
        if (hasProviderTurnAlreadyTerminated(notificationParams, notificationTurnId)) {
            return false;
        }
        return !notificationTurnId || !activeTurn.turnId || notificationTurnId === activeTurn.turnId;
    };

    const terminalNotificationMatchesPendingTurn = (
        notificationParams: unknown,
        terminalTurnId: string | null,
    ): boolean => {
        if (!notificationMatchesPendingTurn(notificationParams)) return false;
        if (!terminalTurnId) return true;
        const activeTurn = pendingTurn;
        if (!activeTurn) return false;
        return activeTurn.turnId === terminalTurnId;
    };

    const resolveStreamUpdateContext = async (
        method: string,
        notificationParams: unknown,
    ): Promise<StreamUpdateContext | null> => {
        const hadPendingTurn = Boolean(pendingTurn);
        const notificationTurnId = readProviderEventTurnId(notificationParams);
        if (!hadPendingTurn && !notificationTurnId) return null;
        if (hasProviderTurnAlreadyTerminated(notificationParams, notificationTurnId)) return null;
        const activeTurn = await adoptNativeTurnFromProviderActivity(notificationParams, {
            turnId: notificationTurnId,
        });
        if (!activeTurn) return null;
        if (!hadPendingTurn) {
            logger.debug('[codex-app-server] Adopted native turn from stream notification', {
                method,
                threadId: activeTurn.threadId,
                turnId: activeTurn.turnId,
            });
        }
        const notificationThreadId = readThreadId(notificationParams);
        if (notificationThreadId && notificationThreadId !== activeTurn.threadId) {
            return {
                sidechainId: notificationThreadId,
                streamScopeId: notificationThreadId,
            };
        }
        if (notificationTurnId && activeTurn.turnId && notificationTurnId !== activeTurn.turnId) {
            return null;
        }
        await bindActiveNativeTurnIdFromProviderActivity(activeTurn, notificationParams, {
            turnId: notificationTurnId,
        });
        return {
            sidechainId: null,
            streamScopeId: activeTurn.threadId,
        };
    };

    const registerActiveTurnStreamNotificationHandler = (
        client: DisposableCodexAppServerClient,
        method: string,
        attachedClientGeneration: number,
    ): void => {
        client.registerNotificationHandler(method, (notificationParams) => {
            if (attachedClientGeneration !== clientLifecycleGeneration) return;
            const historyIdentityParams = (() => {
                const record = readRecord(notificationParams);
                const activeTurn = pendingTurn;
                if (!record || !activeTurn?.turnId) return notificationParams;
                return {
                    ...record,
                    ...(readThreadId(notificationParams) ? {} : { threadId: activeTurn.threadId }),
                    ...(readProviderEventTurnId(notificationParams) ? {} : { turnId: activeTurn.turnId }),
                };
            })();
            return historyBoundary.onNotification(
                { method, params: historyIdentityParams },
                () => runBridgeWork({
                    operation: 'provider-notification',
                    details: { method },
                }, async () => {
                    if (attachedClientGeneration !== clientLifecycleGeneration) return;
                    if (method === 'item/started' || method === 'item/completed') {
                        markCorrelatedProviderUserMessageAccepted(
                            notificationParams,
                            readProviderEventTurnId(notificationParams) ?? pendingTurn?.turnId,
                        );
                    }
                    const context = await resolveStreamUpdateContext(method, notificationParams);
                    if (!context) {
                        if (pendingTurn && notificationMatchesPendingTurn(notificationParams)) {
                            if (method === 'item/started') {
                                trackActiveProviderTurnItemStart(notificationParams);
                            } else if (method === 'item/completed') {
                                const clearedActiveItem = trackActiveProviderTurnItemCompletion(notificationParams);
                                if (clearedActiveItem
                                    && scheduledPendingTurnFlushReason === 'turn-end'
                                    && activeProviderTurnItemIds.size === 0) {
                                    schedulePendingTurnFinalization('turn-end');
                                }
                            }
                        }
                        return;
                    }
                    if (context.sidechainId) {
                        await ensureSyntheticSubagentThread(context.sidechainId);
                    } else if (!notificationMatchesPendingTurn(notificationParams)) {
                        return;
                    }
                    if (!context.sidechainId && method === 'item/started') {
                        trackActiveProviderTurnItemStart(notificationParams);
                    }
                    if (method === 'item/completed' && shouldSkipDuplicateBlockingProviderItemCompletion(context, notificationParams)) {
                        return;
                    }
                    const updates = streamEventBridge.onNotification({ method, params: notificationParams });
                    for (const update of updates) {
                        await applyStreamUpdate(update, context);
                    }
                    if (!context.sidechainId && method === 'item/completed') {
                        const clearedActiveItem = trackActiveProviderTurnItemCompletion(notificationParams);
                        if (clearedActiveItem
                            && scheduledPendingTurnFlushReason === 'turn-end'
                            && activeProviderTurnItemIds.size === 0) {
                            schedulePendingTurnFinalization('turn-end');
                        }
                    }
                }),
            );
        });
    };

    const ensureClient = async (): Promise<DisposableCodexAppServerClient> => {
        if (!clientPromise) {
            historyBoundary.beginHydration();
            clientPromise = createCodexAppServerClient({
                cwd: params.directory,
                ...(params.processEnv ? { processEnv: params.processEnv } : {}),
                ...(params.configOverrides ? { configOverrides: params.configOverrides } : {}),
                })
                .then((client) => {
                    const attachedClientGeneration = clientLifecycleGeneration;
                    client.onExit((failure) => {
                        if (attachedClientGeneration !== clientLifecycleGeneration) return;
                        clientPromise = null;
                        void runBridgeWork({ operation: 'provider-exit' }, async () => {
                            if (attachedClientGeneration !== clientLifecycleGeneration) return;
                            if (!pendingTurn) return;
                            await abortPendingTurnWithFailure(failure);
                        }).catch((error) => {
                            logger.debug('[codex-app-server] Failed to settle pending turn after app-server exit', error);
                        });
                    });
                    client.registerNotificationHandler('turn/started', (notificationParams) => {
                        if (attachedClientGeneration !== clientLifecycleGeneration) return;
                        void historyBoundary.onNotification(
                            { method: 'turn/started', params: notificationParams },
                            () => runBridgeWork({
                                operation: 'provider-notification',
                                details: { method: 'turn/started' },
                            }, async () => {
                                if (attachedClientGeneration !== clientLifecycleGeneration) return;
                                const notificationTurnId = readProviderEventTurnId(notificationParams, {
                                    allowTopLevelId: true,
                                });
                                const activeTurn = await adoptNativeTurnFromProviderActivity(notificationParams, {
                                    turnId: notificationTurnId,
                                });
                                if (!activeTurn || !notificationMatchesPendingTurn(notificationParams)) {
                                    return;
                                }
                                publishThreadId();
                                await bindActiveNativeTurnIdFromProviderActivity(activeTurn, notificationParams, {
                                    turnId: notificationTurnId,
                                });
                                if (
                                    pendingTurn?.promise === activeTurn.promise
                                    && scheduledPendingTurnFlushReason === null
                                ) {
                                    markActiveTurnSteerable();
                                }
                                markPendingProviderPromptAccepted(
                                    activeTurn.providerPrompt,
                                    notificationTurnId ?? activeTurn.turnId,
                                );
                                const nextThreadId = readThreadId(notificationParams);
                                if (nextThreadId && nextThreadId !== threadId) {
                                    threadId = nextThreadId;
                                    publishThreadId();
                                }
                                await publishRuntimeContextWindow(readCodexRuntimeContextWindowTokens(notificationParams));
                                turnInFlight = true;
                                setThinking(true);
                            }),
                        ).catch((error) => {
                            logger.debug('[codex-app-server] History boundary rejected turn/started notification', error);
                        });
                    });
                    client.registerNotificationHandler('thread/tokenUsage/updated', (notificationParams) => {
                        void runBridgeWork({
                            operation: 'provider-notification',
                            details: { method: 'thread/tokenUsage/updated' },
                        }, async () => {
                            if (attachedClientGeneration !== clientLifecycleGeneration) return;
                            const notificationThreadId = readThreadId(notificationParams);
                            if (notificationThreadId && threadId && notificationThreadId !== threadId) {
                                return;
                            }

                            const notificationRecord = readRecord(notificationParams);
                            const tokenUsage = readRecord(notificationRecord?.tokenUsage ?? notificationRecord?.token_usage);
                            const totalBreakdown = readCodexTokenUsageBreakdown(tokenUsage?.total);
                            const contextWindowTokens = readCodexRuntimeContextWindowTokens(tokenUsage);

                            await publishRuntimeContextWindow(contextWindowTokens);

                            if (!totalBreakdown) return;

                            params.session.sendCodexMessage({
                                type: 'token_count',
                                tokens: totalBreakdown,
                                ...(contextWindowTokens !== null ? { size: contextWindowTokens } : {}),
                                ...(currentModelId ? { model: currentModelId } : {}),
                                ...(threadId ? { key: `codex-app-server:${threadId}` } : {}),
                                id: randomUUID(),
                            });
                        });
                    });
                    client.registerNotificationHandler('account/rateLimits/updated', (notificationParams) => {
                        void runBridgeWork({
                            operation: 'provider-notification',
                            details: { method: 'account/rateLimits/updated' },
                        }, async () => {
                            if (attachedClientGeneration !== clientLifecycleGeneration) return;
                            await publishRateLimitSnapshot(notificationParams, { mergeWithLast: true });
                        });
                    });
                    client.registerNotificationHandler('thread/goal/updated', (notificationParams) => {
                        void runBridgeWork({
                            operation: 'provider-notification',
                            details: { method: 'thread/goal/updated' },
                        }, async () => {
                            if (attachedClientGeneration !== clientLifecycleGeneration) return;
                            const notificationThreadId = readThreadId(notificationParams);
                            if (notificationThreadId && threadId && notificationThreadId !== threadId) {
                                return;
                            }
                            const record = readRecord(notificationParams);
                            await publishGoalWorkState(record?.goal ?? notificationParams);
                        });
                    });
                    client.registerNotificationHandler('thread/goal/cleared', (notificationParams) => {
                        void runBridgeWork({
                            operation: 'provider-notification',
                            details: { method: 'thread/goal/cleared' },
                        }, async () => {
                            if (attachedClientGeneration !== clientLifecycleGeneration) return;
                            const notificationThreadId = readThreadId(notificationParams);
                            if (notificationThreadId && threadId && notificationThreadId !== threadId) {
                                return;
                            }
                            await clearGoalWorkState();
                        });
                    });
                    client.registerNotificationHandler('error', (notificationParams) => {
                        if (attachedClientGeneration !== clientLifecycleGeneration) return;
                        void historyBoundary.onNotification(
                            { method: 'error', params: notificationParams },
                            () => runBridgeWork({
                                operation: 'provider-notification',
                                details: { method: 'error' },
                            }, async () => {
                                if (attachedClientGeneration !== clientLifecycleGeneration) return;
                                if (!notificationMatchesPendingTurn(notificationParams)) return;
                                // App-server `error` is diagnostic and can be followed by more
                                // activity for the same native turn even when willRetry is false.
                                // Only the provider's terminal turn notification can release the
                                // active owner; otherwise a later prompt can start a split-brain
                                // turn while Codex still considers this one active.
                                logger.debug('[codex-app-server] Awaiting terminal notification after provider error', {
                                    threadId: readThreadId(notificationParams),
                                    turnId: readProviderEventTurnId(notificationParams),
                                    willRetry: readRecord(notificationParams)?.willRetry === true,
                                });
                            }),
                        ).catch((error) => {
                            logger.debug('[codex-app-server] History boundary rejected error notification', error);
                        });
                    });
                    registerActiveTurnStreamNotificationHandler(client, 'item/agentMessage/delta', attachedClientGeneration);
                    registerActiveTurnStreamNotificationHandler(client, 'turn/diff/updated', attachedClientGeneration);
                    registerActiveTurnStreamNotificationHandler(client, 'item/reasoning/summaryTextDelta', attachedClientGeneration);
                    registerActiveTurnStreamNotificationHandler(client, 'item/reasoning/textDelta', attachedClientGeneration);
                    registerActiveTurnStreamNotificationHandler(client, 'item/started', attachedClientGeneration);
                    registerActiveTurnStreamNotificationHandler(client, 'item/completed', attachedClientGeneration);
                    registerActiveTurnStreamNotificationHandler(client, 'rawResponseItem/completed', attachedClientGeneration);
                    const registerHistoryBoundedServerRequest = (method: string): void => {
                        client.registerRequestHandler(method, (requestParams) => historyBoundary.onRequest(
                            { method, params: requestParams },
                            () => runBridgeWork({ operation: 'provider-request-history', details: { method } }, () => handleServerRequest(method, requestParams, { allowProviderEffects: false })),
                            () => runBridgeWork({ operation: 'provider-request', details: { method } }, () => handleServerRequest(method, requestParams)),
                        ));
                    };
                    registerHistoryBoundedServerRequest('item/commandExecution/requestApproval');
                    registerHistoryBoundedServerRequest('item/fileChange/requestApproval');
                    registerHistoryBoundedServerRequest('item/tool/requestUserInput');
                    registerHistoryBoundedServerRequest('item/permissions/requestApproval');
                    client.registerRequestHandler('mcpServer/elicitation/request', (requestParams, message) => historyBoundary.onRequest(
                        { method: 'mcpServer/elicitation/request', params: requestParams },
                        () => mapMcpElicitationResponse({ decision: 'denied' }),
                        () => runBridgeWork({
                            operation: 'provider-request',
                            details: { method: 'mcpServer/elicitation/request' },
                        }, () => handleMcpElicitationRequest(requestParams, message)),
                    ));
                    client.registerRequestHandler('account/chatgptAuthTokens/refresh', (requestParams) => {
                        return runBridgeWork({
                            operation: 'provider-request',
                            details: { method: 'account/chatgptAuthTokens/refresh' },
                        }, async () => {
                            if (typeof params.onChatGptAuthTokensRefresh !== 'function') {
                                throw new Error('connected_service_chatgpt_refresh_unavailable');
                            }
                            const refreshed = await params.onChatGptAuthTokensRefresh(requestParams);
                            if (
                                latestConnectedServiceRuntimeIdentity
                                && (
                                    !refreshed.chatgptAccountId
                                    || refreshed.chatgptAccountId === latestConnectedServiceRuntimeIdentity.activeAccountId
                                )
                            ) {
                                latestConnectedServiceRuntimeIdentity = {
                                    ...latestConnectedServiceRuntimeIdentity,
                                    credentialFingerprint: computeConnectedServiceAccessTokenFingerprint(refreshed.accessToken),
                                    credentialRevision: refreshed.credentialRevision
                                        ?? latestConnectedServiceRuntimeIdentity.credentialRevision
                                        ?? null,
                                    source: 'token_refresh',
                                };
                            }
                            return refreshed;
                        });
                    });
                    const registerTerminalHandler = (method: string): void => {
                        client.registerNotificationHandler(method, async (notificationParams) => {
                            if (attachedClientGeneration !== clientLifecycleGeneration) return;
                            await historyBoundary.onNotification(
                                { method, params: notificationParams },
                                () => runBridgeWork({
                                    operation: 'provider-notification',
                                    details: { method },
                                }, async () => {
                                if (attachedClientGeneration !== clientLifecycleGeneration) return;
                                const terminalTurnId = readProviderEventTurnId(notificationParams, {
                                    allowTopLevelId: true,
                                });
                                const activeTurn = pendingTurn;
                                const terminalThreadId = readThreadId(notificationParams);
                                const canonicalParentThreadId = activeTurn?.threadId ?? threadId;
                                // A child-thread terminal can never identify or settle the primary
                                // turn. Classify it before primary correlation, and independently of
                                // primary liveness, so late child completion cannot be dropped after
                                // the parent clears pendingTurn.
                                if (
                                    terminalThreadId
                                    && (
                                        syntheticSubagentThreadIds.has(terminalThreadId)
                                        || Boolean(canonicalParentThreadId && terminalThreadId !== canonicalParentThreadId)
                                    )
                                ) {
                                    await finalizeSyntheticSubagentThread(
                                        terminalThreadId,
                                        method === 'turn/completed' ? 'completed' : 'interrupted',
                                    );
                                    return;
                                }
                                const unacknowledgedTurn = activeTurn;
                                if (
                                    terminalTurnId
                                    && unacknowledgedTurn
                                    && !unacknowledgedTurn.turnId
                                ) {
                                    if (pendingTurnHasProviderAttributedActivity) {
                                        await bindActiveNativeTurnIdFromProviderActivity(
                                            unacknowledgedTurn,
                                            notificationParams,
                                            { turnId: terminalTurnId },
                                        );
                                    } else {
                                        retainDeferredUnacknowledgedTerminalNotification({
                                            ownerPromise: unacknowledgedTurn.promise,
                                            method,
                                            notificationParams,
                                            terminalTurnId,
                                        });
                                        return;
                                    }
                                }
                                if (terminalNotificationMatchesPendingTurn(notificationParams, terminalTurnId)) {
                                    await settleTerminalPendingTurn(method, notificationParams, terminalTurnId);
                                    return;
                                }
                                // No pending turn to settle: nothing owns this completion.
                                if (!activeTurn) {
                                    return;
                                }
                                // Same-thread (or thread-less) terminal notification that did not
                                // match the tracked pendingTurn. If it merely re-emits an
                                // already-terminated turn (stale replay on resume), ignore it — we
                                // must never settle the live turn on a prior-era completion.
                                if (hasProviderTurnAlreadyTerminated(notificationParams, terminalTurnId)) {
                                    return;
                                }
                                // A terminal id is not authoritative evidence that the provider
                                // replaced the active owner. Delayed same-thread notifications can
                                // outlive this process's bounded terminal-id history, and a
                                // thread-less child completion is equally ambiguous. Provider
                                // replacements are adopted only from turn-start or stream activity.
                                logger.debug('[codex-app-server] Ignoring terminal notification for an unknown mismatched turn', {
                                    method,
                                    threadId: activeTurn.threadId,
                                    trackedTurnId: activeTurn.turnId,
                                    terminalTurnId,
                                });
                                }),
                            );
                        });
                    };
                    registerTerminalHandler('turn/completed');
                    registerTerminalHandler('turn/interrupted');
                    return client;
                })
                .catch((error) => {
                    clientPromise = null;
                    throw error;
                });
        }
        return await clientPromise;
    };

    const disposeClient = async (options?: Readonly<{
        emitUndeliverablePrompts?: boolean;
        pendingTurnError?: Error;
    }>): Promise<void> => {
        clientLifecycleGeneration += 1;
        if (options?.emitUndeliverablePrompts !== false) {
            emitAllPendingProviderPromptsAsUndeliverable();
        }
        const activeClientPromise = clientPromise;
        clientPromise = null;
        if (!activeClientPromise) {
            await finishPendingTurn(options?.pendingTurnError
                ? {
                    error: options.pendingTurnError,
                    emitUndeliverablePrompt: options.emitUndeliverablePrompts,
                    flushReason: 'abort',
                }
                : undefined);
            return;
        }
        try {
            const client = await activeClientPromise;
            await client.dispose(options?.pendingTurnError
                ? { pendingRequestError: options.pendingTurnError }
                : undefined);
        } finally {
            await finishPendingTurn({
                ...(options?.pendingTurnError ? { error: options.pendingTurnError } : {}),
                emitUndeliverablePrompt: options?.emitUndeliverablePrompts,
                flushReason: 'abort',
            });
        }
    };

    const resumeThread = async (
        client: DisposableCodexAppServerClient,
        requestedThreadId: string,
        options: Readonly<{
            preserveRequestedThreadId: boolean;
            strictNativeResumeIdentity?: boolean;
            allowOversizedResponseRecovery?: boolean;
            includeTurns?: boolean;
        }>,
    ): Promise<Readonly<{ nextThreadId: string; response: unknown }>> => {
        historyBoundary.beginHydration();
        const resumeRequestOptions = { timeoutMs: null } as const;
        const recoveryReadRequestOptions = options.allowOversizedResponseRecovery
            ? { timeoutMs: readCodexAppServerResumeRecoveryTimeoutMs(runtimeEnv) }
            : undefined;
        const readResumedThreadHistory = async (): Promise<unknown> => {
            const startedAt = Date.now();
            logger.debug('[codex-app-server] Reading authoritative thread history after oversized resume response', {
                threadId: requestedThreadId,
                timeoutMs: recoveryReadRequestOptions?.timeoutMs ?? null,
            });
            try {
                const result = await client.request('thread/read', {
                    threadId: requestedThreadId,
                    includeTurns: true,
                }, recoveryReadRequestOptions);
                logger.debug('[codex-app-server] Authoritative thread history read completed after oversized resume response', {
                    threadId: requestedThreadId,
                    elapsedMs: Date.now() - startedAt,
                });
                return result;
            } catch (error) {
                logger.debug('[codex-app-server] Authoritative thread history read failed after oversized resume response', {
                    threadId: requestedThreadId,
                    elapsedMs: Date.now() - startedAt,
                    error,
                });
                throw error;
            }
        };
        const recoverOversizedResumeResponse = async (error: unknown): Promise<unknown | null> => {
            if (!options.allowOversizedResponseRecovery || !isCodexAppServerJsonLineTooLargeError(error)) {
                return null;
            }
            logger.debug('[codex-app-server] thread/resume response exceeded JSON line limit; reading authoritative thread history after resume side effect', {
                threadId: requestedThreadId,
                maxChars: error.maxChars,
            });
            return await readResumedThreadHistory();
        };
        const requestParams = {
            threadId: requestedThreadId,
            cwd: params.directory,
            ...(currentModelId ? { model: currentModelId } : {}),
            ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
            ...buildThreadConfigOverrideParams(currentReasoningEffort),
            ...buildCurrentPermissionParams('thread'),
            persistExtendedHistory: true,
            excludeTurns: options.includeTurns === true ? false : true,
        };
        let response: unknown;
        try {
            response = await client.request('thread/resume', requestParams, resumeRequestOptions);
            if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
                permissionSupport = 'supported';
            }
        } catch (error) {
            const recoveredResponse = await recoverOversizedResumeResponse(error);
            if (recoveredResponse) {
                if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
                    permissionSupport = 'supported';
                }
                response = recoveredResponse;
            } else {
                if (!shouldRetryWithoutPermissionProfile(error, requestParams)) {
                    throw error;
                }
                permissionSupport = 'legacy';
                try {
                    response = await client.request('thread/resume', {
                        threadId: requestedThreadId,
                        cwd: params.directory,
                        ...(currentModelId ? { model: currentModelId } : {}),
                        ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
                        ...buildThreadConfigOverrideParams(currentReasoningEffort),
                        ...buildCurrentLegacyPermissionParams('thread'),
                        persistExtendedHistory: true,
                        excludeTurns: options.includeTurns === true ? false : true,
                    }, resumeRequestOptions);
                } catch (legacyError) {
                    const legacyRecoveredResponse = await recoverOversizedResumeResponse(legacyError);
                    if (!legacyRecoveredResponse) {
                        throw legacyError;
                    }
                    response = legacyRecoveredResponse;
                }
            }
        }
        const observedThreadId = readThreadId(response);
        if (
            options.strictNativeResumeIdentity === true
            && observedThreadId
            && observedThreadId !== requestedThreadId
        ) {
            throw new CodexAppServerResumeIdentityMismatchError(
                requestedThreadId,
                observedThreadId,
            );
        }
        await historyBoundary.hydrateFromThreadSnapshot(response);
        return {
            // An exact local native return accepts an omitted id semantically;
            // ordinary resume and recovery retain their established response-id
            // behavior.
            nextThreadId: options.strictNativeResumeIdentity === true
                ? requestedThreadId
                : options.preserveRequestedThreadId
                    ? requestedThreadId
                    : observedThreadId ?? requestedThreadId,
            response,
        };
    };

    const applyStartOrLoadResponse = async (
        client: DisposableCodexAppServerClient,
        nextThreadId: string,
        startOrLoadResponse: unknown,
        options: Readonly<{ publishThreadIdImmediately?: boolean }> = {},
    ): Promise<void> => {
        const activeProviderTurn = pendingTurn;
        threadId = nextThreadId;
        currentModelId = readModelId(startOrLoadResponse) ?? currentModelId;
        const serviceTierFromResponse = readServiceTier(startOrLoadResponse);
        // Codex app-server may omit `serviceTier` from thread/start responses even when an explicit
        // override was sent. Do not clear an explicit override based on a missing/empty response.
        if (serviceTierFromResponse !== null) {
            currentServiceTier = serviceTierFromResponse;
        } else if (!hasServiceTierOverride) {
            currentServiceTier = null;
        }
        if (!activeProviderTurn || activeProviderTurn.threadId !== nextThreadId) {
            turnBoundaryTracker.initializeFromCurrentMetadata();
            await finishPendingTurn({ flushReason: 'abort' });
        }
        if (options.publishThreadIdImmediately !== false) {
            publishThreadId();
        }
        await publishActivePermissionProfile(startOrLoadResponse);
        await refreshGoalForThread(client, nextThreadId).catch((error) => {
            logger.debug('[codex-app-server] Failed to refresh native goal state (non-fatal)', {
                threadId: nextThreadId,
                error,
            });
        });
        await publishSessionControls(client);
        usageLimitRecoveryScheduler.read(params.session.sessionId);
    };

    const startOrLoad = async (options: CodexAppServerStartOrLoadOptions = {}): Promise<void> => {
        // A runtime may attach more than once without replacing its app-server client (for
        // example resume fallback or an explicit second load). Every attach must re-arm the
        // history fence before the provider can emit notifications for the selected thread.
        historyBoundary.beginHydration();
        const resumeId = trimSessionId(options.resumeId);
        const existingSessionId = trimSessionId(options.existingSessionId);
        if (resumeId && options.strictNativeResumeIdentity !== true) {
            publishRequestedResumeThreadId(resumeId);
        } else if (existingSessionId) {
            publishRequestedResumeThreadId(existingSessionId);
        }
        const client = await ensureClient();
        const startOrLoadResult = await (async (): Promise<Readonly<{ nextThreadId: string; response: unknown }>> => {
            const importHistory = options.importHistory === true;
            if (resumeId) {
                return await resumeThread(client, resumeId, {
                    preserveRequestedThreadId: options.strictNativeResumeIdentity === true,
                    strictNativeResumeIdentity: options.strictNativeResumeIdentity === true,
                    allowOversizedResponseRecovery: !importHistory,
                    includeTurns: importHistory,
                });
            }
            if (existingSessionId) {
                return await resumeThread(client, existingSessionId, {
                    preserveRequestedThreadId: false,
                    allowOversizedResponseRecovery: !importHistory,
                    includeTurns: importHistory,
                });
            }
            const requestParams = {
                cwd: params.directory,
                ...(currentModelId ? { model: currentModelId } : {}),
                ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
                ...buildThreadConfigOverrideParams(currentReasoningEffort),
                ...buildCurrentPermissionParams('thread'),
                experimentalRawEvents: true,
                persistExtendedHistory: true,
            };
            let response: unknown;
            try {
                response = await client.request('thread/start', requestParams);
                if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
                    permissionSupport = 'supported';
                }
            } catch (error) {
                if (!shouldRetryWithoutPermissionProfile(error, requestParams)) {
                    throw error;
                }
                permissionSupport = 'legacy';
                response = await client.request('thread/start', {
                    cwd: params.directory,
                    ...(currentModelId ? { model: currentModelId } : {}),
                    ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
                    ...buildThreadConfigOverrideParams(currentReasoningEffort),
                    ...buildCurrentLegacyPermissionParams('thread'),
                    experimentalRawEvents: true,
                    persistExtendedHistory: true,
                });
            }
            const startedThreadId = readThreadId(response);
            if (!startedThreadId) {
                throw new Error('Codex app-server thread/start returned no thread id');
            }
            await historyBoundary.hydrateFromThreadSnapshot(response);
            return { nextThreadId: startedThreadId, response };
        })();
        await applyStartOrLoadResponse(
            client,
            startOrLoadResult.nextThreadId,
            startOrLoadResult.response,
            { publishThreadIdImmediately: Boolean(resumeId || existingSessionId) },
        );
        const initialGoal = options.initialGoal;
        if (initialGoal?.objective) {
            const response = await client.request('thread/goal/set', {
                threadId: startOrLoadResult.nextThreadId,
                objective: trimStringValue(initialGoal.objective),
                ...(initialGoal.status ? { status: initialGoal.status } : {}),
                ...(Object.prototype.hasOwnProperty.call(initialGoal, 'tokenBudget')
                    ? { tokenBudget: initialGoal.tokenBudget ?? null }
                    : {}),
            });
            await publishGoalWorkState(response);
        }
        if (params.pendingQueue?.drainAfterStartOrLoad === true) {
            await params.pendingQueue.drainPending({
                maxPopPerWake: params.pendingQueue.maxPopPerWake,
                shouldContinue: params.pendingQueue.shouldDrainPendingMessages,
                logPrefix: '[CodexAppServer]',
                reason: 'startOrLoad',
            });
        }
    };

    const compactActiveThread = async (activeThreadId: string): Promise<void> => {
        await waitForNativeTurnHandoff();
        if (pendingTurn) {
            throw new Error('Codex app-server already has a turn in flight');
        }
        const client = await ensureClient();
        await waitForNativeTurnHandoff();
        if (pendingTurn) {
            throw new Error('Codex app-server already has a turn in flight');
        }
        pendingTurnStartSeqInclusive = readLastObservedMessageSeq(params.session);
        activeTurnHasMeaningfulContextWindowRecoveryActivity = false;
        const changeTrackingReady = beginTurnChangeTracking();
        const activeTurn = createPendingTurn(activeThreadId, {
            connectedServiceRuntimeIdentityAtStart: latestConnectedServiceRuntimeIdentity,
        });
        activeTurn.promise.catch(() => undefined);
        pendingTurn = activeTurn;
        pendingTurnHasProviderAttributedActivity = false;
        latestPendingTurnId = null;
        persistedMediaDedupeKeys.clear();
        turnInFlight = true;
        markActiveTurnNonSteerable();
        setThinking(true);
        recordInProgressBestEffort();
        await changeTrackingReady;
        try {
            const response = await client.request('thread/compact/start', {
                threadId: activeThreadId,
            });
            const startedTurnId = readTurnId(response);
            if (startedTurnId) {
                pendingTurn = { ...activeTurn, turnId: startedTurnId };
                latestPendingTurnId = startedTurnId;
                recordInProgressBestEffort(startedTurnId);
            }
            const deferredTerminal = acknowledgePendingTurnStart(activeTurn, startedTurnId);
            if (deferredTerminal) {
                await settleTerminalPendingTurn(
                    deferredTerminal.method,
                    deferredTerminal.notificationParams,
                    deferredTerminal.terminalTurnId,
                );
            }
            await (pendingTurn ?? activeTurn).promise;
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            await finishPendingTurn({ error: failure, flushReason: 'abort' });
            throw failure;
        }
    };

    const recoverFromCodexContextWindowExhaustion = async (
        activeThreadId: string,
        originalFailure: Error,
    ): Promise<void> => {
        logger.debug('[codex-app-server] Codex context window exhausted; compacting thread before recovery', {
            threadId: activeThreadId,
            error: originalFailure.message,
        });
        await compactActiveThread(activeThreadId);
        const client = await ensureClient();
        const resumedThread = await resumeThread(client, activeThreadId, {
            preserveRequestedThreadId: true,
        });
        await applyStartOrLoadResponse(
            client,
            resumedThread.nextThreadId,
            resumedThread.response,
        );
    };

    const surfaceOriginalContextWindowFailure = async (
        originalFailure: Error,
        debugMessage: string,
        debugDetails: unknown,
    ): Promise<void> => {
        logger.debug(debugMessage, debugDetails);
        const issue = await surfaceCodexAppServerTurnFailure(originalFailure, null);
        await updateUsageLimitRecoveryFromSurfacedIssue(issue);
    };

    const surfaceOriginalContextWindowFailureAfterRecoveryError = async (
        originalFailure: Error,
        recoveryError: unknown,
    ): Promise<void> => {
        await surfaceOriginalContextWindowFailure(
            originalFailure,
            '[codex-app-server] Codex context-window recovery failed; surfacing original turn failure',
            recoveryError,
        );
    };

    const waitForConnectedServiceAuthTransportInvalidationRecovery = async (): Promise<void> => {
        const recovery = connectedServiceAuthTransportInvalidationRecoveryPromise;
        if (recovery) {
            await recovery;
        }
    };

    const restartCodexRuntimeForConnectedServiceSwitch = async (activeThreadId: string): Promise<void> => {
        if (connectedServiceAuthTransportInvalidationRecoveryPromise) {
            await connectedServiceAuthTransportInvalidationRecoveryPromise;
            return;
        }
        params.session.sendSessionEvent({
            type: 'message',
            message: CODEX_APP_SERVER_CONNECTED_SERVICE_SWITCH_RESTART_STATUS_MESSAGE,
        });
        logger.debug('[codex-app-server] restarting process after Codex auth account changed', {
            threadId: activeThreadId,
        });
        const recovery = (async () => {
            const pendingTurnError = new CodexAppServerConnectedServiceAuthTransportInvalidatedTurn();
            await disposeClient({
                emitUndeliverablePrompts: false,
                pendingTurnError,
            });
            const resumedClient = await ensureClient();
            const resumedThread = await resumeThread(resumedClient, activeThreadId, {
                preserveRequestedThreadId: true,
            });
            await applyStartOrLoadResponse(
                resumedClient,
                resumedThread.nextThreadId,
                resumedThread.response,
            );
        })();
        connectedServiceAuthTransportInvalidationRecoveryPromise = recovery;
        try {
            await recovery;
        } finally {
            if (connectedServiceAuthTransportInvalidationRecoveryPromise === recovery) {
                connectedServiceAuthTransportInvalidationRecoveryPromise = null;
            }
        }
    };

    const beginPendingTurnForThread = async (
        activeThreadId: string,
        options?: Readonly<{
            localId?: string | null;
            userMessageSeq?: number | null;
            providerPrompt?: CodexAppServerPendingProviderPrompt | null;
        }>,
    ): Promise<PendingTurn> => {
        await waitForNativeTurnHandoff();
        if (pendingTurn) {
            throw new Error('Codex app-server already has a turn in flight');
        }
        pendingTurnStartSeqInclusive = readLastObservedMessageSeq(params.session);
        activeTurnHasMeaningfulContextWindowRecoveryActivity = false;
        const changeTrackingReady = beginTurnChangeTracking();
        const activeTurn = createPendingTurn(activeThreadId, {
            providerPrompt: options?.providerPrompt ?? null,
            connectedServiceRuntimeIdentityAtStart: latestConnectedServiceRuntimeIdentity,
        });
        activeTurn.promise.catch(() => undefined);
        pendingTurn = activeTurn;
        pendingTurnHasProviderAttributedActivity = false;
        latestPendingTurnId = null;
        persistedMediaDedupeKeys.clear();
        turnInFlight = true;
        // A locally-created pending turn is not steerable until Codex acknowledges `turn/start`
        // or emits matching `turn/started` provider activity. Starting the Pending pump here can
        // claim a `steer_now` row before the native turn exists and block it incorrectly.
        markActiveTurnNonSteerable();
        setThinking(true);
        recordInProgressBestEffort();
        await changeTrackingReady;
        await turnBoundaryTracker.beginTurn({
            turnId: null,
            startUserMessageLocalId: options?.localId ?? null,
            startUserMessageSeq: options?.userMessageSeq ?? null,
            startSeqInclusive: pendingTurnStartSeqInclusive,
        });
        return activeTurn;
    };

    const startReviewTurn = async (
        request: CodexAppServerReviewStartRequest,
    ): Promise<string | UnsupportedSessionRuntimeMethodResult | void> => {
        let recoveredContextWindowExhaustion = false;
        let recoveredTemporaryRecoverableTurnFailure = false;
        let originalContextWindowExhaustionFailure: Error | null = null;
        let originalTemporaryRecoverableTurnFailure: Error | null = null;
        while (true) {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('Codex app-server startReview requires an active thread');
            }
            if (pendingTurn) {
                throw new Error('Codex app-server already has a turn in flight');
            }
            const client = await ensureClient();
            const activeTurn = await beginPendingTurnForThread(activeThreadId);
            try {
                const response = await client.request('review/start', {
                    threadId: activeThreadId,
                    target: request.target,
                    delivery: 'inline',
                });
                const startedTurnId = readTurnId(response);
                if (startedTurnId) {
                    pendingTurn = { ...activeTurn, turnId: startedTurnId };
                    latestPendingTurnId = startedTurnId;
                    recordInProgressBestEffort(startedTurnId);
                    await turnBoundaryTracker.updateActiveTurnId(startedTurnId);
                }
                const deferredTerminal = acknowledgePendingTurnStart(activeTurn, startedTurnId);
                if (deferredTerminal) {
                    await settleTerminalPendingTurn(
                        deferredTerminal.method,
                        deferredTerminal.notificationParams,
                        deferredTerminal.terminalTurnId,
                    );
                }
                await (pendingTurn ?? activeTurn).promise;
                return startedTurnId ?? undefined;
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                if (isCodexAppServerReviewStartUnavailableError(failure)) {
                    await finishPendingTurn({ flushReason: 'abort' });
                    return unsupportedSessionRuntimeMethod('review/start');
                }
                activeTurn.promise.catch(() => undefined);
                await finishPendingTurn({ error: failure, flushReason: 'abort' });
                if (isCodexAppServerTemporaryRecoverableTurnFailureError(failure)) {
                    const originalFailure: Error = originalTemporaryRecoverableTurnFailure ?? failure;
                    originalTemporaryRecoverableTurnFailure = originalFailure;
                    const retryDecision = resolveRecoverableTurnFailureRetryDecision({
                        attemptCount: recoveredTemporaryRecoverableTurnFailure ? 1 : 0,
                        maxRetries: 1,
                        providerWillRetry: false,
                        failureRetryAfterMs: null,
                        failedTurnHadMeaningfulActivity: false,
                        promptMode: 'retry_original',
                        originalPrompt: '',
                        continuationPrompt: '',
                    });
                    if (retryDecision.action === 'retry') {
                        recoveredTemporaryRecoverableTurnFailure = true;
                        continue;
                    }
                    if (retryDecision.action === 'budget_exhausted') {
                        throw resolveRecoverableTurnFailureSecondFailure({
                            originalFailure,
                            latestFailure: failure,
                        }).failure;
                    }
                    throw originalFailure;
                }
                if (isCodexAppServerContextWindowExhaustedError(failure)) {
                    const originalFailure: Error = originalContextWindowExhaustionFailure ?? failure;
                    originalContextWindowExhaustionFailure = originalFailure;
                    const retryDecision = resolveRecoverableTurnFailureRetryDecision({
                        attemptCount: recoveredContextWindowExhaustion ? 1 : 0,
                        maxRetries: 1,
                        providerWillRetry: false,
                        failureRetryAfterMs: null,
                        failedTurnHadMeaningfulActivity: false,
                        promptMode: 'retry_original',
                        originalPrompt: '',
                        continuationPrompt: '',
                    });
                    if (retryDecision.action === 'retry') {
                        recoveredContextWindowExhaustion = true;
                        try {
                            await recoverFromCodexContextWindowExhaustion(activeThreadId, originalFailure);
                        } catch (recoveryError) {
                            await surfaceOriginalContextWindowFailureAfterRecoveryError(originalFailure, recoveryError);
                            throw originalFailure;
                        }
                        continue;
                    }
                    if (retryDecision.action === 'budget_exhausted') {
                        const secondFailureDecision = resolveRecoverableTurnFailureSecondFailure({
                            originalFailure,
                            latestFailure: failure,
                        });
                        await surfaceOriginalContextWindowFailureAfterRecoveryError(secondFailureDecision.failure, failure);
                        throw secondFailureDecision.failure;
                    }
                    throw originalFailure;
                }
                throw failure;
            }
        }
    };

    const startInlineReview = async (
        input: unknown,
    ): Promise<Readonly<{ ok: true; reviewTurnId: string | null }> | UnsupportedSessionRuntimeMethodResult | Readonly<{ ok: false; errorCode: 'invalid_parameters' | 'inline_review_not_supported'; error: string }>> => {
        const parsedInlineInput = ReviewStartInputSchema.safeParse(input);
        if (!parsedInlineInput.success || parsedInlineInput.data.engineIds.length !== 1 || parsedInlineInput.data.engineIds[0] !== 'codex') {
            return { ok: false, errorCode: 'inline_review_not_supported', error: 'inline_review_not_supported' };
        }

        const resolved = resolveCodexAppServerNativeReviewRequest({
            start: {
                intent: 'review',
                intentInput: input,
            },
        });
        if (!resolved.ok) {
            return { ok: false, errorCode: 'invalid_parameters', error: resolved.error ?? resolved.reason };
        }

        if (!threadId) {
            await startOrLoad({});
        }

        activeInlineReview = true;
        let reviewTurnResult: string | void | UnsupportedSessionRuntimeMethodResult;
        try {
            reviewTurnResult = await startReviewTurn(resolved.request);
        } finally {
            activeInlineReview = false;
        }
        if (reviewTurnResult && typeof reviewTurnResult === 'object') return reviewTurnResult;
        return { ok: true, reviewTurnId: reviewTurnResult ?? null };
    };

    return {
        getSessionId: () => threadId,
        getPublishedSessionId: () => lastPublishedThreadId.value,
        // Codex app-server exposes `turn/steer`, which appends user input to the active in-flight
        // turn without interrupting it. This may not affect a currently-running tool until that
        // tool finishes, but it should still be handled within the same turn.
        supportsInFlightSteer: () => true,
        supportsInFlightConfigApply: () => true,
        canSteerPrompt,
        isTurnInFlight: () => turnInFlight || nativeTurnHandoffBarrier !== null,
        hasActiveProviderTurn: () => pendingTurn !== null || nativeTurnHandoffBarrier !== null,
        beginTurn: () => {
            void beginTurnChangeTracking();
        },
        cancel: async () => {
            await waitForNativeTurnHandoff();
            const activeTurn = pendingTurn;
            if (!activeTurn) {
                emitAllPendingProviderPromptsAsUndeliverable();
                turnInFlight = false;
                clearActiveTurnSteerability();
                setThinking(false);
                return;
            }
            emitAllPendingProviderPromptsAsUndeliverable();
            markActiveTurnNonSteerable();
            const client = await ensureClient();
            const interruptTurnId = (activeTurn.turnId ?? latestPendingTurnId) ?? (await waitForActiveTurnId());
            if (!interruptTurnId) {
                // If we can't resolve the turn id, fall back to tearing down the runtime; this will
                // abort the active work without relying on turn-scoped cancellation.
                await disposeClient();
                return;
            }
            const interrupt = await requestCodexTurnInterruptWithStartupRetry({
                client,
                threadId: activeTurn.threadId,
                turnId: interruptTurnId,
                waitForProviderTerminal: async (waitKind) => await waitForPromiseSettlementWithin(
                    activeTurn.promise,
                    waitKind === 'startup_gap'
                        ? CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_INTERVAL_MS
                        : readCodexAppServerRpcTimeoutMs(runtimeEnv),
                ),
            });
            if (interrupt === 'providerTerminal') return;
            await activeTurn.promise.catch(() => undefined);
        },
        reset: async () => {
            threadId = null;
            currentModeId = null;
            currentModelId = null;
            currentReasoningEffort = null;
            currentServiceTier = null;
            permissionSupport = 'unknown';
            latestConnectedServiceRuntimeIdentity = null;
            await disposeClient();
            turnInFlight = false;
            clearActiveTurnSteerability();
            setThinking(false);
        },
        startOrLoad,
        setSessionMode: async (mode: string) => {
            const client = await ensureClient();
            const nextModeId = trimSessionId(mode);
            if (!nextModeId) {
                throw new Error('Codex app-server setSessionMode requires a non-empty mode id');
            }
            const selection = resolveCodexAppServerCollaborationModeSelection({
                modesResponse: await client.request('collaborationMode/list', {}),
                modelsResponse: await client.request('model/list', {}),
                modeId: nextModeId,
                currentModelId,
                currentReasoningEffort,
            });
            if (!selection) {
                throw new Error(`Unknown Codex app-server collaboration mode: ${mode}`);
            }
            currentModeId = selection.modeId;
            await publishSessionControls(client);
            publishInFlightSteerAvailabilityIfChanged();
        },
        setSessionModel: async (model: string) => {
            currentModelId = trimSessionId(model);
            const client = await ensureClient();
            // Apply model changes per-turn via `turn/start` (we always pass `model` there).
            // Avoid `thread/resume` here: it can be expensive (returns thread content) and failures
            // are treated as best-effort by metadata synchronizers.
            await publishSessionControls(client);
            publishInFlightSteerAvailabilityIfChanged();
        },
        setSessionConfigOption: async (key: string, value: unknown) => {
            if (key === 'reasoning_effort') {
                const nextReasoningEffort = trimStringValue(value);
                if (!nextReasoningEffort) {
                    throw new Error('Codex app-server reasoning_effort requires a non-empty value');
                }
                currentReasoningEffort = nextReasoningEffort;
                const client = await ensureClient();
                await publishSessionControls(client);
                publishInFlightSteerAvailabilityIfChanged();
                return;
            }
            if (key === 'service_tier' || key === 'speed') {
                const nextServiceTier = trimStringValue(value);
                if (nextServiceTier !== 'fast' && nextServiceTier !== 'standard') {
                    throw new Error(`Unsupported Codex app-server Speed value: ${String(value)}`);
                }
                currentServiceTier = nextServiceTier;
                hasServiceTierOverride = true;
                const client = await ensureClient();
                // Apply Speed changes per-turn via `turn/start` (we pass `serviceTier` there).
                await publishSessionControls(client);
                publishInFlightSteerAvailabilityIfChanged();
                return;
            }
            throw new Error(`Unsupported Codex app-server config option: ${String(key)}`);
        },
        steerPrompt: async (prompt: string, options?: CodexAppServerPromptOptions) => {
            assertCodexAppServerPendingIdentity(options);
            const activeTurn = pendingTurn;
            if (!activeTurn) {
                throw new Error('Codex app-server steerPrompt requires an active turn');
            }
            assertConnectedServiceAuthGroupAvailable();
            const client = await ensureClient();
            const expectedTurnId = (activeTurn.turnId ?? latestPendingTurnId) ?? (await waitForActiveTurnId());
            if (pendingTurn?.promise !== activeTurn.promise || !canSteerPrompt()) {
                throw new Error('Codex app-server active turn is not steerable');
            }
            if (!expectedTurnId) {
                throw new Error('Codex app-server steerPrompt requires an active turn id');
            }

            const structuredInput = await buildCodexTurnInputForPrompt(prompt, params.directory, options);
            if (pendingTurn?.promise !== activeTurn.promise || !canSteerPrompt()) {
                throw new Error('Codex app-server active turn is not steerable');
            }
            const textOnlyInput: CodexAppServerTurnInputItem[] = [{ type: 'text', text: prompt }];
            const pendingProviderPrompt = trackPendingProviderPrompt(prompt, options);
            const clientUserMessageId = pendingProviderPrompt.localIds?.length === 1
                ? pendingProviderPrompt.localIds[0]
                : null;
            const payload = {
                threadId: activeTurn.threadId,
                ...(clientUserMessageId ? { clientUserMessageId } : {}),
            };
            const finishAcceptedSteer = async (): Promise<void> => {
                await turnBoundaryTracker.appendSteerMessage({ localId: options?.localId ?? null });
                if (!clientUserMessageId) {
                    markPendingProviderPromptAccepted(pendingProviderPrompt, expectedTurnId);
                }
                options?.onProviderPromptAccepted?.();
            };
            const requestSteer = async (
                input: CodexAppServerTurnInputItem[],
                turnIdKey: 'expectedTurnId' | 'turnId',
            ): Promise<void> => {
                if (pendingTurn?.promise !== activeTurn.promise || !canSteerPrompt()) {
                    throw new Error('Codex app-server active turn is not steerable');
                }
                await client.request('turn/steer', {
                    ...payload,
                    input,
                    [turnIdKey]: expectedTurnId,
                });
            };
            const requestSteerWithStaleTurnRecovery = async (
                input: CodexAppServerTurnInputItem[],
                turnIdKey: 'expectedTurnId' | 'turnId',
            ): Promise<void> => {
                try {
                    await requestSteer(input, turnIdKey);
                } catch (error) {
                    if (
                        isCodexAppServerNoActiveTurnToSteerError(error)
                        && pendingTurn?.promise === activeTurn.promise
                    ) {
                        logger.debug('[codex-app-server] Native turn already inactive during steer; clearing local pending turn state');
                        await finishPendingTurn({ flushReason: 'abort' });
                    }
                    throw error;
                }
            };
            try {
                await requestSteerWithStaleTurnRecovery(structuredInput, 'expectedTurnId');
            } catch (error) {
                if (structuredInput.length > 1 && isCodexAppServerInvalidParamsError(error)) {
                    try {
                        await requestSteerWithStaleTurnRecovery(textOnlyInput, 'expectedTurnId');
                    } catch (fallbackError) {
                        clearPendingProviderPrompt(pendingProviderPrompt);
                        throw fallbackError;
                    }
                    await finishAcceptedSteer();
                    return;
                }
                // Backward compatibility: older experimental app-server builds used `turnId` instead
                // of `expectedTurnId`.
                const message = error instanceof Error ? error.message : String(error ?? '');
                const normalized = message.toLowerCase();
                const looksLikeParamMismatch =
                    (normalized.includes('expectedturnid') || normalized.includes('expected turn') || normalized.includes('turnid'))
                    && (normalized.includes('require') || normalized.includes('missing') || normalized.includes('unknown') || normalized.includes('invalid'));
                if (!looksLikeParamMismatch) {
                    clearPendingProviderPrompt(pendingProviderPrompt);
                    throw error;
                }
                try {
                    await requestSteerWithStaleTurnRecovery(structuredInput, 'turnId');
                } catch (legacyError) {
                    if (structuredInput.length > 1 && isCodexAppServerInvalidParamsError(legacyError)) {
                        try {
                            await requestSteerWithStaleTurnRecovery(textOnlyInput, 'turnId');
                        } catch (fallbackError) {
                            clearPendingProviderPrompt(pendingProviderPrompt);
                            throw fallbackError;
                        }
                        await finishAcceptedSteer();
                        return;
                    }
                    clearPendingProviderPrompt(pendingProviderPrompt);
                    throw legacyError;
                }
            }
            await finishAcceptedSteer();
        },
        compactContext: async (_command: string) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('Codex app-server compactContext requires an active thread');
            }
            await compactActiveThread(activeThreadId);
        },
        startReview: async (request: CodexAppServerReviewStartRequest) => {
            const result = await startReviewTurn(request);
            return typeof result === 'string' ? undefined : result;
        },
        startInlineReview,
        handleUserMessage: async (request) => {
            const reviewInput = parseCodexReviewCommand(request.text);
            if (!reviewInput) return { handled: false };
            return {
                handled: true,
                result: await startInlineReview(reviewInput),
            };
        },
        sendPrompt: async (prompt: string, options?: CodexAppServerPromptOptions) => {
            assertCodexAppServerPendingIdentity(options);
            let recoveredContextWindowExhaustion = false;
            let recoveredTemporaryRecoverableTurnFailure = false;
            let originalContextWindowExhaustionFailure: Error | null = null;
            let originalTemporaryRecoverableTurnFailure: Error | null = null;
            let promptForAttempt = prompt;
            let optionsForAttempt: CodexAppServerPromptOptions | undefined = options;
            while (true) {
                const activeThreadId = threadId;
                if (!activeThreadId) {
                    throw new Error('Codex app-server sendPrompt requires an active thread');
                }
                if (pendingTurn) {
                    throw new Error('Codex app-server already has a turn in flight');
                }
                assertConnectedServiceAuthGroupAvailable();
                const client = await ensureClient();
                const pendingProviderPrompt = trackPendingProviderPrompt(promptForAttempt, optionsForAttempt);
                const activeTurn = await beginPendingTurnForThread(activeThreadId, {
                    localId: optionsForAttempt?.localId ?? null,
                    userMessageSeq: optionsForAttempt?.userMessageSeq ?? null,
                    providerPrompt: pendingProviderPrompt,
                });
                try {
                    const collaborationMode = currentModeId
                        ? resolveCodexAppServerCollaborationModeSelection({
                            modesResponse: await client.request('collaborationMode/list', {}),
                            modelsResponse: await client.request('model/list', {}),
                            modeId: currentModeId,
                            currentModelId,
                            currentReasoningEffort,
                        })?.payload
                        : null;
                    const input = await buildCodexTurnInputForPrompt(promptForAttempt, params.directory, optionsForAttempt);
                    const textOnlyInput = [{ type: 'text', text: promptForAttempt }] satisfies CodexAppServerTurnInputItem[];
                    const baseTurnStartParams = {
                        threadId: activeThreadId,
                        input,
                        ...(currentModelId ? { model: currentModelId } : {}),
                        ...(currentReasoningEffort ? { effort: currentReasoningEffort } : {}),
                        ...(hasServiceTierOverride ? (currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null }) : {}),
                        ...(collaborationMode ? { collaborationMode } : {}),
                    };
                    let turnStartParams = {
                        ...baseTurnStartParams,
                        ...buildCurrentPermissionParams('turn'),
                    };
                    let response: unknown;
                    try {
                        response = await client.request('turn/start', turnStartParams);
                        if (Object.prototype.hasOwnProperty.call(turnStartParams, 'permissions')) {
                            permissionSupport = 'supported';
                        }
                    } catch (error) {
                        if (shouldRetryWithoutPermissionProfile(error, turnStartParams)) {
                            permissionSupport = 'legacy';
                            turnStartParams = {
                                ...baseTurnStartParams,
                                ...buildCurrentLegacyPermissionParams('turn'),
                            };
                            try {
                                response = await client.request('turn/start', turnStartParams);
                            } catch (legacyError) {
                                if (input.length > 1 && isCodexAppServerInvalidParamsError(legacyError)) {
                                    response = await client.request('turn/start', {
                                        ...turnStartParams,
                                        input: textOnlyInput,
                                    });
                                } else {
                                    throw legacyError;
                                }
                            }
                        } else if (input.length > 1 && isCodexAppServerInvalidParamsError(error)) {
                            response = await client.request('turn/start', {
                                ...turnStartParams,
                                input: textOnlyInput,
                            });
                        } else {
                            throw error;
                        }
                    }
                    const startedTurnId = readTurnId(response);
                    if (startedTurnId) {
                        pendingTurn = { ...activeTurn, turnId: startedTurnId };
                        latestPendingTurnId = startedTurnId;
                        recordInProgressBestEffort(startedTurnId);
                        await turnBoundaryTracker.updateActiveTurnId(startedTurnId);
                    }
                    const deferredTerminal = acknowledgePendingTurnStart(activeTurn, startedTurnId);
                    if (deferredTerminal) {
                        await settleTerminalPendingTurn(
                            deferredTerminal.method,
                            deferredTerminal.notificationParams,
                            deferredTerminal.terminalTurnId,
                        );
                    } else {
                        markActiveTurnSteerable();
                    }
                    markPendingProviderPromptAccepted(pendingProviderPrompt, startedTurnId);
                    // A native goal successor is a distinct provider turn, not an extension of
                    // this explicit prompt. The session loop preserves that successor through
                    // hasActiveProviderTurn(), which includes the atomic handoff barrier.
                    await (pendingTurn ?? activeTurn).promise;
                    clearPendingProviderPrompt(pendingProviderPrompt);
                    return;
                } catch (error) {
                    const failure = error instanceof Error ? error : new Error(String(error));
                    const failedTurnHadMeaningfulActivity = activeTurnHasMeaningfulContextWindowRecoveryActivity;
                    const isConnectedServiceAuthTransportInvalidation =
                        isCodexAppServerConnectedServiceAuthTransportInvalidatedTurn(failure);
                    await finishPendingTurn({
                        error: failure,
                        emitUndeliverablePrompt: isConnectedServiceAuthTransportInvalidation ? false : undefined,
                        flushReason: 'abort',
                    });
                    if (isConnectedServiceAuthTransportInvalidation) {
                        await waitForConnectedServiceAuthTransportInvalidationRecovery();
                        if (failedTurnHadMeaningfulActivity) {
                            promptForAttempt = contextWindowRecoveryConfig.continuationPrompt;
                            optionsForAttempt = buildCodexAppServerRetryDeliveryIdentityOptions(pendingProviderPrompt);
                        }
                        continue;
                    }
                    if (isCodexAppServerTemporaryRecoverableTurnFailureError(failure)) {
                        const originalFailure: Error = originalTemporaryRecoverableTurnFailure ?? failure;
                        originalTemporaryRecoverableTurnFailure = originalFailure;
                        const retryDecision = resolveRecoverableTurnFailureRetryDecision({
                            attemptCount: recoveredTemporaryRecoverableTurnFailure ? 1 : 0,
                            maxRetries: 1,
                            providerWillRetry: false,
                            failureRetryAfterMs: null,
                            failedTurnHadMeaningfulActivity,
                            promptMode: contextWindowRecoveryConfig.mode,
                            originalPrompt: prompt,
                            continuationPrompt: contextWindowRecoveryConfig.continuationPrompt,
                        });
                        if (retryDecision.action === 'retry') {
                            recoveredTemporaryRecoverableTurnFailure = true;
                            promptForAttempt = retryDecision.prompt;
                            if (retryDecision.promptKind === 'continuation') {
                                optionsForAttempt = buildCodexAppServerRetryDeliveryIdentityOptions(pendingProviderPrompt);
                            } else {
                                optionsForAttempt = options;
                            }
                            continue;
                        }
                        if (retryDecision.action === 'budget_exhausted') {
                            clearPendingProviderPrompt(pendingProviderPrompt);
                            throw resolveRecoverableTurnFailureSecondFailure({
                                originalFailure,
                                latestFailure: failure,
                            }).failure;
                        }
                        clearPendingProviderPrompt(pendingProviderPrompt);
                        throw originalFailure;
                    }
                    if (isCodexAppServerContextWindowExhaustedError(failure)) {
                        const originalFailure: Error = originalContextWindowExhaustionFailure ?? failure;
                        originalContextWindowExhaustionFailure = originalFailure;
                        const retryDecision = resolveRecoverableTurnFailureRetryDecision({
                            attemptCount: recoveredContextWindowExhaustion ? 1 : 0,
                            maxRetries: 1,
                            providerWillRetry: false,
                            failureRetryAfterMs: null,
                            failedTurnHadMeaningfulActivity,
                            promptMode: contextWindowRecoveryConfig.mode,
                            originalPrompt: prompt,
                            continuationPrompt: contextWindowRecoveryConfig.continuationPrompt,
                        });
                        if (retryDecision.action === 'retry') {
                            recoveredContextWindowExhaustion = true;
                            try {
                                await recoverFromCodexContextWindowExhaustion(activeThreadId, originalFailure);
                            } catch (recoveryError) {
                                await surfaceOriginalContextWindowFailureAfterRecoveryError(originalFailure, recoveryError);
                                throw originalFailure;
                            }
                            promptForAttempt = retryDecision.prompt;
                            if (retryDecision.promptKind === 'continuation') {
                                optionsForAttempt = buildCodexAppServerRetryDeliveryIdentityOptions(pendingProviderPrompt);
                            } else {
                                optionsForAttempt = options;
                            }
                            continue;
                        }
                        if (retryDecision.action === 'disabled') {
                            await surfaceOriginalContextWindowFailure(
                                originalFailure,
                                '[codex-app-server] Codex context-window recovery disabled; surfacing original turn failure',
                                { mode: contextWindowRecoveryConfig.mode },
                            );
                            clearPendingProviderPrompt(pendingProviderPrompt);
                            throw originalFailure;
                        }
                        if (retryDecision.action === 'budget_exhausted') {
                            const secondFailureDecision = resolveRecoverableTurnFailureSecondFailure({
                                originalFailure,
                                latestFailure: failure,
                            });
                            await surfaceOriginalContextWindowFailureAfterRecoveryError(secondFailureDecision.failure, failure);
                            clearPendingProviderPrompt(pendingProviderPrompt);
                            throw secondFailureDecision.failure;
                        }
                        clearPendingProviderPrompt(pendingProviderPrompt);
                        throw originalFailure;
                    }
                    clearPendingProviderPrompt(pendingProviderPrompt);
                    throw failure;
                }
            }
        },
        setOnPromptAcceptedByProvider: (callback) => {
            onPromptAcceptedByProvider = callback;
        },
        setOnUndeliverablePrompts: (callback) => {
            onUndeliverablePrompts = callback;
        },
        flushTurn: async () => {
            await finishPendingTurn({ flushReason: 'turn-end' });
        },
        // K5:fsm_switch app-server runtime applies auth generations through the session-auth FSM;
        // callers only supply the provider-owned direct-live hook surface here.
        applyConnectedServiceAuthGeneration: async (rawRequest) => {
            const currentGroupTruth = SessionConnectedServiceAuthCurrentGroupTruthV1Schema.safeParse(
                rawRequest.authGeneration,
            );
            if (currentGroupTruth.success) {
                const truth = currentGroupTruth.data;
                if (truth.kind === 'current_auth_group_unavailable') {
                    unavailableConnectedServiceAuthGroup = {
                        groupId: truth.groupId,
                        unavailableReason: truth.unavailableReason,
                    };
                } else {
                    unavailableConnectedServiceAuthGroup = null;
                }
                return {
                    ok: true,
                    appliedVia: 'current_truth_fence',
                };
            }
            const request = parseCodexConnectedServiceRuntimeAuthApplyRequest(rawRequest);
            if (!request) {
                return {
                    ok: false,
                    errorCode: 'invalid_request',
                    error: 'invalid_request',
                };
            }
            const buildAppliedRuntimeIdentity = (
                activeAccountId: string,
                accountLabel: string | null,
            ): CodexConnectedServiceRuntimeAppliedIdentity => ({
                serviceId: 'openai-codex',
                activeAccountId,
                accountLabel,
                profileId: request.selection?.kind === 'group'
                    ? request.selection.activeProfileId
                    : request.selection?.kind === 'profile'
                        ? request.selection.profileId
                        : request.expected?.profileId ?? request.candidate.profileId,
                ...(request.selection?.kind === 'group'
                    ? {
                        groupId: request.selection.groupId,
                        generation: request.selection.generation,
                    }
                    : {
                        ...(request.expected?.groupId ? { groupId: request.expected.groupId } : {}),
                        ...(request.expected?.generation === undefined ? {} : { generation: request.expected.generation }),
                    }),
                credentialRevision: request.expected?.credentialRevision ?? null,
                credentialFingerprint: request.candidate.kind === 'oauth'
                    ? computeConnectedServiceAccessTokenFingerprint(request.candidate.oauth.accessToken)
                    : null,
                source: 'applied_credential',
            });
            const buildDirectLiveExactVerification = (
                appliedIdentity: CodexConnectedServiceRuntimeAppliedIdentity,
                accountLabel?: string | null,
            ) => ({
                activeAccountId: appliedIdentity.activeAccountId,
                providerAccountId: appliedIdentity.activeAccountId,
                proofStrength: 'exact' as const,
                source: 'applied_credential',
                reason: 'direct_live_exact_proof_accepted',
                ...(accountLabel ? { accountLabel } : {}),
                ...(appliedIdentity.groupId
                    && typeof appliedIdentity.generation === 'number'
                    && appliedIdentity.credentialRevision
                    && appliedIdentity.credentialFingerprint
                    ? {
                        generationApplication: {
                            serviceId: appliedIdentity.serviceId,
                            groupId: appliedIdentity.groupId,
                            profileId: appliedIdentity.profileId,
                            generation: appliedIdentity.generation,
                            credentialRevision: appliedIdentity.credentialRevision,
                            credentialFingerprint: appliedIdentity.credentialFingerprint,
                        },
                    }
                    : {}),
            });

            const client = await ensureClient();
            const applied = await applyCodexConnectedServiceAuthGeneration({
                client,
                candidate: request.candidate,
                forcedWorkspaceId: request.forcedWorkspaceId ?? null,
                forcedLoginMethod: request.forcedLoginMethod ?? null,
                persistAuthStore: async () => {
                    await writeCodexAuthStoreFile({
                        codexHome: resolveConfiguredCodexHome(runtimeEnv),
                        record: request.candidate,
                    });
                },
                refreshSelection: request.selection ?? undefined,
                updateRefreshSelection: request.selection
                    ? async (selection) => {
                        if (typeof params.onConnectedServiceAuthGenerationApplied !== 'function') {
                            throw new Error('connected_service_refresh_selection_update_unavailable');
                        }
                        return await params.onConnectedServiceAuthGenerationApplied({ selection });
                    }
                    : null,
            });
            if (!applied.applied) {
                if (applied.appliedVia === 'direct_live_hot_auth' && applied.activeAccountId) {
                    latestConnectedServiceRuntimeIdentity = buildAppliedRuntimeIdentity(applied.activeAccountId, null);
                }
                const partialAppliedIdentity = latestConnectedServiceRuntimeIdentity;
                return {
                    ok: false,
                    errorCode: applied.reason,
                    error: applied.reason,
                    ...(applied.appliedVia ? { appliedVia: applied.appliedVia } : {}),
                    ...(applied.activeAccountId ? { activeAccountId: applied.activeAccountId } : {}),
                    ...(applied.appliedVia === 'direct_live_hot_auth' && applied.activeAccountId
                        && partialAppliedIdentity
                        ? {
                            partialState: 'runtime_auth_applied',
                            verification: buildDirectLiveExactVerification(partialAppliedIdentity),
                        }
                        : {}),
                    ...(applied.recovery ? { recovery: applied.recovery } : {}),
                };
            }
            const appliedRuntimeIdentity = buildAppliedRuntimeIdentity(applied.activeAccountId, null);
            latestConnectedServiceRuntimeIdentity = appliedRuntimeIdentity;
            if (applied.durability.persisted === false) {
                const errorCode = applied.durability.errorCode;
                return {
                    ok: false,
                    errorCode,
                    error: errorCode,
                    appliedVia: applied.appliedVia,
                    activeAccountId: applied.activeAccountId,
                    partialState: 'runtime_auth_applied',
                    recovery: 'restart_resume',
                    verification: buildDirectLiveExactVerification(appliedRuntimeIdentity),
                    durability: applied.durability,
                };
            }
            unavailableConnectedServiceAuthGroup = null;

            // Application settlement ends at the exact provider apply + durable auth-store
            // boundary above. Account/quota reads are useful observations, but making the
            // fan-out RPC wait for them turns a slow provider diagnostic into a false hot-
            // apply failure. Keep those observations on the existing provider-owned path
            // and fence their writes against the exact applied identity instead.
            void (async () => {
                let observationIdentity = appliedRuntimeIdentity;
                try {
                    const accountLabel = (await readCodexLiveAccountIdentityFromClient({
                        request: async (_method, params) => await client.request('account/read', params),
                    })).accountLabel;
                    if (latestConnectedServiceRuntimeIdentity !== appliedRuntimeIdentity) return;
                    observationIdentity = {
                        ...appliedRuntimeIdentity,
                        accountLabel,
                    };
                    latestConnectedServiceRuntimeIdentity = observationIdentity;
                } catch (error) {
                    logger.debug('[codex-app-server] Failed to read account diagnostics after connected-service auth apply (non-fatal)', error);
                }

                try {
                    const rawSnapshot = await readCodexRateLimitsSnapshot({
                        request: async (_method, params) => await client.request('account/rateLimits/read', params),
                    });
                    await publishRateLimitSnapshot(rawSnapshot, {
                        operationIdentityAtStart: observationIdentity,
                    });
                } catch (error) {
                    logger.debug('[codex-app-server] Failed to publish quota snapshot after connected-service auth apply (non-fatal)', error);
                }
            })();

            return {
                ok: true,
                appliedVia: applied.appliedVia,
                activeAccountId: applied.activeAccountId,
                verification: {
                    ...buildDirectLiveExactVerification(appliedRuntimeIdentity),
                    durability: applied.durability,
                },
                durability: applied.durability,
            };
        },
        readConnectedServiceRuntimeIdentity: async (request) => {
            if (request.serviceId !== 'openai-codex') {
                return {
                    ok: false,
                    errorCode: 'runtime_identity_probe_account_mismatch',
                    error: 'runtime_identity_probe_account_mismatch',
                };
            }
            const refreshFanoutRuntimeIdentity = async (): Promise<CodexConnectedServiceRuntimeAppliedIdentity | null> => {
                try {
                    return await refreshLiveAccountRuntimeIdentity();
                } catch (error) {
                    logger.debug('[codex-app-server] Failed to read live account identity for connected-service runtime identity probe (non-fatal)', error);
                    return null;
                }
            };
            let identity = latestConnectedServiceRuntimeIdentity;
            const refreshSelection = resolveOpenAiCodexDaemonRefreshSelection(runtimeEnv, params.session);
            const staleCachedIdentity = identity
                ? !runtimeIdentityMatchesRefreshSelection(identity, refreshSelection)
                : false;
            if (staleCachedIdentity) {
                try {
                    identity = await refreshLiveAccountRuntimeIdentity();
                } catch (error) {
                    logger.debug('[codex-app-server] Failed to refresh stale connected-service runtime identity probe from live account (non-fatal)', error);
                    identity = null;
                }
            }
            if (!identity) {
                identity = await refreshFanoutRuntimeIdentity();
                if (!identity) {
                    return {
                        ok: false,
                        errorCode: 'runtime_identity_probe_missing_exact_identity',
                        error: 'runtime_identity_probe_missing_exact_identity',
                    };
                }
            }
            return {
                ok: true,
                serviceId: 'openai-codex',
                identity: {
                    strategy: 'provider_account_id',
                    proofStrength: 'exact',
                    providerAccountId: identity.activeAccountId,
                    ...(identity.accountLabel ? { accountLabel: identity.accountLabel } : {}),
                    source: identity.source,
                },
                runtime: {
                    safeToProbe: true,
                    // Codex account/login/start is the provider-owned direct-live
                    // hot-auth boundary and is supported while a turn is active.
                    // `inProviderTurn` remains informational; it must not make the
                    // generic coordinator defer or restart an otherwise valid apply.
                    safeToApply: true,
                    inProviderTurn: isProviderTurnInFlight(),
                    profileId: identity.profileId,
                    ...(identity.groupId ? { groupId: identity.groupId } : {}),
                    ...(identity.generation === undefined ? {} : { generation: identity.generation }),
                    ...(identity.credentialRevision ? { credentialRevision: identity.credentialRevision } : {}),
                },
            };
        },
        invalidateConnectedServiceAuthTransports: async () => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                // A completed/idle app-server session has no thread-local transports to reset.
                return { ok: true };
            }
            await restartCodexRuntimeForConnectedServiceSwitch(activeThreadId);
            return { ok: true };
        },
        refreshGoal: async () => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('Codex app-server refreshGoal requires an active thread');
            }
            const client = await ensureClient();
            const supported = await refreshGoalForThread(client, activeThreadId);
            if (!supported) {
                return unsupportedSessionRuntimeMethod(SESSION_RPC_METHODS.SESSION_GOAL_GET);
            }
            return undefined;
        },
        enableUsageLimitWaitResume: async (request) => {
            const issue = latestUsageLimitIssue;
            if (!issue?.usageLimit) {
                return {
                    ok: false,
                    errorCode: 'usage_limit_issue_unavailable',
                    error: 'usage_limit_issue_unavailable',
                };
            }
            if (request.rememberPreference === true) {
                await params.rememberUsageLimitRecoveryPreference?.();
            }
            const timing = deriveCodexUsageLimitRecoveryTiming(issue);
            const recoveryCredits = await readRateLimitRecoveryCredits().catch((error) => {
                logger.debug('[codex-app-server] Failed to read usage-limit recovery reset credits while enabling (non-fatal)', error);
                return null;
            });
            try {
                const intent = await usageLimitRecoveryScheduler.enable({
                    sessionId: request.sessionId,
                    issueFingerprint: request.issueFingerprint ?? buildUsageLimitIssueFingerprint(issue),
                    resetAtMs: timing.resetAtMs,
                    nextCheckAtMs: timing.nextCheckAtMs,
                    resumePromptMode: request.resumePromptMode,
                    selectedAuth: resolveUsageLimitRecoveryAuthSelection({
                        runtimeEnv,
                        usageLimit: issue.usageLimit,
                    }),
                    ...(recoveryCredits ? { recoveryCredits } : {}),
                });
                return { ok: true, recovery: intent };
            } catch (error) {
                logger.debug('[codex-app-server] Failed to persist usage-limit recovery enable', error);
                return {
                    ok: false,
                    errorCode: 'usage_limit_recovery_persistence_failed',
                    error: 'usage_limit_recovery_persistence_failed',
                };
            }
        },
        cancelUsageLimitWaitResume: async (request) => {
            let cancellation;
            try {
                cancellation = await usageLimitRecoveryScheduler.cancelExact(request);
            } catch (error) {
                logger.debug('[codex-app-server] Failed to persist usage-limit recovery cancellation', error);
                return {
                    ok: false,
                    errorCode: 'usage_limit_recovery_persistence_failed',
                    error: 'usage_limit_recovery_persistence_failed',
                };
            }
            if (cancellation.status !== 'cancelled') {
                return {
                    ok: false,
                    errorCode: 'usage_limit_recovery_attempt_superseded',
                    error: 'usage_limit_recovery_attempt_superseded',
                };
            }
            return { ok: true, recovery: cancellation.intent };
        },
        checkUsageLimitRecoveryNow: async (request) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                return unsupportedSessionRuntimeMethod(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW);
            }
            if (request.operation === 'consume_reset_credit') {
                return unsupportedSessionRuntimeMethod(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW);
            }
            const currentIntent = usageLimitRecoveryScheduler.read(request.sessionId);
            if (
                currentIntent
                && currentIntent.status !== 'cancelled'
                && request.resumePromptMode
                && currentIntent.resumePromptMode !== request.resumePromptMode
            ) {
                await usageLimitRecoveryScheduler.upsert({
                    sessionId: request.sessionId,
                    intent: {
                        ...currentIntent,
                        resumePromptMode: request.resumePromptMode,
                    },
                });
            }
            if (!currentIntent || currentIntent.status === 'cancelled' || currentIntent.status === 'paused') {
                const issue = latestUsageLimitIssue;
                if (issue?.usageLimit) {
                    const timing = deriveCodexUsageLimitRecoveryTiming(issue);
                    const recoveryCredits = await readRateLimitRecoveryCredits().catch((error) => {
                        logger.debug('[codex-app-server] Failed to read usage-limit recovery reset credits while checking (non-fatal)', error);
                        return null;
                    });
                    await usageLimitRecoveryScheduler.enable({
                        sessionId: request.sessionId,
                        issueFingerprint: buildUsageLimitIssueFingerprint(issue),
                        resetAtMs: timing.resetAtMs,
                        nextCheckAtMs: timing.nextCheckAtMs,
                        resumePromptMode: request.resumePromptMode,
                        selectedAuth: resolveUsageLimitRecoveryAuthSelection({
                            runtimeEnv,
                            usageLimit: issue.usageLimit,
                        }),
                        ...(recoveryCredits ? { recoveryCredits } : {}),
                    });
                }
            }
            const result = await usageLimitRecoveryScheduler.checkNow({ sessionId: request.sessionId });
            return { ok: true, ...result };
        },
        setGoal: async (
            objective: string | undefined,
            options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
        ) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('Codex app-server setGoal requires an active thread');
            }
            const trimmedObjective = trimStringValue(objective);
            const nativeStatus = normalizeNativeGoalSetStatus(options?.status);
            if (nativeStatus === null) return invalidGoalStatus();
            const hasStatus = nativeStatus !== undefined;
            const hasTokenBudget = Boolean(options && Object.prototype.hasOwnProperty.call(options, 'tokenBudget'));
            if (!trimmedObjective && !hasStatus && !hasTokenBudget) {
                throw new Error('Codex app-server setGoal requires a non-empty objective');
            }
            const client = await ensureClient();
            const buildRequest = (fallbackObjective?: string | null): Record<string, unknown> => ({
                threadId: activeThreadId,
                ...(trimmedObjective ? { objective: trimmedObjective } : {}),
                ...(!trimmedObjective && fallbackObjective ? { objective: fallbackObjective } : {}),
                ...(hasStatus ? { status: nativeStatus } : {}),
                ...(hasTokenBudget ? { tokenBudget: options?.tokenBudget ?? null } : {}),
            });
            try {
                const response = await client.request('thread/goal/set', buildRequest());
                await publishGoalWorkState(response);
                return undefined;
            } catch (error) {
                if (!trimmedObjective
                    && (isCodexAppServerInvalidParamsError(error)
                        || isCodexAppServerInvalidRequestForMethodError(error, 'thread/goal/set'))) {
                    const currentGoal = await client.request('thread/goal/get', { threadId: activeThreadId });
                    const fallbackObjective = trimStringValue(readRecord(readGoalFromResponse(currentGoal))?.objective);
                    if (!fallbackObjective) {
                        return { ok: false, errorCode: 'goal_not_found', error: 'goal_not_found' };
                    }
                    const response = await client.request('thread/goal/set', buildRequest(fallbackObjective));
                    await publishGoalWorkState(response);
                    return undefined;
                }
                if (isCodexAppServerGoalMethodUnavailableError(error, 'thread/goal/set')) {
                    logger.debug('[codex-app-server] Native goal set unsupported by app-server', {
                        threadId: activeThreadId,
                        error,
                    });
                    return unsupportedSessionRuntimeMethod(SESSION_RPC_METHODS.SESSION_GOAL_SET);
                }
                throw error;
            }
        },
        clearGoal: async () => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('Codex app-server clearGoal requires an active thread');
            }
            const client = await ensureClient();
            try {
                await client.request('thread/goal/clear', { threadId: activeThreadId });
                await clearGoalWorkState();
                return undefined;
            } catch (error) {
                if (isCodexAppServerGoalMethodUnavailableError(error, 'thread/goal/clear')) {
                    logger.debug('[codex-app-server] Native goal clear unsupported by app-server', {
                        threadId: activeThreadId,
                        error,
                    });
                    return unsupportedSessionRuntimeMethod(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR);
                }
                throw error;
            }
        },
        listVendorPlugins: async (options?: Readonly<{ cwd?: string }>) => {
            const client = await ensureClient();
            return await listCodexVendorPlugins({
                client,
                cwd: trimStringValue(options?.cwd) ?? params.directory,
            });
        },
        listSkills: async (options?: Readonly<{ cwd?: string }>) => {
            const client = await ensureClient();
            return await listCodexAppServerSkills({
                client,
                cwd: trimStringValue(options?.cwd) ?? params.directory,
            });
        },
        rollbackConversation: async (request: SessionRollbackRpcParams) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                return { ok: false, errorCode: 'thread_not_started', errorMessage: 'Codex app-server rollback requires an active thread' };
            }
            if (pendingTurn || nativeTurnHandoffBarrier) {
                return { ok: false, errorCode: 'turn_in_flight', errorMessage: 'Cannot roll back while a turn is still in flight' };
            }

            const target = request.target;
            const rollbackPlan = turnBoundaryTracker.resolveRollbackPlan(target);
            if (!rollbackPlan) {
                return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'Rollback target is not available in the active conversation' };
            }

            const client = await ensureClient();
            try {
                await client.request('thread/rollback', { threadId: activeThreadId, numTurns: rollbackPlan.numTurns });
            } catch (error) {
                const unsupportedMessage = readRollbackUnsupportedErrorMessage(error);
                if (unsupportedMessage) {
                    return { ok: false, errorCode: 'unsupported_action', errorMessage: unsupportedMessage };
                }
                throw error;
            }
            await finishPendingTurn({ flushReason: 'abort' });

            await turnBoundaryTracker.markRolledBack(rollbackPlan);
            const range = captureCompletedTurnSeqRange({
                userMessageSeq: rollbackPlan.targetUserMessageSeq,
                startSeqInclusive: rollbackPlan.range.startSeqInclusive,
                endSeqInclusive: rollbackPlan.range.endSeqInclusive,
            });
            if (range) {
                await (target.type === 'latest_turn'
                    ? publishLatestTurnRollbackRangeMetadata({
                        session: params.session,
                        range,
                    })
                    : publishRollbackRangeMetadata({
                        session: params.session,
                        target,
                        range,
                    })).catch((error) => {
                        logger.debug('[codex-app-server] Failed to publish rollback range metadata (non-fatal)', error);
                    });
            }
            return { ok: true, target: request.target, threadId: activeThreadId };
        },
    };
}
