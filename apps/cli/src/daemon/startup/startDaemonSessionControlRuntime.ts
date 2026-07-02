import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { ApiMachineClient } from '@/api/apiMachine';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { materializeNextPendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { configuration } from '@/configuration';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceIdSchema,
    SESSION_CONTINUATION_RECOVERY_METADATA_KEY,
    isSessionContinuationRecoveryBlockingPendingDrain,
    parseBooleanEnv,
    readConnectedServiceMaterializationIdentityV1FromMetadata,
    writeProviderAccountUsageRecordIdToMetadata,
    writeConnectedServiceMaterializationIdentityV1ToMetadata,
    type AccountSettings,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
    type ConnectedServiceMaterializationIdentityV1,
    type ProviderAccountUsageRecordId,
    type SessionContinuationRecoveryIdentityV1,
    type SessionContinuationResumePromptModeV1,
} from '@happier-dev/protocol';
import {
    inferAgentIdFromSessionMetadata,
    resolveVendorResumeIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    listManagedServerClaimDescriptors,
    resolveCatalogAgentId,
    resolveConnectedServiceCandidatePersistedSessionFile,
    getConnectedServiceRecoveryCapabilities,
    getConnectedServiceRuntimeAuthAdapter,
    resolveConnectedServiceSwitchContinuity,
} from '@/backends/catalog';
import type {
    CatalogAgentId,
    ConnectedServiceSwitchEffectiveBinding,
    ManagedServerClaimDescriptor,
} from '@/backends/types';

import { startDaemonControlServer } from '../controlServer';
import { createLocalServicesDaemonRuntime } from '../local/services/runtime';
import { createOnChildExited } from '../sessions/onChildExited';
import { isSessionRunnerActive as isSessionRunnerActiveInDaemon } from '../sessions/isSessionRunnerActive';
import { createStopSession } from '../sessions/stopSession';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import type { TrackedSession } from '../types';
import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
import { hasCommittedUserMessageAfterMs } from '@/api/session/transcriptQueries';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { refreshAccountSettingsForDaemonRequest } from './accountSettingsFreshness';
import { createSpawnConcurrencyGate } from '../spawn/createSpawnConcurrencyGate';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from '../spawn/spawnRequestCoalescer';
import { resolveExistingSessionSpawnPreGate } from '../spawn/resolveExistingSessionSpawnPreGate';
import { createSessionRunnerRespawnManager } from '../processSupervision/sessionRunnerRespawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
    InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
    type ConnectedServiceAuthGroupGenerationApplyFailure,
    type ConnectedServiceAuthGroupGenerationApplyResult,
} from '../connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { resolvePredictiveSoftSwitchCapability } from '../connectedServices/accountGroups/switching/resolvePredictiveSoftSwitchCapability';
import { createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator } from '../connectedServices/quotas/createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from '../connectedServices/quotas/recordConnectedServiceRuntimeQuotaSnapshotForSession';
import { createProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import {
    recordProviderAccountUsageAdoptionForSession,
    recordProviderAccountUsageSnapshotForSession,
} from '../connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from '../connectedServices/runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from '../connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { commitConnectedServiceAccountSwitchSessionEvent } from '../connectedServices/runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import { commitConnectedServiceRuntimeAuthRecoverySessionEvent } from '../connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import { handleConnectedServiceRuntimeAuthFailureForSession } from '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { createConnectedServiceSessionAuthSwitchCore } from '../connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import {
    RuntimeAuthRecoveryScheduler,
    type RuntimeAuthRecoveryDiagnostic,
} from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '../connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import {
    resolveInactiveTemporaryThrottleResumeSource,
    type TemporaryThrottleResumeSource,
} from '../connectedServices/runtimeAuth/resolveInactiveTemporaryThrottleResumeSource';
import type { ConnectedServiceRuntimeFailureClassification } from '../connectedServices/runtimeAuth/types';
import { createConnectedServiceRecoverySwitchGuard } from '../connectedServices/recovery/connectedServiceRecoverySwitchGuard';
import { createRecoveryIntentFileStore } from '../connectedServices/recoveryScheduler/recoveryIntentFileStore';
import {
    requestConnectedServiceSessionRestartSignal,
    type ConnectedServiceDaemonRestartDiagnosticInput,
    type ConnectedServiceDaemonRestartDiagnosticRecord,
} from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import {
    ConnectedServiceSwitchDeferralConflictError,
    createConnectedServiceSwitchDeferralQueue,
    type ConnectedServiceSwitchTarget,
} from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { logConnectedServiceDaemonRestartDiagnostic } from './logConnectedServiceDaemonRestartDiagnostic';
import { resolveSharedStateRequiredSwitchContinuity } from '../connectedServices/sessionAuthSwitch/sharedStateContinuity';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from '../connectedServices/sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import { createSessionConnectedServiceAuthHotApply } from '../connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import { runSelectionPostSwitchRecovery } from '../connectedServices/sessionAuthSwitch/runSelectionPostSwitchRecovery';
import { createSessionConnectedServiceAccountAdoptionVerifier } from '../connectedServices/sessionAuthSwitch/sessionConnectedServiceAccountAdoptionVerification';
import {
    applyConnectedServiceAuthGenerationToTrackedSession,
    switchSessionConnectedServiceAuth,
    type SessionConnectedServiceAuthSwitchDiagnostics,
    type SessionConnectedServiceAuthSwitchResult,
} from '../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '../connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceAccountSwitchNotification';
import { resolveDaemonCatalogAgentIdFromBackendTarget } from '../backendTargetRouting';
import type { SshTunnelSupervisor } from '../ssh/tunnels';
import type { ConnectedServiceGroupHomeCleanupScheduler } from '../connectedServices/homes/ConnectedServiceGroupHomeCleanupScheduler';
import { resolveSessionRuntimeSnapshot } from '../sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import {
    readConnectedServiceMaterializationIdentityFromEnvironment,
    readConnectedServiceMaterializationIdentityFromMetadata,
    readConnectedServiceMaterializationIdentityFromSpawnOptions,
    generateConnectedServiceMaterializationIdentityV1,
} from '../connectedServices/materialization/identity';
import {
    createSessionContinuationRecoveryController,
    isContinuationRecoveryAwaitingProviderActivityStatus,
} from '../connectedServices/continuation/sessionContinuationRecovery';
import {
    resolveConnectedServiceContinuationReplayPlan as buildConnectedServiceContinuationReplayPlan,
    shouldReleaseConnectedServiceRestartBoundaryForReplayPlan,
    type ConnectedServiceContinuationReplayPlan,
} from '../connectedServices/continuation/resolveConnectedServiceContinuationReplayPlan';
import {
    resolveConnectedServiceContinuationProviderActivityEvidence,
    resolveOriginalUserMessageRetrySafetyFromProviderActivityEvidence,
} from '../connectedServices/continuation/connectedServiceContinuationActivityEvidence';
import { createConnectedServiceContinuationMessageDispatcher } from '../connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import { retryOriginalCommittedUserMessage } from '../connectedServices/continuation/retryOriginalCommittedUserMessage';
import {
    buildContinuationRecoveryIdentityFromBindings,
    listContinuationRecoveryIdentitiesFromBindings,
} from '../connectedServices/continuation/continuationRecoveryIdentity';
import {
    replayPendingConnectedServiceContinuationsForTrackedSessions,
    resolveConnectedServiceContinuationProviderContextAvailability,
} from '../connectedServices/continuation/connectedServiceContinuationProviderContext';
import type { ConnectedServiceSessionAuthSwitchReason } from '../connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { drainRuntimeAuthFailureReportOutboxToDaemon } from '../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxDrain';
import { removeRuntimeAuthFailureReportOutboxItemsForSession } from '../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import { createConnectedServiceRecoverySupersessionCleaner } from '../connectedServices/continuation/continuationRecoverySupersession';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function hasPendingContinuationRecovery(metadata: unknown): boolean {
    return isSessionContinuationRecoveryBlockingPendingDrain(metadata);
}

function resolveTrackedSessionNotificationTitle(tracked: TrackedSession | null | undefined): string | null {
    return getSessionNotificationTitle(() => tracked?.happySessionMetadataFromLocalWebhook ?? null);
}

function normalizeOptionalString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function buildManualSwitchRestartDiagnostic(input: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
}>): ConnectedServiceDaemonRestartDiagnosticInput {
    for (const [serviceId, binding] of Object.entries(input.bindings.bindingsByServiceId)) {
        if (binding.source !== 'connected') continue;
        return {
            trigger: 'manual_switch',
            sessionId: input.sessionId,
            agentId: input.agentId,
            serviceId,
            profileId: binding.profileId ?? null,
            groupId: binding.selection === 'group' ? binding.groupId : null,
            reason: 'manual',
        };
    }
    return {
        trigger: 'manual_switch',
        sessionId: input.sessionId,
        agentId: input.agentId,
        reason: 'manual',
    };
}

function normalizeSwitchTarget(input: Readonly<{
    serviceId?: string | null;
    profileId?: string | null;
    groupId?: string | null;
    generation?: number | null;
}>): ConnectedServiceSwitchTarget {
    return {
        serviceId: typeof input.serviceId === 'string' ? input.serviceId : '',
        profileId: typeof input.profileId === 'string' ? input.profileId : '',
        groupId: typeof input.groupId === 'string' ? input.groupId : '',
        generation: typeof input.generation === 'number' && Number.isFinite(input.generation)
            ? Math.max(0, Math.trunc(input.generation))
            : 0,
    };
}

function findTrackedSessionByHappySessionId(
    trackedSessions: Iterable<TrackedSession>,
    sessionIdRaw: string,
): TrackedSession | null {
    const sessionId = normalizeOptionalString(sessionIdRaw);
    if (!sessionId) return null;
    for (const tracked of trackedSessions) {
        if (normalizeOptionalString(tracked.happySessionId) === sessionId) return tracked;
    }
    return null;
}

function snapshotTrackedSessionForTemporaryThrottleResume(tracked: TrackedSession): TrackedSession {
    const { childProcess: _childProcess, ...snapshot } = tracked;
    return {
        ...snapshot,
        ...(tracked.spawnOptions ? { spawnOptions: { ...tracked.spawnOptions } } : {}),
    };
}

type ManagedServerClaimSnapshot = Readonly<{
    countsByStatePath: ReadonlyMap<string, number>;
    hasUnknownTrackedClaims: boolean;
}>;

function isTrackedManagedServerSession(
    tracked: TrackedSession,
    descriptor: ManagedServerClaimDescriptor,
): boolean {
    const routedAgentId = resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
    if (routedAgentId === descriptor.agentId) return true;
    const processCommand = normalizeOptionalString(tracked.processCommand);
    return processCommand ? descriptor.isExpectedProcessCommand(processCommand) : false;
}

async function summarizeManagedServerClaims(
    trackedSessions: Iterable<TrackedSession>,
): Promise<ManagedServerClaimSnapshot> {
    const descriptors = await listManagedServerClaimDescriptors();
    const countsByStatePath = new Map<string, number>();
    let hasUnknownTrackedClaims = false;
    for (const tracked of trackedSessions) {
        for (const descriptor of descriptors) {
            if (!isTrackedManagedServerSession(tracked, descriptor)) continue;
            const statePath = normalizeOptionalString(
                tracked.spawnOptions?.environmentVariables?.[descriptor.statePathEnvKey],
            );
            if (!statePath) {
                hasUnknownTrackedClaims = true;
                break;
            }
            countsByStatePath.set(statePath, (countsByStatePath.get(statePath) ?? 0) + 1);
            break;
        }
    }
    return { countsByStatePath, hasUnknownTrackedClaims };
}

function resolveConnectedServiceMaterializationIdentityFromTrackedSession(
    tracked: TrackedSession | null | undefined,
): ConnectedServiceMaterializationIdentityV1 | null {
    return readConnectedServiceMaterializationIdentityFromSpawnOptions(tracked?.spawnOptions ?? null)
        ?? readConnectedServiceMaterializationIdentityFromEnvironment(
            tracked?.spawnOptions?.environmentVariables ?? null,
        );
}

function buildTrackedExistingSessionResumeSeed(input: Readonly<{
    tracked: TemporaryThrottleResumeSource;
    sessionId: string;
}>): Readonly<{
    spawnOptions: SpawnSessionOptions;
    vendorResumeId: string;
    defaultOptions: SpawnSessionOptions;
}> | null {
    const spawnOptions = input.tracked.spawnOptions;
    if (!spawnOptions || !normalizeOptionalString(spawnOptions.directory)) return null;

    const resumeFromOptions = normalizeOptionalString(spawnOptions.resume);
    const resumeFromTracked = normalizeOptionalString(input.tracked.vendorResumeId);
    const effectiveResume = resumeFromOptions || resumeFromTracked;
    const {
        initialPrompt: _initialPrompt,
        resume: _resume,
        sessionId: _sessionId,
        ...spawnOptionsWithoutResume
    } = spawnOptions;

    return {
        spawnOptions,
        vendorResumeId: resumeFromTracked,
        defaultOptions: {
            ...spawnOptionsWithoutResume,
            ...(effectiveResume ? { resume: effectiveResume } : {}),
            existingSessionId: input.sessionId,
            sessionId: undefined,
            approvedNewDirectoryCreation: true,
        },
    };
}

function toConnectedServiceAuthSwitchDiagnosticError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    const serialized = serializeAxiosErrorForLog(error);
    if (typeof serialized === 'string') return serialized;
    try {
        return JSON.stringify(serialized);
    } catch {
        return String(error);
    }
}

function attachConnectedServiceAuthSwitchDiagnostics(
    result: SessionConnectedServiceAuthSwitchResult,
    diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined,
): SessionConnectedServiceAuthSwitchResult {
    if (!diagnostics || Object.keys(diagnostics).length === 0) return result;
    return {
        ...result,
        diagnostics: {
            ...(!result.ok ? result.diagnostics : {}),
            ...diagnostics,
        },
    } as SessionConnectedServiceAuthSwitchResult;
}

function logConnectedServiceAuthSwitchResult(input: Readonly<{
    sessionId: string;
    agentId: string;
    serviceIds: readonly string[];
    result: SessionConnectedServiceAuthSwitchResult;
}>): void {
    logger.info('[DAEMON RUN] Connected-service session auth switch result', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        serviceIds: input.serviceIds,
        ok: input.result.ok,
        ...(input.result.ok
            ? {
                action: input.result.action,
                continuityByServiceId: input.result.continuityByServiceId,
                ...(input.result.verificationByServiceId
                    ? { verificationByServiceId: input.result.verificationByServiceId }
                    : {}),
            }
            : {
                errorCode: input.result.errorCode,
                serviceId: input.result.serviceId,
                diagnostics: input.result.diagnostics,
            }),
    });
}

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : { v: 1, bindingsByServiceId: {} };
}

function connectedServiceAuthGroupGenerationApplyFailure(input: Readonly<{
    errorCode: string;
    serviceId: ConnectedServiceId;
    failurePhase: string;
}>): ConnectedServiceAuthGroupGenerationApplyFailure {
    return {
        ok: false,
        errorCode: input.errorCode,
        serviceId: input.serviceId,
        diagnostics: {
            failurePhase: input.failurePhase,
        },
    };
}

async function persistSessionConnectedServiceBindings(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    normalizedBindings: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.token,
        sessionId: input.sessionId,
    });
    if (!rawSession) {
        throw new Error('session_not_found');
    }
    await updateSessionMetadataWithRetry({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        rawSession,
        updater: (metadata) => {
            const existingUpdatedAt = typeof metadata.connectedServicesUpdatedAt === 'number'
                && Number.isFinite(metadata.connectedServicesUpdatedAt)
                ? metadata.connectedServicesUpdatedAt
                : 0;
            const materializationIdentity =
                input.connectedServiceMaterializationIdentityV1
                ?? readConnectedServiceMaterializationIdentityV1FromMetadata(metadata);
            const nextMetadata = {
                ...metadata,
                connectedServices: input.normalizedBindings,
                connectedServicesUpdatedAt: Math.max(Date.now(), existingUpdatedAt + 1),
            };
            return materializationIdentity
                ? writeConnectedServiceMaterializationIdentityV1ToMetadata(
                    nextMetadata,
                    materializationIdentity,
                )
                : nextMetadata;
        },
    });
}

async function publishProviderAccountUsageRecordIdToSessionMetadata(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    recordId: ProviderAccountUsageRecordId | string;
}>): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.token,
        sessionId: input.sessionId,
    });
    if (!rawSession) {
        throw new Error('session_not_found');
    }
    await updateSessionMetadataWithRetry({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        rawSession,
        updater: (metadata) => writeProviderAccountUsageRecordIdToMetadata(metadata, {
            recordId: input.recordId,
            updatedAtMs: Date.now(),
        }),
    });
}

function connectedServiceBindingToEffectiveBinding(
    serviceId: ConnectedServiceId,
    binding: ConnectedServiceBindingsV1['bindingsByServiceId'][string],
): ConnectedServiceSwitchEffectiveBinding | null {
    if (binding.source !== 'connected') return null;
    if (binding.selection === 'group') {
        return {
            source: 'connected',
            selection: 'group',
            serviceId,
            profileId: normalizeOptionalString(binding.profileId) || null,
            groupId: binding.groupId,
        };
    }
    return {
        source: 'connected',
        selection: 'profile',
        serviceId,
        profileId: binding.profileId,
        groupId: null,
    };
}

async function repairMissingConnectedServiceMaterializationIdentityForSpawn(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    vendorResumeId: string | null;
}>): Promise<ConnectedServiceMaterializationIdentityV1 | null> {
    const vendorResumeId = normalizeOptionalString(input.vendorResumeId);
    if (!vendorResumeId) return null;

    const connectedBindings: ConnectedServiceSwitchEffectiveBinding[] = [];
    for (const [serviceIdRaw, binding] of Object.entries(input.connectedServices.bindingsByServiceId)) {
        const serviceId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
        if (!serviceId.success) continue;
        const effective = connectedServiceBindingToEffectiveBinding(serviceId.data, binding);
        if (effective) connectedBindings.push(effective);
    }
    if (connectedBindings.length === 0) return null;

    for (const binding of connectedBindings) {
        const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
            sessionId: input.sessionId,
            agentId: input.agentId,
            serviceId: binding.serviceId,
            previousBinding: binding,
            nextBinding: binding,
            fromBindings: input.connectedServices,
            toBindings: input.connectedServices,
            vendorResumeId,
        });
        if (continuity.mode !== 'restart_same_home') return null;
    }

    const connectedServiceMaterializationIdentityV1 = generateConnectedServiceMaterializationIdentityV1();
    await persistSessionConnectedServiceBindings({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        normalizedBindings: input.connectedServices,
        connectedServiceMaterializationIdentityV1,
    });
    return connectedServiceMaterializationIdentityV1;
}

function resolveContinuationResumePromptMode(
    settings: AccountSettings | null | undefined,
    explicit?: SessionContinuationResumePromptModeV1,
): SessionContinuationResumePromptModeV1 {
    if (explicit === 'standard' || explicit === 'off' || explicit === 'custom') {
        return explicit;
    }
    const settingsMode = settings?.usageLimitRecoverySettingsV1?.resumePromptMode;
    return settingsMode === 'off' || settingsMode === 'custom' ? settingsMode : 'standard';
}

function readContinuationCustomResumePrompt(
    settings: AccountSettings | null | undefined,
): string | null {
    return settings?.usageLimitRecoverySettingsV1?.customResumePrompt ?? null;
}

function createSessionContinuationRecoveryMetadataStore(params: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
}>) {
    return {
        read: async (sessionId: string) => {
            const rawSession = await fetchSessionByIdCompat({
                token: params.credentials.token,
                sessionId,
            }).catch(() => null);
            if (!rawSession) return null;
            return tryDecryptSessionMetadata({
                credentials: params.credentials,
                rawSession,
            });
        },
        write: async (sessionId: string, state: unknown) => {
            const rawSession = await fetchSessionByIdCompat({
                token: params.credentials.token,
                sessionId,
            });
            if (!rawSession) {
                throw new Error('Session not found while persisting continuation recovery state');
            }
            await updateSessionMetadataWithRetry({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId,
                rawSession,
                updater: (metadata) => ({
                    ...metadata,
                    [SESSION_CONTINUATION_RECOVERY_METADATA_KEY]: state,
                }),
                maxAttempts: 6,
            });
        },
    };
}

function createConnectedServiceContinuationHandler(params: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    failureAtMs: number;
    resumePromptMode: SessionContinuationResumePromptModeV1;
    resolveReplayPlan: (input: Readonly<{
        sessionId: string;
        switchReason?: ConnectedServiceSessionAuthSwitchReason;
    }>) => Promise<ConnectedServiceContinuationReplayPlan> | ConnectedServiceContinuationReplayPlan;
    providerActivityTimeoutMs: number;
    logDebug: (message: string, error: unknown) => void;
}>) {
    const controller = createSessionContinuationRecoveryController({
        nowMs: () => Date.now(),
        providerActivityTimeoutMs: params.providerActivityTimeoutMs,
        store: createSessionContinuationRecoveryMetadataStore({ credentials: params.credentials }),
        readCustomResumePrompt: () =>
            readContinuationCustomResumePrompt(getActiveAccountSettingsSnapshot()?.settings ?? null),
    });
    function scheduleProviderActivityTimeout(input: Readonly<{ sessionId: string }>): void {
        const timeout = setTimeout(() => {
            void controller.expireProviderActivityWaits({ sessionId: input.sessionId }).catch((error) => {
                params.logDebug('[DAEMON RUN] Failed to expire connected-service continuation provider-activity wait (non-fatal)', error);
            });
        }, params.providerActivityTimeoutMs);
        timeout.unref?.();
    }
    const continuationMessageDispatcher = createConnectedServiceContinuationMessageDispatcher({
        credentials: params.credentials,
        nudgePendingQueue: ({ sessionId }) => {
            startPendingQueueBackgroundNudgeLoop({
                sessionId,
                daemonToken: params.credentials.token,
                logLabel: 'connected-service continuation',
            });
        },
        sendMessage: sendSessionMessage,
        retryOriginalUserMessage: retryOriginalCommittedUserMessage,
    });
    return async (input: Readonly<{
        sessionId: string;
        attemptId: string;
        normalizedBindings: ConnectedServiceBindingsV1;
        serviceIds: ReadonlySet<ConnectedServiceId>;
        action: 'hot_applied' | 'restart_requested';
        switchReason?: ConnectedServiceSessionAuthSwitchReason;
    }>) => {
        const replayPlan = await params.resolveReplayPlan({
            sessionId: input.sessionId,
            switchReason: input.switchReason,
        });
        if (replayPlan.continuationRequired === false || replayPlan.replayMode === 'suppress') {
            return;
        }
        const recoveryIdentity = buildContinuationRecoveryIdentityFromBindings({
            serviceIds: input.serviceIds,
            bindings: input.normalizedBindings,
        }) ?? undefined;
        await controller.beginAttempt({
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            failureAtMs: params.failureAtMs,
            resumePromptMode: params.resumePromptMode,
            replayMode: replayPlan.replayMode,
            recoveryIdentity,
            continuationRequired: replayPlan.continuationRequired,
        });
        if (input.action === 'restart_requested') return;
        const result = await controller.resolveAttempt({
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            failureAtMs: params.failureAtMs,
            resumePromptMode: params.resumePromptMode,
            replayMode: replayPlan.replayMode,
            recoveryIdentity,
            continuationRequired: replayPlan.continuationRequired,
            exactProviderContextAvailable: true,
            hasUserMessageAfterFailure: async () =>
                await hasCommittedUserMessageAfterMs({
                    token: params.credentials.token,
                    sessionId: input.sessionId,
                    failureAtMs: params.failureAtMs,
                }),
            canRetryOriginalUserMessage: async () =>
                resolveOriginalUserMessageRetrySafetyFromProviderActivityEvidence(
                    await resolveConnectedServiceContinuationProviderActivityEvidence({
                        credentials: params.credentials,
                        sessionId: input.sessionId,
                        failureAtMs: params.failureAtMs,
                    }),
                ),
            sendContinuationPrompt: ({ prompt, localId }) =>
                continuationMessageDispatcher.sendContinuationPrompt({
                    sessionId: input.sessionId,
                    prompt,
                    localId,
                }),
            retryOriginalUserMessage: ({ localId }) =>
                continuationMessageDispatcher.retryOriginalUserMessage({
                    sessionId: input.sessionId,
                    failureAtMs: params.failureAtMs,
                    localId,
                }),
        });
        if (isContinuationRecoveryAwaitingProviderActivityStatus(result.status)) {
            scheduleProviderActivityTimeout({ sessionId: input.sessionId });
        }
    };
}

function createSelectionPostSwitchRecoveryHandler(params: Readonly<{
    getTrackedSessions: () => ReadonlyArray<TrackedSession>;
}>) {
    return async (input: Readonly<{
        tracked: TrackedSession;
        sessionId: string;
        normalizedBindings: ConnectedServiceBindingsV1;
        serviceIds: ReadonlySet<ConnectedServiceId>;
        action: 'hot_applied' | 'restart_requested';
        runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedServiceId, unknown>;
    }>) => {
        const claimSnapshot = await summarizeManagedServerClaims(params.getTrackedSessions());
        return await runSelectionPostSwitchRecovery({
            ...input,
            runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId,
            countTrackedClaimsForStatePath: (statePath) => {
                const normalized = normalizeOptionalString(statePath);
                return normalized ? (claimSnapshot.countsByStatePath.get(normalized) ?? 0) : 0;
            },
            hasUnknownTrackedClaims: claimSnapshot.hasUnknownTrackedClaims,
        });
    };
}

function createConnectedServicePendingContinuationResolver(params: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    providerActivityTimeoutMs: number;
    logDebug: (message: string, error: unknown) => void;
}>) {
    const controller = createSessionContinuationRecoveryController({
        nowMs: () => Date.now(),
        providerActivityTimeoutMs: params.providerActivityTimeoutMs,
        store: createSessionContinuationRecoveryMetadataStore({ credentials: params.credentials }),
        readCustomResumePrompt: () =>
            readContinuationCustomResumePrompt(getActiveAccountSettingsSnapshot()?.settings ?? null),
    });
    function scheduleProviderActivityTimeout(input: Readonly<{ sessionId: string }>): void {
        const timeout = setTimeout(() => {
            void controller.expireProviderActivityWaits({ sessionId: input.sessionId }).catch((error) => {
                params.logDebug('[DAEMON RUN] Failed to expire replayed connected-service continuation provider-activity wait (non-fatal)', error);
            });
        }, params.providerActivityTimeoutMs);
        timeout.unref?.();
    }
    const continuationMessageDispatcher = createConnectedServiceContinuationMessageDispatcher({
        credentials: params.credentials,
        nudgePendingQueue: ({ sessionId }) => {
            startPendingQueueBackgroundNudgeLoop({
                sessionId,
                daemonToken: params.credentials.token,
                logLabel: 'connected-service pending continuation',
            });
        },
        sendMessage: sendSessionMessage,
        retryOriginalUserMessage: retryOriginalCommittedUserMessage,
    });
    return async (input: Readonly<{
        sessionId: string;
        exactProviderContextAvailable: boolean;
    }>) => {
        const result = await controller.resolvePendingAttempts({
            sessionId: input.sessionId,
            exactProviderContextAvailable: input.exactProviderContextAvailable,
            hasUserMessageAfterFailure: async ({ failureAtMs }) =>
                await hasCommittedUserMessageAfterMs({
                    token: params.credentials.token,
                    sessionId: input.sessionId,
                    failureAtMs,
                }),
            canRetryOriginalUserMessage: async ({ failureAtMs }) =>
                resolveOriginalUserMessageRetrySafetyFromProviderActivityEvidence(
                    await resolveConnectedServiceContinuationProviderActivityEvidence({
                        credentials: params.credentials,
                        sessionId: input.sessionId,
                        failureAtMs,
                    }),
                ),
            sendContinuationPrompt: ({ prompt, localId }) =>
                continuationMessageDispatcher.sendContinuationPrompt({
                    sessionId: input.sessionId,
                    prompt,
                    localId,
                }),
            retryOriginalUserMessage: ({ localId, failureAtMs }) =>
                continuationMessageDispatcher.retryOriginalUserMessage({
                    sessionId: input.sessionId,
                    failureAtMs,
                    localId,
                }),
        });
        if (result.resolved.some((resolved) => isContinuationRecoveryAwaitingProviderActivityStatus(resolved.status))) {
            scheduleProviderActivityTimeout({ sessionId: input.sessionId });
        }
    };
}

function createConnectedServiceProviderActivityRecorder(params: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    providerActivityTimeoutMs: number;
    markRuntimeAuthRecoverySucceededByIdentity?: (input: Readonly<{
        sessionId: string;
        recoveryIdentity: SessionContinuationRecoveryIdentityV1;
    }>) => Promise<void>;
    logDebug?: (message: string, error: unknown) => void;
}>) {
    const controller = createSessionContinuationRecoveryController({
        nowMs: () => Date.now(),
        providerActivityTimeoutMs: params.providerActivityTimeoutMs,
        store: createSessionContinuationRecoveryMetadataStore({ credentials: params.credentials }),
    });
    return async (input: Readonly<{
        sessionId: string;
        recoveryIdentities?: readonly SessionContinuationRecoveryIdentityV1[];
    }>) => {
        const identities = input.recoveryIdentities ?? [];
        if (identities.length === 0) {
            await controller.recordProviderActivity({ sessionId: input.sessionId });
            return;
        }
        for (const recoveryIdentity of identities) {
            const result = await controller.recordProviderActivity({ sessionId: input.sessionId, recoveryIdentity }).catch((error) => {
                params.logDebug?.('[DAEMON RUN] Failed to record connected-service provider activity (non-fatal)', error);
                return null;
            });
            // Identity-matched provider activity observed AFTER the recovery boundary is
            // recovered provider-outcome proof: clear the matching runtime-auth intent(s).
            if (!result || result.observed <= 0) continue;
            await params.markRuntimeAuthRecoverySucceededByIdentity?.({
                sessionId: input.sessionId,
                recoveryIdentity,
            }).catch((error) => {
                params.logDebug?.('[DAEMON RUN] Failed to clear runtime-auth recovery after connected-service provider activity (non-fatal)', error);
            });
        }
    };
}

async function resolveConnectedServiceContinuationReplayPlan(input: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    failureAtMs: number;
    turnDeferralQueue: ReturnType<typeof createConnectedServiceSwitchDeferralQueue>;
    switchReason?: ConnectedServiceSessionAuthSwitchReason;
}>): Promise<ConnectedServiceContinuationReplayPlan> {
    const state = input.turnDeferralQueue.getTurnLifecycleState(input.sessionId);
    const providerActivityEvidence = !state.inFlight && !state.hasProviderActivityThisTurn
        ? undefined
        : state.hasProviderActivityThisTurn
        ? 'activity_found'
        : await resolveConnectedServiceContinuationProviderActivityEvidence({
            credentials: input.credentials,
            sessionId: input.sessionId,
            failureAtMs: input.failureAtMs,
        });
    return buildConnectedServiceContinuationReplayPlan({
        switchReason: input.switchReason,
        turnInFlight: state.inFlight,
        hasProviderActivityThisTurn: state.hasProviderActivityThisTurn,
        providerActivityEvidence,
    });
}

function resolveTrackedContinuationRecoveryIdentities(input: Readonly<{
    sessionId: string;
    getChildren: () => readonly TrackedSession[];
}>): readonly SessionContinuationRecoveryIdentityV1[] {
    const tracked = input.getChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
    if (!tracked) return [];
    return listContinuationRecoveryIdentitiesFromBindings(
        readConnectedServiceBindingsOrEmpty(tracked.spawnOptions?.connectedServices),
    );
}

export async function resolveSessionConnectedServiceSwitchContinuity(input: Readonly<{
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    previousBinding: ConnectedServiceSwitchEffectiveBinding | null;
    nextBinding: ConnectedServiceSwitchEffectiveBinding;
    tracked?: TrackedSession | null;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    fromBindingsRaw: unknown;
    toBindings: ConnectedServiceBindingsV1;
    accountSettings: AccountSettings | null;
    runtimeAuthSelection?: unknown;
    targetMaterializedRoot?: string | null;
    targetMaterializedEnv?: Readonly<Record<string, string>> | null;
    cwd?: string | null;
    candidatePersistedSessionFile?: string | null;
}>) {
    const connectedServiceMaterializationIdentityV1 = input.connectedServiceMaterializationIdentityV1
        ?? resolveConnectedServiceMaterializationIdentityFromTrackedSession(input.tracked ?? null);
    const vendorResumeId = normalizeOptionalString(input.vendorResumeId ?? input.tracked?.vendorResumeId);
    const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
        sessionId: input.sessionId,
        agentId: input.agentId,
        serviceId: input.serviceId,
        previousBinding: input.previousBinding,
        nextBinding: input.nextBinding,
        fromBindings: readConnectedServiceBindingsOrEmpty(input.fromBindingsRaw),
        toBindings: input.toBindings,
        connectedServiceMaterializationIdentityV1,
        ...(vendorResumeId ? { vendorResumeId } : {}),
        ...(input.targetMaterializedRoot ? { targetMaterializedRoot: input.targetMaterializedRoot } : {}),
        ...(input.targetMaterializedEnv ? { targetMaterializedEnv: input.targetMaterializedEnv } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.candidatePersistedSessionFile
            ? { candidatePersistedSessionFile: input.candidatePersistedSessionFile }
            : {}),
        ...(input.runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection: input.runtimeAuthSelection }),
    });
    if (continuity.mode === 'hot_apply') {
        return { mode: 'hot_apply' as const };
    }
    if (continuity.mode === 'restart_same_home') {
        return { mode: 'restart_rematerialize' as const };
    }
    if (continuity.mode === 'restart_shared_state_required') {
        return await resolveSharedStateRequiredSwitchContinuity({
            agentId: input.agentId,
            accountSettings: input.accountSettings,
            warnings: continuity.reason ? [continuity.reason] : [],
            serviceId: input.serviceId,
            targetMaterializedRoot: input.targetMaterializedRoot ?? null,
            targetMaterializedEnv: input.targetMaterializedEnv ?? null,
            materializationIdentity: connectedServiceMaterializationIdentityV1 ?? null,
            vendorResumeId: vendorResumeId || null,
            cwd: input.cwd ?? null,
            candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
        });
    }
    return {
        mode: 'unsupported' as const,
        errorCode: continuity.reason === 'provider_session_state_unavailable_for_resume'
            ? 'provider_session_state_unavailable_for_resume' as const
            : 'unsupported_service' as const,
        warnings: continuity.reason ? [continuity.reason] : [],
        ...(continuity.diagnostics ? { diagnostics: continuity.diagnostics } : {}),
    };
}

async function nudgeAlreadyRunningExistingSessionPendingQueue(params: Readonly<{
    sessionId: string;
    daemonToken: string;
}>): Promise<boolean> {
    const token = params.daemonToken.trim();
    if (!token) return false;

    try {
        const materialized = await materializeNextPendingQueueV2MessageViaHttp({
            token,
            sessionId: params.sessionId,
        });
        return materialized.didMaterialize === true;
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to nudge pending queue for already-running session resume', {
            sessionId: params.sessionId,
            error: serializeAxiosErrorForLog(error),
        });
        return false;
    }
}

function startPendingQueueBackgroundNudgeLoop(params: Readonly<{
    sessionId: string;
    daemonToken: string;
    logLabel: string;
}>): void {
    const maxAttempts = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_ATTEMPTS,
        8,
        { min: 1, max: 120 },
    );
    const retryDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_ATTACH_PENDING_QUEUE_NUDGE_RETRY_DELAY_MS,
        500,
        { min: 0, max: 60_000 },
    );
    void (async () => {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const didMaterialize = await nudgeAlreadyRunningExistingSessionPendingQueue({
                sessionId: params.sessionId,
                daemonToken: params.daemonToken,
            });
            if (didMaterialize) return;
            if (attempt >= maxAttempts) return;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
    })().catch((error) => {
        logger.debug(`[DAEMON RUN] ${params.logLabel} pending queue background nudge loop failed`, {
            sessionId: params.sessionId,
            error: serializeAxiosErrorForLog(error),
        });
    });
}

function tryReadSessionMetadataRecord(input: Readonly<{
    rawSession: Readonly<{ metadata?: unknown; encryptionMode?: unknown; dataEncryptionKey?: unknown }>;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
}>): Record<string, unknown> | null {
    const rawMetadata = typeof input.rawSession.metadata === 'string' ? input.rawSession.metadata.trim() : '';
    if (!rawMetadata) return null;
    if (input.rawSession.encryptionMode === 'plain') {
        return tryParseJsonRecord(rawMetadata);
    }
    return tryDecryptSessionMetadata({
        credentials: input.credentials,
        rawSession: input.rawSession,
    });
}

async function resolvePersistedConnectedServiceSwitchSessionMetadata(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
}>): Promise<Record<string, unknown> | null> {
    const token = input.token.trim();
    if (!token) return null;
    const rawSession = await fetchSessionByIdCompat({
        token,
        sessionId: input.sessionId,
    }).catch(() => null);
    if (!rawSession) return null;
    return tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
    });
}

async function resolveInactiveConnectedServiceSessionContext(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
}>): Promise<Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
    vendorResumeId?: string;
    /**
     * Session working directory (from the decrypted session metadata `path`). The inactive-switch
     * shared-state continuity check needs it to drive the source-aware resume-reachability probe and
     * to reconstruct the deterministic target materialized root; without it the switch fail-closes a
     * genuinely-resumable inactive session.
     */
    cwd?: string;
    /**
     * Provider-owned persisted vendor session-file hint derived from inactive session metadata.
     * Shared daemon continuity code must obtain this through the backend catalog, not by reading
     * provider-specific metadata fields directly.
     */
    candidatePersistedSessionFile?: string;
}> | null> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.token,
        sessionId: input.sessionId,
    });
    const metadata = rawSession
        ? tryReadSessionMetadataRecord({
            rawSession,
            credentials: input.credentials,
        })
        : null;
    if (!metadata) return null;
    const inferredAgentId = inferAgentIdFromSessionMetadata(metadata);
    const agentId = resolveCatalogAgentId(inferredAgentId);
    const materializationIdentity = readConnectedServiceMaterializationIdentityFromMetadata(metadata);
    const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
    const cwd = normalizeOptionalString(metadata.path);
    const candidatePersistedSessionFile =
        resolveConnectedServiceCandidatePersistedSessionFile(agentId, metadata) ?? '';
    return {
        agentId,
        connectedServices: readConnectedServiceBindingsOrEmpty(metadata.connectedServices),
        ...(materializationIdentity
            ? { connectedServiceMaterializationIdentityV1: materializationIdentity }
            : {}),
        ...(vendorResumeId ? { vendorResumeId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(candidatePersistedSessionFile ? { candidatePersistedSessionFile } : {}),
    };
}

async function applyAlreadyRunningExistingSessionRuntimeSnapshot(input: Readonly<{
    sessionId: string;
    incomingOptions: SpawnSessionOptions;
    pidToTrackedSession: Map<number, TrackedSession>;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
}>): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.credentials.token,
        sessionId: input.sessionId,
    }).catch(() => null);
    if (!rawSession) return;

    const metadata = tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
    });
    if (!metadata) return;

    const agentId = inferAgentIdFromSessionMetadata(metadata);
    const persistedVendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
        : null;

    for (const tracked of input.pidToTrackedSession.values()) {
        if (tracked.happySessionId !== input.sessionId) continue;
        const incomingOptions: SpawnSessionOptions = {
            ...tracked.spawnOptions,
            ...input.incomingOptions,
            existingSessionId: input.sessionId,
        };
        const runtimeSnapshot = resolveSessionRuntimeSnapshot({
            incomingOptions: persistedVendorResumeId
                ? { ...incomingOptions, resume: persistedVendorResumeId }
                : incomingOptions,
            persistedMetadata: metadata,
            persistedVendorResumeId,
            trackedSpawnOptions: tracked.spawnOptions ?? null,
            trackedVendorResumeId: tracked.vendorResumeId ?? null,
        });
        tracked.spawnOptions = runtimeSnapshot.spawnOptions;
        const vendorResumeId = runtimeSnapshot.snapshot.vendorResumeId?.value;
        if (vendorResumeId) {
            tracked.vendorResumeId = vendorResumeId;
        }
    }
}

async function resolveRespawnSessionOptionsWithRuntimeSnapshot(input: Readonly<{
    sessionId: string;
    spawnOptions: SpawnSessionOptions;
    vendorResumeId: string;
    defaultOptions: SpawnSessionOptions;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
}>): Promise<SpawnSessionOptions> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.credentials.token,
        sessionId: input.sessionId,
    }).catch(() => null);
    if (!rawSession) return input.defaultOptions;

    const metadata = tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
    });
    if (!metadata) return input.defaultOptions;

    const agentId = inferAgentIdFromSessionMetadata(metadata);
    const persistedVendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
        : null;

    const incomingOptions = persistedVendorResumeId
        ? { ...input.defaultOptions, resume: persistedVendorResumeId }
        : input.defaultOptions;

    return resolveSessionRuntimeSnapshot({
        incomingOptions,
        persistedMetadata: metadata,
        persistedVendorResumeId,
        trackedSpawnOptions: input.spawnOptions,
        trackedVendorResumeId: input.vendorResumeId,
    }).spawnOptions;
}

export async function startDaemonSessionControlRuntime(
    params: Readonly<{
        machineId: string;
        credentials: NonNullable<Parameters<typeof executeSpawnSessionRequest>[0]['credentials']>;
        api: Parameters<typeof executeSpawnSessionRequest>[0]['api'];
        loadLocalHandoffMetadataByVendorResumeId: Parameters<typeof executeSpawnSessionRequest>[0]['loadLocalHandoffMetadataByVendorResumeId'];
        connectedServicesMaterializationBaseDir: string;
        getConnectedServiceRefreshCoordinator: () => ConnectedServiceRefreshCoordinator | null;
        getConnectedServiceQuotasCoordinator: () => ConnectedServiceQuotasCoordinator | null;
        pidToTrackedSession: Map<number, TrackedSession>;
        pidToAwaiter: Map<number, (session: TrackedSession) => void>;
        pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
        pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
        getApiMachineForSessions: () => ApiMachineClient | null;
        spawnResourceCleanupByPid: Map<number, () => void>;
        sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
        connectedServicesRestartRequestedPids: Set<number>;
        connectedServiceGroupHomeCleanupScheduler?: Pick<ConnectedServiceGroupHomeCleanupScheduler, 'cleanupPendingDeletedGroupHomes'>;
        connectedServiceMaterializedHomeCleanupScheduler?: Readonly<{
            cleanupPendingMaterializedHomes: () => Promise<unknown>;
        }>;
        beforeShutdown: Parameters<typeof startDaemonControlServer>[0]['beforeShutdown'];
        onHappySessionWebhook: Parameters<typeof startDaemonControlServer>[0]['onHappySessionWebhook'];
        sshTunnelSupervisor?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
        requestShutdown: (source: ShutdownSource, errorMessage?: string) => void;
        // True once daemon shutdown has begun. Threaded into the control server + recovery schedulers
        // so recovery handlers/timers do not run switch/restart work into a tearing-down daemon.
        isShuttingDown?: () => boolean;
        processEnv: NodeJS.ProcessEnv;
    }>,
): Promise<Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<boolean>;
    isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void;
    controlPort: number;
    controlToken: string;
    stopControlServer: () => Promise<void>;
    connectedServiceAuthGroupPreTurnSwitchCoordinator: Readonly<{
        switchBeforeTurn: (input: Readonly<{
            sessionId?: string;
            serviceId: string;
            groupId: string;
            reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
        }>) => Promise<unknown>;
    }>;
    connectedServiceRecoverySwitchGuard: ReturnType<typeof createConnectedServiceRecoverySwitchGuard>;
    requestConnectedServiceRefreshRestartSignal: (signalParams: Readonly<{
        pid: number;
        delayMs: number;
        preferProcessGroup?: boolean;
        shouldSignal?: () => boolean;
        onSignalFailure: (error: unknown) => void;
        restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
        recordRestartDiagnostic?: (record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
        nowMs?: () => number;
    }>) => Promise<Readonly<{ signaled: boolean }>>;
    retryTemporaryThrottleNow: (input: Readonly<{ sessionId: string }>) => Promise<unknown>;
    connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
}>> {
    const spawnConcurrencyGate = createSpawnConcurrencyGate(
        resolvePositiveIntEnv(params.processEnv.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 0, { min: 0, max: 64 }),
    );
    const spawnRequestCoalescer = createSpawnRequestCoalescer({
        recentSuccessTtlMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS,
            2_000,
            { min: 0, max: 60_000 },
        ),
    });
    const isSessionRunnerActive = async (sessionIdRaw: string): Promise<boolean> =>
        await isSessionRunnerActiveInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: params.pidToTrackedSession.values(),
        });
    const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const providerAccountUsageStore = createProviderAccountUsageStore();
    const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
        api: params.api,
        credentials: params.credentials,
        randomBytes,
        serverScope: configuration.activeServerDir,
        accountScope: 'active-account',
        now: () => Date.now(),
    });
    const connectedServiceAuthGroupSwitchLeases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry();
    const connectedServiceRuntimeAuthSwitchAttempts = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
        nowMs: () => Date.now(),
        windowMs: 60_000,
    });
    let connectedServiceRecoverySwitchGuard: ReturnType<typeof createConnectedServiceRecoverySwitchGuard> | null = null;
    const connectedServiceSessionAuthSwitchCore = createConnectedServiceSessionAuthSwitchCore();
    const recordConnectedServiceRestartDiagnostic = (record: ConnectedServiceDaemonRestartDiagnosticRecord) => {
        logConnectedServiceDaemonRestartDiagnostic(logger, record);
    };
    const preTurnConnectedServiceAuthGroupSwitchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
        api: params.api,
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        leases: connectedServiceAuthGroupSwitchLeases,
        quotaFreshnessMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
            5 * 60_000,
            { min: 1_000, max: 60 * 60_000 },
        ),
        nowMs: () => Date.now(),
        restartSession: async () => ({ ok: true }),
        probeQuotaSnapshotsForGroup: async (input) => {
            await params.getConnectedServiceQuotasCoordinator()?.probeGroupQuotaSnapshots(input);
        },
    });
    const resolveCanonicalTrackedSessionId = (pid: number): string => {
        const session = params.pidToTrackedSession.get(pid);
        const sessionId = typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '';
        if (!sessionId || /^PID-\d+$/.test(sessionId)) {
            return '';
        }
        return sessionId;
    };

    let onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void = () => {};

    const runSpawnSession = async (
        options: SpawnSessionOptions,
        behavior: Readonly<{ nudgeAlreadyRunningPendingQueue: boolean }>,
    ): Promise<SpawnSessionResult> => {
        try {
            const key = computeDaemonSpawnRequestKey(options);
            return await spawnRequestCoalescer.run(key, async () => {
                const existingSessionPreGate = await resolveExistingSessionSpawnPreGate({
                    existingSessionId: options.existingSessionId,
                    pidToTrackedSession: params.pidToTrackedSession,
                    isSessionRunnerActive,
                    waitForExitTimeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                    waitForExitPollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                    logDebug: (message, payload) => logger.debug(message, payload),
                    onAlreadyRunning: async (sessionId) => {
                        await applyAlreadyRunningExistingSessionRuntimeSnapshot({
                            sessionId,
                            incomingOptions: options,
                            pidToTrackedSession: params.pidToTrackedSession,
                            credentials: params.credentials,
                        });
                        if (behavior.nudgeAlreadyRunningPendingQueue) {
                            await nudgeAlreadyRunningExistingSessionPendingQueue({
                                sessionId,
                                daemonToken: params.credentials.token,
                            });
                        }
                    },
                });
                if (existingSessionPreGate.shortCircuitResult) {
                    return existingSessionPreGate.shortCircuitResult;
                }

                return await spawnConcurrencyGate.run(async () =>
                    await executeSpawnSessionRequest({
                        options,
                        credentials: params.credentials,
                        api: params.api,
                        loadLocalHandoffMetadataByVendorResumeId: params.loadLocalHandoffMetadataByVendorResumeId,
                        connectedServicesMaterializationBaseDir: params.connectedServicesMaterializationBaseDir,
                        connectedServiceRefreshCoordinator: params.getConnectedServiceRefreshCoordinator(),
                        connectedServiceQuotasCoordinator: params.getConnectedServiceQuotasCoordinator(),
                        authGroupSwitchCoordinator: preTurnConnectedServiceAuthGroupSwitchCoordinator,
                        softSwitchRecoveryGuard: connectedServiceRecoverySwitchGuard ?? undefined,
                        connectedServiceRuntimeQuotaSnapshots,
                        repairMissingConnectedServiceMaterializationIdentityForSpawn: async (input) =>
                            await repairMissingConnectedServiceMaterializationIdentityForSpawn({
                                token: params.credentials.token,
                                credentials: params.credentials,
                                sessionId: input.sessionId,
                                agentId: input.agentId,
                                connectedServices: input.connectedServices,
                                vendorResumeId: input.vendorResumeId,
                            }),
                        pidToTrackedSession: params.pidToTrackedSession,
                        pidToAwaiter: params.pidToAwaiter,
                        pidToSpawnResultResolver: params.pidToSpawnResultResolver,
                        pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
                        resolveCanonicalTrackedSessionId,
                        onChildExited,
                        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
                        sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
                        processEnv: params.processEnv,
                    }),
                );
            });
        } catch (error) {
            logger.warn('[DAEMON RUN] Failed before spawn session work started', {
                error,
                hasExistingSessionId: typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0,
                hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
                backendTargetKind: resolveConcreteBackendTargetRefV2(options.backendTarget)?.kind ?? null,
            });
            throw error;
        }
    };
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> =>
        await runSpawnSession(options, { nudgeAlreadyRunningPendingQueue: true });

    const temporaryThrottleResumeSnapshotsBySessionId = new Map<string, TrackedSession>();
    const findTemporaryThrottleTrackedSession = (sessionId: string): TrackedSession | null => {
        const normalizedSessionId = normalizeOptionalString(sessionId);
        if (!normalizedSessionId) return null;
        return findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), normalizedSessionId)
            ?? temporaryThrottleResumeSnapshotsBySessionId.get(normalizedSessionId)
            ?? null;
    };
    // RD-REC-16 port: the throttle intent is durable but the in-memory resume snapshot is
    // not (and must not be persisted: spawn options can carry secret environment values).
    // After a daemon restart, rebuild the resume source from persisted session metadata
    // instead of dead-lettering the hydrated intent.
    const resolveTemporaryThrottleResumeSource = async (
        sessionId: string,
    ): Promise<TemporaryThrottleResumeSource | null> => {
        const tracked = findTemporaryThrottleTrackedSession(sessionId);
        if (tracked) return tracked;
        const token = normalizeOptionalString(params.credentials.token);
        if (!token) return null;
        return await resolveInactiveTemporaryThrottleResumeSource({
            sessionId,
            fallbackMachineId: params.machineId,
            fetchSession: async (id) => await fetchSessionByIdCompat({ token, sessionId: id }),
            decryptSessionMetadata: (rawSession) => tryReadSessionMetadataRecord({
                rawSession,
                credentials: params.credentials,
            }),
        });
    };
    const temporaryThrottleScheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
        nowMs: () => Date.now(),
        baseBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_BASE_BACKOFF_MS,
            1_000,
            { min: 100, max: 60_000 },
        ),
        maxBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_BACKOFF_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
        ),
        maxAttempts: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_ATTEMPTS,
            3,
            { min: 1, max: 100 },
        ),
        resume: async (_intent, { sessionId }) => {
            const tracked = await resolveTemporaryThrottleResumeSource(sessionId);
            if (!tracked) {
                temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
                throw new Error('temporary_throttle_session_not_found');
            }
            const seed = buildTrackedExistingSessionResumeSeed({ tracked, sessionId });
            if (!seed) {
                throw new Error('temporary_throttle_resume_options_missing');
            }
            const respawnOptions = await resolveRespawnSessionOptionsWithRuntimeSnapshot({
                sessionId,
                spawnOptions: seed.spawnOptions,
                vendorResumeId: seed.vendorResumeId,
                defaultOptions: seed.defaultOptions,
                credentials: params.credentials,
            });
            const result = await spawnSession(respawnOptions);
            if (result.type === 'success') {
                temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
                logger.debug('[DAEMON RUN] Temporary throttle recovery resumed session', {
                    sessionId,
                    resumedSessionId: result.sessionId ?? sessionId,
                });
                return;
            }
            throw new Error(`temporary_throttle_resume_failed:${result.type}${result.type === 'error' ? `:${result.errorCode}` : ''}`);
        },
    });
    const temporaryThrottleRecovery = {
        enable: async (input: Parameters<typeof temporaryThrottleScheduler.enable>[0]) => {
            const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
            if (tracked) {
                temporaryThrottleResumeSnapshotsBySessionId.set(
                    input.sessionId,
                    snapshotTrackedSessionForTemporaryThrottleResume(tracked),
                );
            }
            return await temporaryThrottleScheduler.enable(input);
        },
        wake: async (input: Parameters<typeof temporaryThrottleScheduler.wake>[0]) =>
            await temporaryThrottleScheduler.wake(input),
    };
    temporaryThrottleScheduler.hydrate();

    const stopSessionCore = createStopSession({ pidToTrackedSession: params.pidToTrackedSession });
    const connectedServiceContinuationProviderActivityTimeoutMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_CONTINUATION_PROVIDER_ACTIVITY_TIMEOUT_MS,
        5 * 60_000,
        { min: 1_000, max: 24 * 60 * 60_000 },
    );
    const connectedServiceRecoverySupersessionCleaner = createConnectedServiceRecoverySupersessionCleaner({
        providerActivityTimeoutMs: connectedServiceContinuationProviderActivityTimeoutMs,
        store: createSessionContinuationRecoveryMetadataStore({ credentials: params.credentials }),
        removeReportOutboxItemsForSession: async (sessionId) => {
            await removeRuntimeAuthFailureReportOutboxItemsForSession({ sessionId });
        },
        logDebug: (message, error) => logger.debug(message, error),
    });
    const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
        enabled: parseBooleanEnv(params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, false),
        maxRestarts: (() => {
            const maxAttempts = resolvePositiveIntEnv(
                params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS,
                10,
                { min: 0, max: 100 },
            );
            return maxAttempts === 0 ? null : maxAttempts;
        })(),
        baseDelayMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS,
            1_000,
            { min: 50, max: 5 * 60_000 },
        ),
        maxDelayMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS,
            60_000,
            { min: 50, max: 30 * 60_000 },
        ),
        jitterMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS,
            250,
            { min: 0, max: 10_000 },
        ),
        isSessionAlreadyRunning: async (sessionId) => await isSessionRunnerActive(sessionId),
        spawnSession,
        resolveRespawnOptions: async (input) => await resolveRespawnSessionOptionsWithRuntimeSnapshot({
            ...input,
            credentials: params.credentials,
        }),
        random: () => Math.random(),
        logDebug: (message, payload) => logger.debug(message, payload),
        logWarn: (message) => logger.warn(message),
    });
    const connectedServiceTurnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
        timeoutMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TURN_DEFERRAL_TIMEOUT_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
        ),
        disableDeferral: String(params.processEnv.HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL ?? '').trim() === '1',
        emitSessionEvent: (sessionId, event) => {
            void commitConnectedServiceAccountSwitchSessionEvent({
                credentials: params.credentials,
                sessionId,
                event,
                listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to commit connected-service switch deferral session event (non-fatal)', error);
            });
        },
    });
    const resolvePredictiveSoftSwitchModeForInput = async (input: Readonly<{
        sessionId: string;
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string;
        agentId?: string | null;
    }>): Promise<'supported' | 'unsupported'> => {
        const resolvedAgentId = typeof input.agentId === 'string' && input.agentId.trim()
            ? input.agentId.trim()
            : (() => {
                const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
                return resolveDaemonCatalogAgentIdFromBackendTarget(tracked?.spawnOptions?.backendTarget) ?? null;
            })();
        if (!resolvedAgentId) return 'unsupported';
        return await resolvePredictiveSoftSwitchCapability({
            declaredCapabilities: await getConnectedServiceRecoveryCapabilities(resolvedAgentId as CatalogAgentId)
                .catch(() => null),
            inferFromRuntimeAuthAdapter: async () => {
                const adapter = await getConnectedServiceRuntimeAuthAdapter(resolvedAgentId as CatalogAgentId);
                if (!adapter) return 'unsupported';
                const materialization = await adapter.materializeActiveProfile({
                    target: { agentId: resolvedAgentId },
                    selection: {
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        activeProfileId: input.activeProfileId,
                        profileId: input.activeProfileId,
                    },
                });
                return materialization?.supported === true ? 'supported' : 'unsupported';
            },
        });
    };
    const requestConnectedServiceRestartWithDeferral = async (input: Readonly<{
        sessionId: string;
        tracked: TrackedSession;
        source: 'manual' | 'automatic';
        policy: 'defer_until_turn_boundary' | 'defer_until_idle';
        target: ConnectedServiceSwitchTarget;
        restartSignalDelayMs: number;
        restartDiagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
        onSignalFailureLogMessage: string;
    }>): Promise<Readonly<{ signaled: boolean }>> => {
        // Tracks whether runSwitch actually executed (and thus reserved the pid + signalled). A
        // superseded/cancelled deferral resolves WITHOUT running runSwitch, so callers must not
        // treat a successful return as "signalled" — see the refresh handler's reservation logic.
        let signaled = false;
        try {
            await connectedServiceTurnDeferralQueue.requestSwitch({
                sessionId: input.sessionId,
                source: input.source,
                policy: input.policy,
                target: input.target,
                runSwitch: async () => {
                    params.connectedServicesRestartRequestedPids.add(input.tracked.pid);
                    // K5:gated_restart this raw SIGTERM IS the gated restart primitive's signal — it
                    // only fires inside the turn-deferral queue's runSwitch (deferred to the turn
                    // boundary), and the respawn re-verifies resume reachability (K1).
                    await requestConnectedServiceSessionRestartSignal({
                        pid: input.tracked.pid,
                        delayMs: input.restartSignalDelayMs,
                        preferProcessGroup: input.tracked.startedBy === 'daemon',
                        shouldSignal: () => params.pidToTrackedSession.get(input.tracked.pid) === input.tracked,
                        restartDiagnostic: input.restartDiagnostic,
                        recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
                        onSignalFailure: (error) => {
                            params.connectedServicesRestartRequestedPids.delete(input.tracked.pid);
                            logger.debug(input.onSignalFailureLogMessage, error);
                        },
                    });
                    // Reached only when the signal was emitted without throwing (a signal failure
                    // re-throws out of here and leaves `signaled` false so the reservation is not
                    // claimed by the caller).
                    signaled = true;
                },
            });
        } catch (error) {
            if (error instanceof ConnectedServiceSwitchDeferralConflictError && error.code === 'switch_cancelled') {
                logger.debug('[DAEMON RUN] Connected-service deferred restart superseded by a newer switch request', {
                    sessionId: input.sessionId,
                    serviceId: input.target.serviceId,
                    groupId: input.target.groupId,
                    generation: input.target.generation,
                    source: input.source,
                });
                return { signaled: false };
            }
            throw error;
        }
        return { signaled };
    };

    /**
     * K2: shared FSM auth-generation apply used by BOTH the reactive runtime-auth
     * failure coordinator AND the proactive quota coordinator. Routing the proactive
     * quota switch through this (instead of a bare respawn) gives it:
     *  - the same fail-closed reachability gate at respawn (K1) via the FSM's restart path,
     *  - Codex appServer hot-apply IN PLACE when eligible (no respawn, no
     *    ConnectedServiceRestartRequested) + X4 transport invalidation (carried by the
     *    materializer into the hot-apply selection),
     *  - the LOCKED mid-turn-limit contract: continueAfterRuntimeAuthSwitch re-continues
     *    the interrupted user turn under the new account exactly once (hot-apply continues
     *    in place; restart-resume re-drives the last user turn from vendor history). The
     *    exactly-once guard + chain-to-next-member + fail-closed live in the continuation
     *    controller and the switch coordinator/selector respectively.
     * `failureAtMs` anchors the continuation window. Side-effect idempotency for tool calls
     * executed before the limit is the provider adapter's responsibility (Codex prefers
     * hot-apply continue-in-place over re-drive to avoid double execution).
     */
    const buildConnectedServiceAuthGroupRestartSession = (builderInput: Readonly<{
        sessionId: string;
        failureAtMs: number;
        restartReason: string | null;
    }>) => async (restartInput: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string | null;
        generation: number;
    }>): Promise<ConnectedServiceAuthGroupGenerationApplyResult> => {
        const tracked = Array.from(params.pidToTrackedSession.values())
            .find((child) => child.happySessionId === builderInput.sessionId) ?? null;
        const inactiveContext = tracked
            ? null
            : await resolveInactiveConnectedServiceSessionContext({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId: builderInput.sessionId,
            });
        if (!tracked && !inactiveContext) {
            return connectedServiceAuthGroupGenerationApplyFailure({
                errorCode: 'session_not_found',
                serviceId: restartInput.serviceId,
                failurePhase: 'session_lookup',
            });
        }
        const signalRestart = async () => {
            if (!tracked) throw new Error('session_not_found');
            const restartSignalDelayMs = resolvePositiveIntEnv(
                params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
            );
            // K5:gated_restart the FSM's restart-resume fallback when hot-apply is
            // ineligible; gated through deferral + spawn-time reachability (K1).
            await requestConnectedServiceRestartWithDeferral({
                sessionId: builderInput.sessionId,
                tracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                    serviceId: restartInput.serviceId,
                    profileId: restartInput.activeProfileId,
                    groupId: restartInput.groupId,
                    generation: restartInput.generation,
                }),
                restartSignalDelayMs,
                restartDiagnostic: {
                    trigger: 'automatic_group_switch',
                    sessionId: builderInput.sessionId,
                    agentId: resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget) ?? null,
                    serviceId: restartInput.serviceId,
                    profileId: restartInput.activeProfileId,
                    groupId: restartInput.groupId,
                    generation: restartInput.generation,
                    reason: builderInput.restartReason,
                },
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth group session',
            });
        };
        const signalRestartWithoutConfirmedApply = async (): Promise<ConnectedServiceAuthGroupGenerationApplyFailure> => {
            try {
                await signalRestart();
            } catch {
                return connectedServiceAuthGroupGenerationApplyFailure({
                    errorCode: 'restart_failed',
                    serviceId: restartInput.serviceId,
                    failurePhase: 'restart',
                });
            }
            return connectedServiceAuthGroupGenerationApplyFailure({
                errorCode: 'generation_apply_not_confirmed',
                serviceId: restartInput.serviceId,
                failurePhase: 'restart',
            });
        };
        const agentId = tracked
            ? resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget)
            : inactiveContext?.agentId;
        if (!agentId) {
            return await signalRestartWithoutConfirmedApply();
        }
        const previousBindings = tracked
            ? readConnectedServiceBindingsOrEmpty(tracked.spawnOptions?.connectedServices)
            : readConnectedServiceBindingsOrEmpty(inactiveContext?.connectedServices);
        const previousBinding = previousBindings.bindingsByServiceId[restartInput.serviceId];
        const nextProfileId = normalizeOptionalString(restartInput.activeProfileId)
            || (previousBinding?.source === 'connected' ? previousBinding.profileId : '');
        if (
            !previousBinding
            || previousBinding.source !== 'connected'
            || previousBinding.selection !== 'group'
            || !nextProfileId
        ) {
            return await signalRestartWithoutConfirmedApply();
        }
        // K5:fsm_switch reactive + proactive-quota auth-generation apply routes through
        // the FSM (hot-apply-in-place when eligible, else gated restart-resume with
        // reachability + deferral + mid-turn re-continue exactly once).
        const result = await applyConnectedServiceAuthGenerationToTrackedSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            resolveInactiveSession: async ({ sessionId }) => {
                return await resolveInactiveConnectedServiceSessionContext({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                });
            },
            api: params.api,
            resolveContinuity: async ({
                tracked: continuityTracked,
                sessionId,
                agentId: continuityAgentId,
                serviceId,
                previous,
                next,
                previousBindings: continuityPreviousBindings,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
                vendorResumeId,
                runtimeAuthSelection,
                cwd: inactiveCwd,
                candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
            }) => {
                const persistedSessionMetadata = continuityTracked
                    ? await resolvePersistedConnectedServiceSwitchSessionMetadata({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId,
                    })
                    : null;
                const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
                    agentId: continuityAgentId,
                    baseDir: params.connectedServicesMaterializationBaseDir,
                    tracked: continuityTracked,
                    persistedSessionMetadata,
                    connectedServiceMaterializationIdentityV1,
                    vendorResumeId,
                    cwd: inactiveCwd,
                    candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile ?? null,
                });
                return await resolveSessionConnectedServiceSwitchContinuity({
                    sessionId,
                    agentId: continuityAgentId,
                    serviceId,
                    previousBinding: previous,
                    nextBinding: next,
                    tracked: continuityTracked,
                    connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
                    vendorResumeId: continuityContext.vendorResumeId,
                    fromBindingsRaw: continuityTracked?.spawnOptions?.connectedServices ?? continuityPreviousBindings,
                    toBindings: normalizedBindings,
                    accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                    targetMaterializedRoot: continuityContext.targetMaterializedRoot,
                    targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                    cwd: continuityContext.cwd,
                    candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
                    ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
                });
            },
            materializeRuntimeAuthSelection: async (materializerInput) =>
                await materializeSessionConnectedServiceRuntimeAuthSelection({
                    credentials: params.credentials,
                    api: params.api,
                    activeServerDir: configuration.activeServerDir,
                    input: materializerInput,
                    accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                    processEnv: params.processEnv,
                }),
            restartSession: async () => {
                await signalRestart();
            },
            persistSessionBindings: async ({
                sessionId,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
            }) => {
                const trackedForSession = findTrackedSessionByHappySessionId(
                    params.pidToTrackedSession.values(),
                    sessionId,
                );
                await persistSessionConnectedServiceBindings({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                    normalizedBindings,
                    connectedServiceMaterializationIdentityV1:
                        connectedServiceMaterializationIdentityV1 === undefined
                            ? resolveConnectedServiceMaterializationIdentityFromTrackedSession(trackedForSession)
                            : connectedServiceMaterializationIdentityV1,
                });
            },
            continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
                credentials: params.credentials,
                failureAtMs: builderInput.failureAtMs,
                resumePromptMode: resolveContinuationResumePromptMode(
                    getActiveAccountSettingsSnapshot()?.settings ?? null,
                ),
                resolveReplayPlan: ({ sessionId, switchReason }) => resolveConnectedServiceContinuationReplayPlan({
                    credentials: params.credentials,
                    sessionId,
                    failureAtMs: builderInput.failureAtMs,
                    turnDeferralQueue: connectedServiceTurnDeferralQueue,
                    switchReason,
                }),
                providerActivityTimeoutMs: connectedServiceContinuationProviderActivityTimeoutMs,
                logDebug: (message, error) => logger.debug(message, error),
            }),
            recoverAfterRuntimeAuthSwitch: createSelectionPostSwitchRecoveryHandler({
                getTrackedSessions: () => Array.from(params.pidToTrackedSession.values()),
            }),
            verifyProviderAccountAdoption: createSessionConnectedServiceAccountAdoptionVerifier(),
            hotApply: createSessionConnectedServiceAuthHotApply(),
            registerHotApplyTargets: (trackedForTargets) => {
                const targetAgentId = resolveDaemonCatalogAgentIdFromBackendTarget(
                    trackedForTargets.spawnOptions?.backendTarget,
                );
                if (!targetAgentId) return;
                const materializationIdentity =
                    resolveConnectedServiceMaterializationIdentityFromTrackedSession(trackedForTargets);
                if (!materializationIdentity) return;
                params.getConnectedServiceRefreshCoordinator()?.registerSpawnTarget({
                    pid: trackedForTargets.pid,
                    agentId: targetAgentId,
                    sessionId: trackedForTargets.happySessionId,
                    connectedServicesBindingsRaw: trackedForTargets.spawnOptions?.connectedServices,
                    materializationKey: materializationIdentity.id,
                    ...(trackedForTargets.spawnOptions?.environmentVariables
                        ? { connectedServiceSelectionsEnv: trackedForTargets.spawnOptions.environmentVariables }
                        : {}),
                });
                params.getConnectedServiceQuotasCoordinator()?.registerSpawnTarget({
                    pid: trackedForTargets.pid,
                    sessionId: trackedForTargets.happySessionId,
                    connectedServicesBindingsRaw: trackedForTargets.spawnOptions?.connectedServices ?? {},
                    ...(trackedForTargets.spawnOptions?.environmentVariables
                        ? { connectedServiceSelectionsEnv: trackedForTargets.spawnOptions.environmentVariables }
                        : {}),
                });
            },
            emitSessionEvent: (sessionId, event) => {
                void commitConnectedServiceAccountSwitchSessionEvent({
                    credentials: params.credentials,
                    sessionId,
                    event,
                    listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                }).catch((error) => {
                    logger.debug('[DAEMON RUN] Failed to commit automatic connected-service account switch session event (non-fatal)', error);
                });
            },
            request: {
                sessionId: builderInput.sessionId,
                agentId,
                bindings: {
                    v: 1,
                    bindingsByServiceId: {
                        ...previousBindings.bindingsByServiceId,
                        [restartInput.serviceId]: {
                            ...previousBinding,
                            groupId: restartInput.groupId,
                            profileId: nextProfileId,
                        },
                    },
                },
                expectedGroupGenerationByServiceId: {
                    [restartInput.serviceId]: restartInput.generation,
                },
            },
            reason: 'automatic_runtime_failure',
        });
        return result;
    };

    /**
     * K2 (cmpn4hhdi fix): the PROACTIVE quota-driven pre-turn switch coordinator. It is
     * built HERE (where the FSM/deferral/hot-apply primitives live) and handed to the
     * quotas coordinator via startDaemonRuntimeBootstrap. With a sessionId present, its
     * `restartSession` is the shared FSM apply builder above — so the appServer usage-limit
     * switch hot-applies in place when eligible (+ X4), and otherwise gates a deferred
     * restart-resume with the K1 reachability gate, instead of the previous raw SIGTERM.
     * `failureAtMs = Date.now()` is the proactive decision point; the continuation
     * controller's hasUserMessageAfterFailure guard suppresses re-continuation when no
     * interrupted turn exists.
     */
    const connectedServiceAuthGroupPreTurnSwitchCoordinator = {
        switchBeforeTurn: async (input: Readonly<{
            sessionId?: string;
            serviceId: string;
            groupId: string;
            reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
        }>): Promise<unknown> => {
            const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
            if (!sessionId) return { status: 'session_not_found' };
            const tracked = Array.from(params.pidToTrackedSession.values())
                .find((child) => child.happySessionId === sessionId) ?? null;
            if (!tracked) return { status: 'session_not_found' };
            const proactiveCoordinator = createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
                api: params.api,
                runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                leases: connectedServiceAuthGroupSwitchLeases,
                quotaFreshnessMs: resolvePositiveIntEnv(
                    params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
                    5 * 60_000,
                    { min: 1_000, max: 60 * 60_000 },
                ),
                nowMs: () => Date.now(),
                quotaCoordinator: params.getConnectedServiceQuotasCoordinator(),
                // K2: route the proactive quota switch through the shared FSM apply builder
                // (hot-apply-in-place when eligible, else gated restart-resume + mid-turn
                // re-continue). `restartReason` defaults to soft_threshold for proactive switches.
                restartSession: buildConnectedServiceAuthGroupRestartSession({
                    sessionId,
                    failureAtMs: Date.now(),
                    restartReason: input.reason ?? 'soft_threshold',
                }),
                emitEvent: (event) => {
                    if (!event.success || event.resultStatus !== 'switched') return;
                    void commitConnectedServiceAccountSwitchSessionEvent({
                        credentials: params.credentials,
                        sessionId,
                        event,
                        listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                    }).catch((error) => {
                        logger.debug('[DAEMON RUN] Failed to commit quota-driven connected-service account switch session event (non-fatal)', error);
                    });
                    const current = Array.from(params.pidToTrackedSession.values())
                        .find((child) => child.happySessionId === sessionId) ?? null;
                    const settingsSnapshot = getActiveAccountSettingsSnapshot();
                    const eventAction = event.action && typeof event.action === 'object'
                        && 'kind' in event.action
                        && event.action.kind === 'open_url'
                        && 'url' in event.action
                        && typeof event.action.url === 'string'
                        ? { kind: 'open_url' as const, url: event.action.url }
                        : null;
                    void dispatchConnectedServiceAccountSwitchNotificationAsync({
                        settings: settingsSnapshot?.settings ?? null,
                        settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                        expoPushSender: params.api.push(),
                        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                        listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                        source: {
                            sessionId,
                            sessionTitle: resolveTrackedSessionNotificationTitle(current),
                            serviceId: event.serviceId,
                            groupId: event.groupId,
                            fromProfileId: event.fromProfileId,
                            toProfileId: event.toProfileId,
                            reason: event.reason,
                            limitCategory: event.limitCategory ?? null,
                            retryAfterMs: event.retryAfterMs ?? null,
                            quotaScope: event.quotaScope ?? null,
                            providerLimitId: event.providerLimitId ?? null,
                            action: eventAction,
                        },
                        nowMs: () => Date.now(),
                        dedupeWindowMs: resolvePositiveIntEnv(
                            params.processEnv.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                            60_000,
                            { min: 0, max: 24 * 60 * 60_000 },
                        ),
                    }).catch((error) => {
                        logger.debug('[DAEMON RUN] Quota-driven connected-service account switch notification failed (non-fatal)', error);
                    });
                },
            });
            // O3: switch-attempt trace at the proactive-quota decision point (the cmpn4hhdi seam).
            const proactiveSwitchResult = await proactiveCoordinator.switchBeforeTurn(input);
            logger.debug('[DAEMON RUN] Connected-service proactive quota switch attempt', {
                trigger: 'automatic_group_switch',
                decision: 'proactive_quota_switch_before_turn',
                sessionId,
                serviceId: input.serviceId,
                groupId: input.groupId,
                reason: input.reason,
                resultStatus: (proactiveSwitchResult as { status?: unknown }).status ?? null,
                routedThroughFsm: true,
            });
            return proactiveSwitchResult;
        },
    };

    /**
     * K3 (D7): gated restart adapter for the credential-refresh / reconnect handler. The
     * refresh handler owns the eligibility/blocking decision; this adapter only enforces
     * turn-deferral + the spawn-time reachability gate (no raw mid-turn SIGTERM). Pure
     * refresh has no target generation rebind, so it routes through the gated restart
     * primitive rather than the FSM.
     */
    const requestConnectedServiceRefreshRestartSignal = async (signalParams: Readonly<{
        pid: number;
        delayMs: number;
        preferProcessGroup?: boolean;
        shouldSignal?: () => boolean;
        onSignalFailure: (error: unknown) => void;
        restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
        recordRestartDiagnostic?: (record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
        nowMs?: () => number;
    }>): Promise<Readonly<{ signaled: boolean }>> => {
        const tracked = params.pidToTrackedSession.get(signalParams.pid) ?? null;
        if (!tracked) {
            signalParams.onSignalFailure(new Error('refresh_restart_tracked_session_missing'));
            return { signaled: false };
        }
        const diagnostic = signalParams.restartDiagnostic;
        const sessionId = (typeof diagnostic?.sessionId === 'string' && diagnostic.sessionId.trim())
            ? diagnostic.sessionId.trim()
            : (tracked.happySessionId ?? '');
        logger.debug('[DAEMON RUN] Connected-service refresh restart attempt', {
            trigger: diagnostic?.trigger ?? 'refresh_triggered_restart',
            decision: 'gated_refresh_restart',
            sessionId,
            serviceId: diagnostic?.serviceId ?? null,
            groupId: diagnostic?.groupId ?? null,
            generation: diagnostic?.generation ?? null,
            deferralPolicy: 'defer_until_turn_boundary',
            routedThroughGatedPrimitive: true,
        });
        try {
            // K5:gated_restart refresh/reconnect restart deferred until turn boundary,
            // reachability re-verified at respawn (no raw mid-turn SIGTERM). Propagate whether a
            // signal was actually emitted so the refresh handler reserves the pid only when it was —
            // a superseded/cancelled deferral must not leak a reservation (F4).
            return await requestConnectedServiceRestartWithDeferral({
                sessionId,
                tracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                    serviceId: typeof diagnostic?.serviceId === 'string' ? diagnostic.serviceId : '',
                    profileId: typeof diagnostic?.profileId === 'string' ? diagnostic.profileId : '',
                    groupId: typeof diagnostic?.groupId === 'string' ? diagnostic.groupId : '',
                    generation: typeof diagnostic?.generation === 'number' ? diagnostic.generation : null,
                }),
                restartSignalDelayMs: signalParams.delayMs,
                restartDiagnostic: diagnostic ?? {
                    trigger: 'refresh_triggered_restart',
                    sessionId,
                },
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service credential-refreshed session',
            });
        } catch (error) {
            signalParams.onSignalFailure(error);
            return { signaled: false };
        }
    };

    const onChildExitedBase = createOnChildExited({
        pidToTrackedSession: params.pidToTrackedSession,
        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
        sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
        getApiMachineForSessions: params.getApiMachineForSessions,
        onUnexpectedExit: (tracked, exit) => {
            sessionRunnerRespawnManager.handleUnexpectedExit(tracked, exit, {
                forceRestart: params.connectedServicesRestartRequestedPids.has(tracked.pid),
            });
        },
        isExitUnexpectedOverride: (tracked) => {
            if (!params.connectedServicesRestartRequestedPids.has(tracked.pid)) return null;
            return true;
        },
        onPidPromoted: ({ fromPid, toPid }) => {
            params.getConnectedServiceRefreshCoordinator()?.transferPid(fromPid, toPid);
            params.getConnectedServiceQuotasCoordinator()?.transferPid(fromPid, toPid);
            if (params.connectedServicesRestartRequestedPids.delete(fromPid)) {
                params.connectedServicesRestartRequestedPids.add(toPid);
            }
        },
    });
    onChildExited = (pid, exit) => {
        const trackedBeforeExit = params.pidToTrackedSession.get(pid) ?? null;
        const restartWasRequested = params.connectedServicesRestartRequestedPids.has(pid);
        onChildExitedBase(pid, exit);
        if (!params.pidToTrackedSession.has(pid)) {
            params.getConnectedServiceRefreshCoordinator()?.unregisterPid(pid);
            params.getConnectedServiceQuotasCoordinator()?.unregisterPid(pid);
        }
        if (restartWasRequested) {
            params.connectedServicesRestartRequestedPids.delete(pid);
        }
        if (trackedBeforeExit?.happySessionId) {
            const stillLive = Array.from(params.pidToTrackedSession.values())
                .some((child) => child.happySessionId === trackedBeforeExit.happySessionId);
            if (!stillLive) {
                connectedServiceTurnDeferralQueue.cancelSession(
                    trackedBeforeExit.happySessionId,
                    restartWasRequested ? 'session_restarting' : 'session_terminated',
                );
            }
            if (!stillLive && !restartWasRequested) {
                connectedServiceRuntimeAuthSwitchAttempts.clearSession(trackedBeforeExit.happySessionId);
                connectedServiceSessionAuthSwitchCore.clearSession(trackedBeforeExit.happySessionId);
            }
        }
        void params.connectedServiceGroupHomeCleanupScheduler?.cleanupPendingDeletedGroupHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service group home cleanup tick failed (non-fatal)', error);
        });
        void params.connectedServiceMaterializedHomeCleanupScheduler?.cleanupPendingMaterializedHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service materialized home cleanup tick failed (non-fatal)', error);
        });
    };
    const stopSession = async (sessionId: string): Promise<boolean> => {
        sessionRunnerRespawnManager.markStopRequested(sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
        await connectedServiceRecoverySupersessionCleaner({
            sessionId,
            event: { kind: 'manual_session_supersession', reason: 'stop' },
        });
        const stopped = await stopSessionCore(sessionId);
        if (!stopped) return false;
        if (configuration.daemonStopSessionWaitForExitMs > 0) {
            await waitForExistingSessionExitIfStopRequested({
                sessionId,
                pidToTrackedSession: params.pidToTrackedSession,
                isSessionRunnerActive,
                timeoutMs: configuration.daemonStopSessionWaitForExitMs,
                pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs,
                onExitObserved: (pid, exit) => onChildExited(pid, exit),
            });
        }
        return true;
    };
    const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> =>
        await isSessionRunnerActive(sessionId);
    const controlToken = randomBytes(32).toString('base64url');
    const resolvePendingConnectedServiceContinuation =
        createConnectedServicePendingContinuationResolver({
            credentials: params.credentials,
            providerActivityTimeoutMs: connectedServiceContinuationProviderActivityTimeoutMs,
            logDebug: (message, error) => logger.debug(message, error),
        });
    const recordConnectedServiceContinuationProviderActivity =
        createConnectedServiceProviderActivityRecorder({
            credentials: params.credentials,
            providerActivityTimeoutMs: connectedServiceContinuationProviderActivityTimeoutMs,
            // `runtimeAuthRecoveryScheduler` is constructed later in this function; the
            // recorder only runs on turn-lifecycle events after startup completes.
            markRuntimeAuthRecoverySucceededByIdentity: async ({ sessionId, recoveryIdentity }) => {
                await runtimeAuthRecoveryScheduler.markProviderOutcomeProofByIdentity({
                    sessionId,
                    proofKind: 'provider_activity',
                    serviceId: recoveryIdentity.serviceId,
                    profileId: recoveryIdentity.profileId ?? null,
                    groupId: recoveryIdentity.groupId ?? null,
                });
            },
            logDebug: (message, error) => logger.debug(message, error),
        });
    void replayPendingConnectedServiceContinuationsForTrackedSessions({
        trackedSessions: params.pidToTrackedSession.values(),
        resolvePendingContinuation: resolvePendingConnectedServiceContinuation,
    }).catch((error) => {
        logger.debug('[DAEMON RUN] Failed to replay pending connected-service continuations after startup reattach', error);
    });

    const runtimeAuthRecoveryStormEvents: number[] = [];
    const runtimeAuthRecoveryStormWindowMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_WINDOW_MS,
        60_000,
        { min: 1_000, max: 60 * 60_000 },
    );
    const runtimeAuthRecoveryStormThreshold = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_THRESHOLD,
        5,
        { min: 1, max: 1_000 },
    );
    const runtimeAuthRecoveryStormDelayMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_DELAY_MS,
        30_000,
        { min: 1_000, max: 60 * 60_000 },
    );
    const runtimeAuthRecoveryJitterMaxMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_JITTER_MS,
        250,
        { min: 1, max: 60_000 },
    );
    const pruneRuntimeAuthRecoveryStormEvents = (nowMs: number): void => {
        const cutoffMs = nowMs - runtimeAuthRecoveryStormWindowMs;
        while (runtimeAuthRecoveryStormEvents.length > 0 && (runtimeAuthRecoveryStormEvents[0] ?? 0) < cutoffMs) {
            runtimeAuthRecoveryStormEvents.shift();
        }
    };
    const recordRuntimeAuthRecoveryDiagnostic = (diagnostic: RuntimeAuthRecoveryDiagnostic): void => {
        logger.debug('[DAEMON RUN] Connected-service runtime-auth recovery diagnostic', diagnostic);
        if (diagnostic.transcriptEvent) {
            void commitConnectedServiceRuntimeAuthRecoverySessionEvent({
                credentials: params.credentials,
                sessionId: diagnostic.sessionId,
                event: diagnostic.transcriptEvent,
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to commit connected-service runtime-auth recovery session event (non-fatal)', {
                    sessionId: diagnostic.sessionId,
                    serviceId: diagnostic.serviceId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }
        if (
            diagnostic.event === 'runtime_auth_recovery_enqueue'
            && diagnostic.errorClassification?.retryable === true
        ) {
            const nowMs = Date.now();
            pruneRuntimeAuthRecoveryStormEvents(nowMs);
            runtimeAuthRecoveryStormEvents.push(nowMs);
        }
        if (
            diagnostic.event === 'runtime_auth_recovery_dead_letter'
            || diagnostic.event === 'runtime_auth_recovery_terminal'
        ) {
            logger.warn('[DAEMON RUN] Connected-service runtime-auth recovery stopped', diagnostic);
        }
        if (diagnostic.event === 'runtime_auth_recovery_success') {
            runtimeAuthRecoveryStormEvents.length = 0;
        }
    };
    const runConnectedServiceRuntimeAuthFailureRecovery = async (input: Readonly<{
        sessionId: string;
        switchesThisTurn: number;
        resumePromptMode?: SessionContinuationResumePromptModeV1;
        // Scheduler replays (`scheduler_retry`) of persisted intents may be superseded when the
        // failing profile is no longer the session's spawned active profile; in-band reports
        // (default `daemon_report`) are fresh evidence and always run the pipeline.
        recoveryInvocationSource?: 'daemon_report' | 'scheduler_retry';
        classification: ConnectedServiceRuntimeFailureClassification;
    }>): Promise<unknown> => {
        const runtimeFailureAtMs = Date.now();
        const switchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api: params.api,
            runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
            leases: connectedServiceAuthGroupSwitchLeases,
            quotaFreshnessMs: resolvePositiveIntEnv(
                params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
                5 * 60_000,
                { min: 1_000, max: 60 * 60_000 },
            ),
            nowMs: () => Date.now(),
            probeQuotaSnapshotsForGroup: async (groupInput) => {
                await params.getConnectedServiceQuotasCoordinator()?.probeGroupQuotaSnapshots(groupInput);
            },
            // K2: reactive runtime-auth failure routes through the shared FSM apply builder
            // (hot-apply-in-place when eligible, else gated restart-resume + mid-turn
            // re-continue). Same builder the proactive quota coordinator uses.
            restartSession: buildConnectedServiceAuthGroupRestartSession({
                sessionId: input.sessionId,
                failureAtMs: runtimeFailureAtMs,
                restartReason: input.classification?.kind ?? null,
            }),
            emitEvent: (event) => {
                if (
                    event.success
                    && (event.resultStatus === 'switched' || event.resultStatus === 'observed_generation')
                ) {
                    void commitConnectedServiceAccountSwitchSessionEvent({
                        credentials: params.credentials,
                        sessionId: input.sessionId,
                        event,
                        listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                    }).catch((error) => {
                        logger.debug('[DAEMON RUN] Failed to commit connected-service account switch session event (non-fatal)', error);
                    });
                }
                if (!event.success || event.resultStatus !== 'switched') return;
                const trackedForNotification = Array.from(params.pidToTrackedSession.values())
                    .find((child) => child.happySessionId === input.sessionId) ?? null;
                const settingsSnapshot = getActiveAccountSettingsSnapshot();
                const eventAction = event.action && typeof event.action === 'object'
                    && 'kind' in event.action
                    && event.action.kind === 'open_url'
                    && 'url' in event.action
                    && typeof event.action.url === 'string'
                    ? { kind: 'open_url' as const, url: event.action.url }
                    : null;
                void dispatchConnectedServiceAccountSwitchNotificationAsync({
                    settings: settingsSnapshot?.settings ?? null,
                    settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                    expoPushSender: params.api.push(),
                    runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                    listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                    source: {
                        sessionId: input.sessionId,
                        sessionTitle: resolveTrackedSessionNotificationTitle(trackedForNotification),
                        serviceId: event.serviceId,
                        groupId: event.groupId,
                        fromProfileId: event.fromProfileId,
                        toProfileId: event.toProfileId,
                        reason: event.reason,
                        limitCategory: event.limitCategory ?? null,
                        retryAfterMs: event.retryAfterMs ?? null,
                        quotaScope: event.quotaScope ?? null,
                        providerLimitId: event.providerLimitId ?? null,
                        action: eventAction,
                    },
                    nowMs: () => Date.now(),
                    dedupeWindowMs: resolvePositiveIntEnv(
                        params.processEnv.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                        60_000,
                        { min: 0, max: 24 * 60 * 60_000 },
                    ),
                }).catch((error) => {
                    logger.debug('[DAEMON RUN] Connected-service account switch notification failed (non-fatal)', error);
                });
            },
        });
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            resolveInactiveSession: async ({ sessionId }) => {
                const context = await resolveInactiveConnectedServiceSessionContext({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                });
                return context
                    ? {
                        connectedServices: context.connectedServices,
                        ...(context.connectedServiceMaterializationIdentityV1
                            ? {
                                connectedServiceMaterializationIdentityV1:
                                    context.connectedServiceMaterializationIdentityV1,
                            }
                            : {}),
                    }
                    : null;
            },
            switchCoordinator,
            switchAttemptTracker: connectedServiceRuntimeAuthSwitchAttempts,
            switchCore: connectedServiceSessionAuthSwitchCore,
            runtimeAuthRecovery: runtimeAuthRecoveryScheduler,
            temporaryThrottleRecovery,
            emitSessionEvent: (sessionId, event) => {
                void commitConnectedServiceAccountSwitchSessionEvent({
                    credentials: params.credentials,
                    sessionId,
                    event,
                    listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                }).catch((error) => {
                    logger.debug('[DAEMON RUN] Failed to commit connected-service account switch session event (non-fatal)', error);
                });
            },
            sessionId: input.sessionId,
            switchesThisTurn: input.switchesThisTurn,
            ...(input.recoveryInvocationSource ? { recoveryInvocationSource: input.recoveryInvocationSource } : {}),
            classification: input.classification,
            refreshConnectedServiceCredentialForRuntimeAuthFailure: async (refreshInput) => {
                const refreshCoordinator = params.getConnectedServiceRefreshCoordinator();
                if (!refreshCoordinator) {
                    return {
                        status: 'credential_missing' as const,
                        credential: null,
                        diagnostic: {
                            serviceId: refreshInput.serviceId,
                            profileId: refreshInput.profileId,
                            reason: 'runtime_auth_failure' as const,
                            status: 'credential_missing' as const,
                            expiresAt: null,
                            expiryAgeMs: null,
                            refreshWindowMs: 0,
                        },
                    };
                }
                return await refreshCoordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure(refreshInput);
            },
            continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
                credentials: params.credentials,
                failureAtMs: runtimeFailureAtMs,
                resumePromptMode: resolveContinuationResumePromptMode(
                    getActiveAccountSettingsSnapshot()?.settings ?? null,
                    input.resumePromptMode,
                ),
                resolveReplayPlan: ({ sessionId, switchReason }) => resolveConnectedServiceContinuationReplayPlan({
                    credentials: params.credentials,
                    sessionId,
                    failureAtMs: runtimeFailureAtMs,
                    turnDeferralQueue: connectedServiceTurnDeferralQueue,
                    switchReason,
                }),
                providerActivityTimeoutMs: connectedServiceContinuationProviderActivityTimeoutMs,
                logDebug: (message, error) => logger.debug(message, error),
            }),
        });
        logger.debug('[DAEMON RUN] Connected-service reactive runtime-auth switch attempt', buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
            sessionId: input.sessionId,
            classification: input.classification,
            result,
            routedThroughFsm: true,
            startedAtMs: runtimeFailureAtMs,
            finishedAtMs: Date.now(),
        }));
        return result;
    };
    const runtimeAuthRecoveryScheduler = new RuntimeAuthRecoveryScheduler({
        nowMs: () => Date.now(),
        maxAttempts: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS,
            3,
            { min: 1, max: 100 },
        ),
        baseBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_DELAY_MS,
            1_000,
            { min: 1, max: 24 * 60 * 60_000 },
        ),
        maxBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_DELAY_MS,
            60_000,
            { min: 1, max: 24 * 60 * 60_000 },
        ),
        providerOutcomePendingWaitMs: connectedServiceContinuationProviderActivityTimeoutMs,
        jitterMs: () => Math.floor(Math.random() * runtimeAuthRecoveryJitterMaxMs),
        store: createRecoveryIntentFileStore(join(
            configuration.activeServerDir,
            'connected-services',
            'runtime-auth-recovery.json',
        )),
        recover: runConnectedServiceRuntimeAuthFailureRecovery,
        gate: () => {
            const nowMs = Date.now();
            pruneRuntimeAuthRecoveryStormEvents(nowMs);
            if (runtimeAuthRecoveryStormEvents.length < runtimeAuthRecoveryStormThreshold) {
                return { status: 'open' as const };
            }
            return {
                status: 'delayed' as const,
                retryAtMs: nowMs + runtimeAuthRecoveryStormDelayMs + Math.floor(Math.random() * runtimeAuthRecoveryJitterMaxMs),
                reason: 'local_server_storm',
            };
        },
        recordDiagnostic: recordRuntimeAuthRecoveryDiagnostic,
    });
    runtimeAuthRecoveryScheduler.hydrate();
    connectedServiceRecoverySwitchGuard = createConnectedServiceRecoverySwitchGuard({
        runtimeAuthRecovery: runtimeAuthRecoveryScheduler,
        readTurnState: (sessionId) => connectedServiceTurnDeferralQueue.getTurnLifecycleState(sessionId),
        resolvePredictiveSoftSwitchMode: async (input) =>
            await resolvePredictiveSoftSwitchModeForInput(input),
    });
    const localServicesRuntime = createLocalServicesDaemonRuntime({
        machineId: params.machineId,
        processEnv: params.processEnv,
    });
    let controlRuntimeResourcesDisposed = false;
    const disposeControlRuntimeResources = (): void => {
        if (controlRuntimeResourcesDisposed) return;
        controlRuntimeResourcesDisposed = true;
        connectedServiceTurnDeferralQueue.cancelAll('daemon_shutdown');
        providerAccountUsagePersistence.dispose();
        // Stop recovery timers so a re-hydrated waiting intent cannot fire switch/restart work
        // into a stopped or tearing-down daemon. The persisted intent stays `waiting` for re-drive.
        runtimeAuthRecoveryScheduler.dispose();
        temporaryThrottleScheduler.dispose();
        localServicesRuntime.stop();
    };
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
        getChildren: () => Array.from(params.pidToTrackedSession.values()),
        machineId: params.machineId,
        stopSession,
        spawnSession,
        requestShutdown: () => params.requestShutdown('happier-cli'),
        ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
        beforeShutdown: async () => {
            disposeControlRuntimeResources();
            const beforeShutdown = params.beforeShutdown;
            if (typeof beforeShutdown === 'function') {
                await beforeShutdown();
            }
        },
        onHappySessionWebhook: (sessionId, sessionMetadata) => {
            params.onHappySessionWebhook(sessionId, sessionMetadata);
            if (!hasPendingContinuationRecovery(sessionMetadata)) return;
            const normalizedSessionId = normalizeOptionalString(sessionId);
            if (!normalizedSessionId) return;
            const tracked = [...params.pidToTrackedSession.values()]
                .find((candidate) => normalizeOptionalString(candidate.happySessionId) === normalizedSessionId);
            void (async () => {
                const exactProviderContextAvailable = tracked
                    ? await resolveConnectedServiceContinuationProviderContextAvailability({ tracked })
                    : false;
                await resolvePendingConnectedServiceContinuation({
                    sessionId: normalizedSessionId,
                    exactProviderContextAvailable,
                });
            })().catch((error) => {
                logger.debug('[DAEMON RUN] Failed to resolve connected-service continuation recovery after session report', error);
            });
        },
        ...(params.sshTunnelSupervisor ? { sshTunnels: params.sshTunnelSupervisor } : {}),
        localServicesInventory: localServicesRuntime.inventoryRoutes,
        handleSessionConnectedServiceAuthSwitch: async (input) => {
            const switchStartedAtMs = Date.now();
            await connectedServiceRecoverySupersessionCleaner({
                sessionId: input.sessionId,
                event: { kind: 'manual_session_supersession', reason: 'switch' },
            });
            const settingsRefresh = await refreshAccountSettingsForDaemonRequest({
                credentials: params.credentials,
                accountSettingsVersionHint: input.accountSettingsVersionHint,
            });
            let diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined;
            if (!settingsRefresh.ok) {
                logger.warn(
                    '[DAEMON RUN] Account settings freshness refresh failed before connected-service auth switch',
                    serializeAxiosErrorForLog(settingsRefresh.error),
                );
                diagnostics = {
                    accountSettingsFreshness: {
                        requestedVersion: typeof input.accountSettingsVersionHint === 'number'
                            ? input.accountSettingsVersionHint
                            : null,
                        status: 'failed',
                        error: toConnectedServiceAuthSwitchDiagnosticError(settingsRefresh.error),
                    },
                };
            } else if (typeof input.accountSettingsVersionHint === 'number') {
                diagnostics = {
                    accountSettingsFreshness: {
                        requestedVersion: input.accountSettingsVersionHint,
                        status: 'succeeded',
                    },
                };
            }

            // K5:fsm_switch manual auth switch routes through the FSM (reachability
            // gate at respawn, binding persistence, hot-apply-in-place when eligible).
            const result = await switchSessionConnectedServiceAuth({
                core: connectedServiceSessionAuthSwitchCore,
                getChildren: () => Array.from(params.pidToTrackedSession.values()),
                resolveInactiveSession: async ({ sessionId }) => {
                    return await resolveInactiveConnectedServiceSessionContext({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId,
                    });
                },
                api: params.api,
                resolveContinuity: async ({
                    tracked,
                    sessionId,
                    agentId,
                    serviceId,
                    previous,
                    next,
                    previousBindings,
                    normalizedBindings,
                    connectedServiceMaterializationIdentityV1,
                    vendorResumeId,
                    runtimeAuthSelection,
                    cwd: inactiveCwd,
                    candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
                }) => {
                    const persistedSessionMetadata = tracked
                        ? await resolvePersistedConnectedServiceSwitchSessionMetadata({
                            token: params.credentials.token,
                            credentials: params.credentials,
                            sessionId,
                        })
                        : null;
                    const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
                        agentId,
                        baseDir: params.connectedServicesMaterializationBaseDir,
                        tracked,
                        persistedSessionMetadata,
                        connectedServiceMaterializationIdentityV1,
                        vendorResumeId,
                        cwd: inactiveCwd,
                        candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile ?? null,
                    });
                    return await resolveSessionConnectedServiceSwitchContinuity({
                        sessionId,
                        agentId,
                        serviceId,
                        previousBinding: previous,
                        nextBinding: next,
                        tracked,
                        connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
                        vendorResumeId: continuityContext.vendorResumeId,
                        fromBindingsRaw: tracked?.spawnOptions?.connectedServices ?? previousBindings,
                        toBindings: normalizedBindings,
                        accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                        targetMaterializedRoot: continuityContext.targetMaterializedRoot,
                        targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                        cwd: continuityContext.cwd,
                        candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
                        ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
                    });
                },
                materializeRuntimeAuthSelection: async (materializerInput) =>
                    await materializeSessionConnectedServiceRuntimeAuthSelection({
                        credentials: params.credentials,
                        api: params.api,
                        activeServerDir: configuration.activeServerDir,
                        input: materializerInput,
                        accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                        processEnv: params.processEnv,
                    }),
                restartSession: async (tracked) => {
                    const serviceIds = Object.keys(input.bindings.bindingsByServiceId);
                    const primaryServiceId = serviceIds[0] ?? '';
                    const primaryBinding = primaryServiceId
                        ? input.bindings.bindingsByServiceId[primaryServiceId]
                        : null;
                    const primaryGeneration = primaryServiceId
                        ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
                        : undefined;
                    const restartSignalDelayMs = resolvePositiveIntEnv(
                        params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_SWITCH_RESTART_SIGNAL_DELAY_MS,
                        250,
                        { min: 0, max: 5_000 },
                    );
                    // K5:gated_restart manual restart-resume fallback (hot-apply ineligible);
                    // gated through deferral + spawn-time reachability (K1).
                    await requestConnectedServiceRestartWithDeferral({
                        sessionId: input.sessionId,
                        tracked,
                        source: 'manual',
                        policy: 'defer_until_turn_boundary',
                        target: normalizeSwitchTarget({
                            serviceId: primaryServiceId,
                            profileId: primaryBinding?.source === 'connected' ? primaryBinding.profileId : '',
                            groupId: primaryBinding?.source === 'connected' && primaryBinding.selection === 'group'
                                ? primaryBinding.groupId
                                : '',
                            generation: typeof primaryGeneration === 'number' && Number.isFinite(primaryGeneration)
                                ? Math.max(0, Math.trunc(primaryGeneration))
                                : 0,
                        }),
                        restartSignalDelayMs,
                        restartDiagnostic: buildManualSwitchRestartDiagnostic({
                            sessionId: input.sessionId,
                            agentId: input.agentId,
                            bindings: input.bindings,
                        }),
                        onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth-switched session',
                    });
                },
                persistSessionBindings: async ({
                    sessionId,
                    normalizedBindings,
                    connectedServiceMaterializationIdentityV1,
                }) => {
                    const tracked = findTrackedSessionByHappySessionId(
                        params.pidToTrackedSession.values(),
                        sessionId,
                    );
                    await persistSessionConnectedServiceBindings({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId,
                        normalizedBindings,
                        connectedServiceMaterializationIdentityV1:
                            connectedServiceMaterializationIdentityV1 === undefined
                                ? resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked)
                                : connectedServiceMaterializationIdentityV1,
                    });
                },
                continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
                    credentials: params.credentials,
                    failureAtMs: switchStartedAtMs,
                    resumePromptMode: resolveContinuationResumePromptMode(
                        getActiveAccountSettingsSnapshot()?.settings ?? null,
                    ),
                    resolveReplayPlan: ({ sessionId, switchReason }) => resolveConnectedServiceContinuationReplayPlan({
                        credentials: params.credentials,
                        sessionId,
                        failureAtMs: switchStartedAtMs,
                        turnDeferralQueue: connectedServiceTurnDeferralQueue,
                        switchReason,
                    }),
                    providerActivityTimeoutMs: connectedServiceContinuationProviderActivityTimeoutMs,
                    logDebug: (message, error) => logger.debug(message, error),
                }),
                recoverAfterRuntimeAuthSwitch: createSelectionPostSwitchRecoveryHandler({
                    getTrackedSessions: () => Array.from(params.pidToTrackedSession.values()),
                }),
                verifyProviderAccountAdoption: createSessionConnectedServiceAccountAdoptionVerifier(),
                hotApply: createSessionConnectedServiceAuthHotApply(),
                registerHotApplyTargets: (tracked) => {
                    const agentId = resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
                    if (!agentId) return;
                    const materializationIdentity =
                        resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked);
                    if (!materializationIdentity) return;
                    params.getConnectedServiceRefreshCoordinator()?.registerSpawnTarget({
                        pid: tracked.pid,
                        agentId,
                        sessionId: tracked.happySessionId,
                        connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices,
                        materializationKey: materializationIdentity.id,
                        ...(tracked.spawnOptions?.environmentVariables
                            ? { connectedServiceSelectionsEnv: tracked.spawnOptions.environmentVariables }
                            : {}),
                    });
                    params.getConnectedServiceQuotasCoordinator()?.registerSpawnTarget({
                        pid: tracked.pid,
                        sessionId: tracked.happySessionId,
                        connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices ?? {},
                        ...(tracked.spawnOptions?.environmentVariables
                            ? { connectedServiceSelectionsEnv: tracked.spawnOptions.environmentVariables }
                            : {}),
                    });
                },
                emitSessionEvent: (sessionId, event) => {
                    void commitConnectedServiceAccountSwitchSessionEvent({
                        credentials: params.credentials,
                        sessionId,
                        event,
                        listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                    }).catch((error) => {
                        logger.debug('[DAEMON RUN] Failed to commit manual connected-service account switch session event (non-fatal)', error);
                    });
                    const record = event && typeof event === 'object' ? event as Record<string, unknown> : null;
                    if (!record || record.type !== 'connected_service_account_switch') return;
                    const serviceIdParsed = ConnectedServiceIdSchema.safeParse(record.serviceId);
                    if (!serviceIdParsed.success) return;
                    const trackedForNotification = Array.from(params.pidToTrackedSession.values())
                        .find((child) => child.happySessionId === sessionId) ?? null;
                    const settingsSnapshot = getActiveAccountSettingsSnapshot();
                    void dispatchConnectedServiceAccountSwitchNotificationAsync({
                        settings: settingsSnapshot?.settings ?? null,
                        settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                        expoPushSender: params.api.push(),
                        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                        listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
                        source: {
                            sessionId,
                            sessionTitle: resolveTrackedSessionNotificationTitle(trackedForNotification),
                            serviceId: serviceIdParsed.data,
                            groupId: typeof record.groupId === 'string' ? record.groupId : '',
                            fromProfileId: typeof record.fromProfileId === 'string' ? record.fromProfileId : null,
                            toProfileId: typeof record.toProfileId === 'string' ? record.toProfileId : null,
                            reason: 'manual',
                        },
                        nowMs: () => Date.now(),
                        dedupeWindowMs: resolvePositiveIntEnv(
                            params.processEnv.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                            60_000,
                            { min: 0, max: 24 * 60 * 60_000 },
                        ),
                    }).catch((error) => {
                        logger.debug('[DAEMON RUN] Manual connected-service account switch notification failed (non-fatal)', error);
                    });
                },
                request: input,
            });
            const resultWithDiagnostics = attachConnectedServiceAuthSwitchDiagnostics(result, diagnostics);
            logConnectedServiceAuthSwitchResult({
                sessionId: input.sessionId,
                agentId: input.agentId,
                serviceIds: Object.keys(input.bindings.bindingsByServiceId),
                result: resultWithDiagnostics,
            });
            return resultWithDiagnostics;
        },
        handleConnectedServiceRuntimeAuthFailure: runConnectedServiceRuntimeAuthFailureRecovery,
        runtimeAuthRecoveryScheduler,
        handleConnectedServiceTurnLifecycle: async (input) => {
            connectedServiceTurnDeferralQueue.recordTurnLifecycleEvent({
                sessionId: input.sessionId,
                event: input.event,
            });
            if (input.event === 'task_started' || input.event === 'assistant_message_end') {
                // Record provider activity BEFORE supersession so attempts already awaiting
                // this activity settle as observed instead of being suppressed.
                await recordConnectedServiceContinuationProviderActivity({
                    sessionId: input.sessionId,
                    recoveryIdentities: resolveTrackedContinuationRecoveryIdentities({
                        sessionId: input.sessionId,
                        getChildren: () => Array.from(params.pidToTrackedSession.values()),
                    }),
                });
            }
            // The cleaner decides internally which lifecycle events supersede pending
            // continuation recovery (turn cancellation AND normal turn completion).
            await connectedServiceRecoverySupersessionCleaner({
                sessionId: input.sessionId,
                event: { kind: 'turn_lifecycle', event: input.event },
            });
            return { status: 'recorded' as const };
        },
        handleConnectedServiceQuotaSnapshot: async (input) => await recordConnectedServiceRuntimeQuotaSnapshotForSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            quotaCoordinator: null,
            runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
            sessionId: input.sessionId,
            serviceId: input.serviceId,
            snapshot: input.snapshot,
        }),
        handleProviderAccountUsageSnapshot: async (input) => await recordProviderAccountUsageSnapshotForSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            store: providerAccountUsageStore,
            persistence: providerAccountUsagePersistence,
            publishRecordId: async ({ sessionId, recordId }) => await publishProviderAccountUsageRecordIdToSessionMetadata({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId,
                recordId,
            }),
            sessionId: input.sessionId,
            snapshot: input.snapshot,
        }),
        handleProviderAccountUsageAdoption: async (input) => await recordProviderAccountUsageAdoptionForSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            store: providerAccountUsageStore,
            persistence: providerAccountUsagePersistence,
            publishRecordId: async ({ sessionId, recordId }) => await publishProviderAccountUsageRecordIdToSessionMetadata({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId,
                recordId,
            }),
            sessionId: input.sessionId,
            adoption: input.adoption,
        }),
        handleCodexChatGptAuthTokensRefresh: async (input) => {
            const refreshCoordinator = params.getConnectedServiceRefreshCoordinator();
            if (!refreshCoordinator) {
                throw new Error('connected_service_chatgpt_refresh_handler_unavailable');
            }
            return await refreshCoordinator.refreshOpenAiCodexChatGptTokensForBridge({
                selection: input.selection,
                chatgptPlanType: input.chatgptPlanType,
            });
        },
        controlToken,
    });
    void drainRuntimeAuthFailureReportOutboxToDaemon().catch((error) => {
        logger.debug('[DAEMON RUN] Failed to drain connected-service runtime-auth failure report outbox after startup (non-fatal)', error);
    });

    const stopControlServerWithConnectedServiceDeferralCleanup = async (): Promise<void> => {
        disposeControlRuntimeResources();
        await stopControlServer();
    };

    return {
        spawnSession,
        stopSession,
        isSessionAlreadyRunning,
        onChildExited,
        controlPort,
        controlToken,
        stopControlServer: stopControlServerWithConnectedServiceDeferralCleanup,
        // K2: FSM-routed proactive quota pre-turn switch coordinator (consumed by the quotas
        // coordinator via startDaemonRuntimeBootstrap — replaces the old raw-signal coordinator).
        connectedServiceAuthGroupPreTurnSwitchCoordinator,
        connectedServiceRecoverySwitchGuard,
        // K3: gated credential-refresh / reconnect restart adapter (turn-deferral + reachability).
        requestConnectedServiceRefreshRestartSignal,
        retryTemporaryThrottleNow: async ({ sessionId }) =>
            await temporaryThrottleScheduler.wake({ sessionId, reason: 'manual' }),
        // K2: the single runtime quota-snapshot store shared by the reactive coordinator, the
        // proactive pre-turn coordinator, and (via bootstrap) the quotas coordinator + in-band
        // recorder — so the proactive selection sees the same probed snapshots (matches the
        // single-store design of the monolithic reference).
        connectedServiceRuntimeQuotaSnapshots,
    };
}
