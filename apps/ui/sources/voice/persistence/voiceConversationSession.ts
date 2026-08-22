import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    buildBackendTargetKeyV2,
    buildSystemSessionMetadataV1,
    AgentSessionStartupInstructionsV1Schema,
    isConnectedServiceUxDiagnosticSpawnErrorDetail,
    readBackendTargetRefV2,
    renderPromptPlanV1,
    type AgentSessionStartupInstructionsV1,
    type AgentSessionStartupInstructionsMarkerV1,
    type ConnectedServiceBindingsV1,
    type BackendTargetRefV2,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import {
    readPermissionModeIntentFromMetadata,
    buildGlobalVoiceAgentStartupInstructionsPlanV1,
    GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
    GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
    type PermissionIntent,
} from '@happier-dev/agents';

import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    completeMachineSpawnAttemptCustody,
    completePendingMachineSpawnAttemptCustodyForSession,
    machineSpawnNewSession,
    machineSpawnTrustedHiddenSystemSession,
} from '@/sync/ops/machines';
import { createUiSessionSpawnNonce } from '@/sync/domains/session/spawn/spawnSessionNonce';
import { resolveSpawnAttemptDirectoryIdentity } from '@/sync/domains/session/spawn/spawnAttemptKey';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

import {
    matchesVoiceConversationScope,
    writeVoiceConversationScopeMetadata,
    type VoiceConversationScopeMetadata,
} from './voiceConversationScopeMetadata';
import { persistVoiceAutoTargetMachineId } from './voiceAutoTargetMachineSettings';
import {
    findPreferredVoiceConversationSystemSession,
    findReusableVoiceConversationRuntimeSessionId,
    isReusableVoiceConversationRuntimeSession,
    listVoiceConversationSystemSessions,
    VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

export {
    findReusableVoiceConversationRuntimeSessionId,
    findVoiceConversationSessionId,
    isVoiceConversationSystemSessionMetadata,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

const VOICE_HOME_SPAWN_TARGET_WAIT_TIMEOUT_MS = 5_000;
const VOICE_HOME_SPAWN_TARGET_WAIT_INTERVAL_MS = 100;
const VOICE_HOME_STALE_CUSTODY_REPLAY_RETRY_LIMIT = 1;
const VOICE_CONVERSATION_METADATA_COMMIT_FAILED =
    'VOICE_CONVERSATION_METADATA_COMMIT_FAILED';
const VOICE_CONVERSATION_CUSTODY_COMPLETION_FAILED =
    'VOICE_CONVERSATION_CUSTODY_COMPLETION_FAILED';
const VOICE_CONVERSATION_RETIREMENT_FAILED =
    'VOICE_CONVERSATION_RETIREMENT_FAILED';

/**
 * Structural discriminator for the finalization step that failed. Callers and
 * logs need the distinct cause; the underlying provider/transport text stays
 * private and is never carried on the error.
 */
export type VoiceConversationSessionMetadataCommitReason =
    /** `sync.refreshSessions()` rejected before the spawned session could be observed. */
    | 'session_refresh_failed'
    /** The spawned session never published owner metadata within the wait budget. */
    | 'session_metadata_wait_timed_out'
    /** The metadata commit write itself was rejected. */
    | 'metadata_write_rejected'
    /** No step could be attributed; the cause stays honestly unknown. */
    | 'unknown';

export class VoiceConversationSessionMetadataCommitError extends Error {
    readonly code = VOICE_CONVERSATION_METADATA_COMMIT_FAILED;
    readonly sessionId: string;
    readonly reason: VoiceConversationSessionMetadataCommitReason;

    constructor(sessionId: string, reason: VoiceConversationSessionMetadataCommitReason) {
        super('Voice conversation session metadata could not be committed');
        this.name = 'VoiceConversationSessionMetadataCommitError';
        this.sessionId = sessionId;
        this.reason = reason;
    }

    get compensationFailureCode(): typeof VOICE_CONVERSATION_RETIREMENT_FAILED | undefined {
        return undefined;
    }
}

export class VoiceConversationSessionCustodyCompletionError extends Error {
    readonly code = VOICE_CONVERSATION_CUSTODY_COMPLETION_FAILED;
    readonly sessionId: string;

    constructor(sessionId: string, message: string) {
        super(message);
        this.name = 'VoiceConversationSessionCustodyCompletionError';
        this.sessionId = sessionId;
    }

    get compensationFailureCode(): typeof VOICE_CONVERSATION_RETIREMENT_FAILED | undefined {
        return undefined;
    }
}

function attachVoiceConversationRetirementFailure(
    error: VoiceConversationSessionMetadataCommitError | VoiceConversationSessionCustodyCompletionError,
): typeof error {
    Object.defineProperty(error, 'compensationFailureCode', {
        value: VOICE_CONVERSATION_RETIREMENT_FAILED,
        enumerable: true,
        configurable: false,
        writable: false,
    });
    return error;
}

type VoiceHomeConversationSessionRequirementFields = Readonly<{
    connectedServices?: ConnectedServiceBindingsV1;
    permissionIntent: PermissionIntent;
    /**
     * Exact resolved-runtime/version proof that startup instructions remain
     * model-visible on the first delegated turn after a cold resume.
     * Carrier support and realtime availability never imply this fact.
     */
    coldResumeStartupInstructionsEffective: boolean;
    /**
     * Declaration-gated host check for exact Agent/account/facet compatibility.
     * The hidden-session owner supplies only the bounded candidate identity and
     * metadata; provider leaves never inspect arbitrary runtime objects.
     */
    isReusableSession(input: Readonly<{
        sessionId: string;
        metadata: unknown;
    }>): boolean | Promise<boolean>;
}>;

export type VoiceHomeConversationSessionRequirements =
    VoiceHomeConversationSessionRequirementFields
    & (
        | Readonly<{
            backendTarget: BackendTargetRefV2;
            agentIdentity?: never;
        }>
        | Readonly<{
            backendTarget?: never;
            agentIdentity: PluginContributionIdentityV1;
        }>
    );

type ResolvedVoiceHomeConversationSessionRequirements =
    VoiceHomeConversationSessionRequirementFields
    & Readonly<{ backendTarget: BackendTargetRefV2 }>;

const GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER = Object.freeze({
    v: 1 as const,
    id: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
    revision: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
});

function buildVoiceConversationSystemSessionMetadata() {
    return buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true });
}

function readCanonicalVoiceSettingsFromState(state: any): VoiceSettings {
    return voiceSettingsParse(state?.settings?.voice);
}

function resolveVoiceConversationPermissionIntent(state: any) {
    return readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent.permissionIntent;
}

function withCanonicalVoiceSettings(state: any): any {
    return {
        ...state,
        settings: {
            ...(state?.settings ?? {}),
            voice: readCanonicalVoiceSettingsFromState(state),
        },
    };
}

function resolveVoiceHomeDirectory(state: any, machineId: string): string | null {
    const agentCfg = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent;
    const subdir = normalizeNonEmptyString(agentCfg?.voiceHomeSubdirName) ?? 'voice-agent';
    const machine = resolveMachineForActiveServerFromState(state, machineId);
    if (machine && machine.active === false) return null;
    const happyHomeDir = normalizeNonEmptyString(machine?.metadata?.happyHomeDir);
    if (happyHomeDir) {
        return resolveMachineAbsolutePath({
            rootPath: happyHomeDir,
            requestPath: subdir,
        });
    }

    for (const recent of state?.settings?.recentMachinePaths ?? []) {
        if (normalizeNonEmptyString(recent?.machineId) !== machineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }

    for (const session of Object.values(state?.sessions ?? {}) as any[]) {
        const resolvedTarget = typeof session?.id === 'string' ? readMachineTargetForSession(session.id) : null;
        if (normalizeNonEmptyString(resolvedTarget?.machineId) !== machineId) continue;
        const sessionDirectory = normalizeNonEmptyString(resolvedTarget?.basePath);
        if (sessionDirectory) return sessionDirectory;
    }

    return null;
}

function resolveRecentVoiceDirectoryForMachine(state: any, machineId: string | null | undefined): string | null {
    const normalizedMachineId = normalizeNonEmptyString(machineId);
    if (!normalizedMachineId) return null;
    for (const recent of state?.settings?.recentMachinePaths ?? []) {
        if (normalizeNonEmptyString(recent?.machineId) !== normalizedMachineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }
    return null;
}

function resolveRecentVoiceDirectoryForRouteMachine(state: any, routeMachineId: string | null | undefined): string | null {
    const normalizedRouteMachineId = normalizeNonEmptyString(routeMachineId);
    if (!normalizedRouteMachineId) return null;
    for (const recent of state?.settings?.recentMachinePaths ?? []) {
        const recentMachineId = normalizeNonEmptyString(recent?.machineId);
        if (resolveVoiceExecutionMachineIdFromState(state, { machineId: recentMachineId ?? '' }) !== normalizedRouteMachineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }
    return null;
}

function resolveVoiceSpawnDirectoryIdentity(
    state: any,
    machineId: string,
    directory: unknown,
): string | null {
    const normalizedDirectory = normalizeNonEmptyString(directory);
    if (!normalizedDirectory) return null;
    const machine = resolveMachineForActiveServerFromState(state, machineId);
    return resolveSpawnAttemptDirectoryIdentity(
        normalizedDirectory,
        normalizeNonEmptyString(machine?.metadata?.homeDir),
    );
}

function resolveRequiredVoiceSpawnDirectoryIdentity(
    state: any,
    machineId: string,
    directory: string,
): string {
    const identity = resolveVoiceSpawnDirectoryIdentity(state, machineId, directory);
    if (!identity) throw new Error('Voice spawn directory identity is unavailable');
    return identity;
}

function resolveVoiceHomeSpawnTarget(state: any): { machineId: string; directory: string } | null {
    const canonicalState = withCanonicalVoiceSettings(state);
    const machineId = resolveVoiceExecutionMachineIdFromState(canonicalState);
    if (!machineId) return null;
    const voice = canonicalState.settings.voice as VoiceSettings;
    const configuredOriginId = voice.executionMachine.mode === 'fixed'
        ? voice.executionMachine.machineId
        : voice.executionMachine.autoMachineId;
    const directory =
        resolveVoiceHomeDirectory(canonicalState, machineId)
        ?? resolveRecentVoiceDirectoryForMachine(canonicalState, configuredOriginId)
        ?? resolveRecentVoiceDirectoryForRouteMachine(canonicalState, machineId);
    return directory ? { machineId, directory } : null;
}

export function resolveVoiceHomeDaemonMachineId(state: any = storage.getState()): string | null {
    return resolveVoiceExecutionMachineIdFromState(withCanonicalVoiceSettings(state));
}

async function resolveVoiceConversationBackendTarget(state: any, machineId: string): Promise<BackendTargetRefV2> {
    const settings = state?.settings ?? {};
    const agentCfg = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent;
    const agentSource = normalizeNonEmptyString(agentCfg?.agentSource) ?? 'session';
    const requestedAgentId = normalizeNonEmptyString(agentCfg?.agentId);

    // An explicitly configured voice Agent is the user's selection, bundled or
    // externally installed. Narrowing to the bundled ids here silently ran the
    // conversation on the projection's preferred backend instead of the Agent
    // the user picked.
    if (agentSource === 'agent' && requestedAgentId) {
        return { kind: 'backend', backendId: requestedAgentId };
    }

    const daemonMergedProjectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        serverId: getActiveServerSnapshot().serverId,
    });
    return resolvePreferredBackendTargetFromProjection({
        lastUsedAgent: settings.lastUsedAgent,
        lastUsedBackendTarget: settings.lastUsedBackendTarget,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
        acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
        daemonMergedProjectionInputs,
    });
}

function sameContributionIdentity(
    left: PluginContributionIdentityV1 | null | undefined,
    right: PluginContributionIdentityV1,
): boolean {
    return left?.pluginId === right.pluginId && left.localId === right.localId;
}

export async function resolveQualifiedAgentBackendTargetForMachine(input: Readonly<{
    machineId: string | null | undefined;
    agent: PluginContributionIdentityV1;
}>): Promise<BackendTargetRefV2 | null> {
    const machineId = normalizeNonEmptyString(input.machineId);
    if (machineId) {
        const projectionInputs = await loadDaemonMergedProjectionInputs({
            machineId,
            serverId: getActiveServerSnapshot().serverId,
        });
        if (projectionInputs) {
            const matchingAgents = Object.entries(projectionInputs.mergedProviderProjectionById)
                .filter(([, entry]) => sameContributionIdentity(entry.identity, input.agent));
            if (matchingAgents.length === 1) {
                const [agentId, agentProjection] = matchingAgents[0]!;
                const settingsBackendId = normalizeNonEmptyString(agentProjection.settingsBackendId);
                if (settingsBackendId) {
                    const settingsBackend = projectionInputs.mergedBackendProjectionById[settingsBackendId];
                    return settingsBackend?.agentId === agentId
                        ? { kind: 'backend', backendId: settingsBackendId }
                        : null;
                }

                const matchingBackends = Object.values(projectionInputs.mergedBackendProjectionById)
                    .filter((entry) => entry.agentId === agentId);
                if (matchingBackends.length === 1) {
                    return { kind: 'backend', backendId: matchingBackends[0]!.backendId };
                }
                if (matchingBackends.length > 1) {
                    return null;
                }

                const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(input.agent);
                return bundledAgentId === agentId
                    ? { kind: 'backend', backendId: bundledAgentId }
                    : null;
            }
            if (matchingAgents.length > 1) {
                return null;
            }
        }
    }

    const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(input.agent);
    return bundledAgentId
        ? { kind: 'backend', backendId: bundledAgentId }
        : null;
}

async function resolveVoiceHomeConversationSessionRequirements(
    requirements: VoiceHomeConversationSessionRequirements,
    machineId: string,
): Promise<ResolvedVoiceHomeConversationSessionRequirements> {
    let backendTarget = requirements.backendTarget ?? null;
    if (!backendTarget && requirements.agentIdentity) {
        backendTarget = await resolveQualifiedAgentBackendTargetForMachine({
            machineId,
            agent: requirements.agentIdentity,
        });
    }
    if (!backendTarget) {
        throw Object.assign(
            new Error('voice_agent_backend_target_unavailable'),
            { code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE' },
        );
    }
    return {
        backendTarget,
        ...(requirements.connectedServices
            ? { connectedServices: requirements.connectedServices }
            : {}),
        permissionIntent: requirements.permissionIntent,
        coldResumeStartupInstructionsEffective: requirements.coldResumeStartupInstructionsEffective,
        isReusableSession: requirements.isReusableSession,
    };
}

async function waitForVoiceHomeSpawnTarget(timeoutMs: number): Promise<{ machineId: string; directory: string } | null> {
    const startedAt = Date.now();
    let target = resolveVoiceHomeSpawnTarget(storage.getState());
    while (!target && (Date.now() - startedAt) < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, VOICE_HOME_SPAWN_TARGET_WAIT_INTERVAL_MS));
        target = resolveVoiceHomeSpawnTarget(storage.getState());
    }
    return target;
}

function toVoiceConversationSpawnError(spawned: unknown): Error {
    const spawnRecord = spawned && typeof spawned === 'object' && !Array.isArray(spawned)
        ? spawned as Readonly<Record<string, unknown>>
        : {};
    const errorCode = normalizeNonEmptyString(spawnRecord.errorCode);
    const errorMessage = normalizeNonEmptyString(spawnRecord.errorMessage);
    const rawErrorDetail = spawnRecord.errorDetail;
    const errorDetail = isConnectedServiceUxDiagnosticSpawnErrorDetail(rawErrorDetail)
        ? rawErrorDetail
        : null;
    const uxDiagnostic = errorDetail?.uxDiagnostic ?? null;
    const isRetryableCredentialRefresh =
        uxDiagnostic?.code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable
        && uxDiagnostic.retryable === true
        && uxDiagnostic.suggestedActions.includes(CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry);
    const safeMessage = uxDiagnostic?.code ?? errorMessage ?? 'voice_conversation_spawn_failed';
    return Object.assign(
        new Error(safeMessage),
        {
            code: isRetryableCredentialRefresh
                ? 'service_temporarily_unavailable'
                : errorCode ?? 'VOICE_CONVERSATION_SPAWN_FAILED',
            ...(errorDetail ? { errorDetail } : {}),
            ...(spawnRecord.spawnAttemptCustody
                ? { spawnAttemptCustody: spawnRecord.spawnAttemptCustody }
                : {}),
        },
    );
}

function resolveTargetMachineForSpawn(state: any, machineId: string): any {
    return resolveMachineForActiveServerFromState(state, machineId)
        ?? state?.machines?.[machineId]
        ?? null;
}

function assertTargetMachineStructurallyReadyForSpawn(machineId: string): void {
    const state = storage.getState();
    const machine = resolveTargetMachineForSpawn(state, machineId);
    if (canAttemptMachineSpawn({ selectedMachineId: machineId, machine })) return;
    throw Object.assign(
        new Error('Target machine daemon is offline. Start or reconnect the daemon before starting local voice.'),
        { code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' },
    );
}

async function waitForSessionMetadata(sessionId: string, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const metadata = readVoiceSessionOwnerMetadataFromState(storage.getState() as any, sessionId);
        if (metadata) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new VoiceConversationSessionMetadataCommitError(
        sessionId,
        'session_metadata_wait_timed_out',
    );
}

async function resolveSessionRootTarget(sessionId: string): Promise<Readonly<{ machineId: string; directory: string }> | null> {
    const readTarget = () => {
        const resolvedTarget = readMachineTargetForSession(sessionId);
        const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
        const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
        return machineId && directory ? { machineId, directory } : null;
    };

    const existingTarget = readTarget();
    if (existingTarget) return existingTarget;

    await Promise.resolve(sync.ensureSessionVisibleForMessageRoute(sessionId)).catch(() => {});
    return readTarget();
}

let voiceHomeEnsurePromise: Promise<string> | null = null;
let voiceHomeEnsureRequirements: VoiceHomeConversationSessionRequirements | null = null;

async function touchVoiceConversationSessionWithScope(
    sessionId: string,
    scope: VoiceConversationScopeMetadata,
    startupInstructionsMarker?: AgentSessionStartupInstructionsMarkerV1,
): Promise<void> {
    try {
        await publishDisplayTitleMetadataMutation({
            sessionId,
            title: 'Voice conversation (system)',
            updateSessionMetadataWithRetry: (targetSessionId, updater) =>
                sync.patchSessionMetadataWithRetry(targetSessionId, updater),
            resolveTitle: (metadata: Metadata) =>
                typeof metadata?.summary?.text === 'string'
                    ? metadata.summary.text
                    : 'Voice conversation (system)',
            transformAfterTitle: (metadata: Metadata) => {
                const systemMetadata = {
                    ...metadata,
                    ...buildVoiceConversationSystemSessionMetadata(),
                    ...(startupInstructionsMarker
                        ? { voiceAgentStartupInstructionsV1: startupInstructionsMarker }
                        : {}),
                };
                return writeVoiceConversationScopeMetadata(systemMetadata, scope);
            },
        });
    } catch {
        throw new VoiceConversationSessionMetadataCommitError(
            sessionId,
            'metadata_write_rejected',
        );
    }
}

function resolveConversationRetentionLimit(state: any): number {
    const agentCfg = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent;
    const policy = agentCfg?.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
    if (policy === 'single') return 1;
    const raw = Number(agentCfg?.maxWarmRoots ?? 3);
    return Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 3;
}

async function retireVoiceConversationSession(sessionId: string): Promise<void> {
    await sync.patchSessionMetadataWithRetry(sessionId, (metadata: any) => ({
        ...metadata,
        ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY, hidden: true }),
        voiceAgentRunV1: null,
    }));
}

async function failVoiceConversationCustodyCompletion(params: Readonly<{
    sessionId: string;
    message: string;
}>): Promise<never> {
    const failure = new VoiceConversationSessionCustodyCompletionError(
        params.sessionId,
        params.message,
    );
    try {
        await retireVoiceConversationSession(params.sessionId);
    } catch {
        throw attachVoiceConversationRetirementFailure(failure);
    }
    throw failure;
}

async function recoverPendingVoiceConversationCustody(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    failureMessage: string;
}>): Promise<void> {
    const completed = await completePendingMachineSpawnAttemptCustodyForSession({
        sessionId: params.sessionId,
        serverId: params.serverId,
    });
    if (completed === false) {
        await failVoiceConversationCustodyCompletion({
            sessionId: params.sessionId,
            message: params.failureMessage,
        });
    }
}

async function finalizeSpawnedVoiceConversationSession(params: Readonly<{
    sessionId: string;
    scope: VoiceConversationScopeMetadata;
    startupInstructionsMarker?: AgentSessionStartupInstructionsMarkerV1;
}>): Promise<void> {
    try {
        try {
            await sync.refreshSessions();
        } catch {
            throw new VoiceConversationSessionMetadataCommitError(
                params.sessionId,
                'session_refresh_failed',
            );
        }
        await waitForSessionMetadata(params.sessionId, 15_000);
        await touchVoiceConversationSessionWithScope(
            params.sessionId,
            params.scope,
            params.startupInstructionsMarker,
        );
    } catch (cause) {
        const primaryFailure =
            cause instanceof VoiceConversationSessionMetadataCommitError
                ? cause
                : new VoiceConversationSessionMetadataCommitError(
                    params.sessionId,
                    'unknown',
                );
        try {
            await retireVoiceConversationSession(params.sessionId);
        } catch {
            throw attachVoiceConversationRetirementFailure(primaryFailure);
        }
        throw primaryFailure;
    }
}

async function applyVoiceConversationRetentionPolicy(params: Readonly<{ keepSessionId: string }>): Promise<void> {
    const keepSessionId = normalizeNonEmptyString(params.keepSessionId);
    if (!keepSessionId) return;

    const state: any = storage.getState();
    const limit = resolveConversationRetentionLimit(state);
    if (!Number.isFinite(limit) || limit <= 0) return;

    const sessions = listVoiceConversationSystemSessions(state)
        .filter((candidate) => candidate.sessionId !== keepSessionId)
        .map((candidate) => ({ id: candidate.sessionId, updatedAt: candidate.updatedAt }));

    if (limit === 1) {
        await Promise.all(sessions.map((session) => retireVoiceConversationSession(session.id).catch(() => {})));
        return;
    }

    sessions.sort((left, right) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id));
    const keepCount = Math.max(0, limit - 1);
    const toRetire = sessions.slice(keepCount);
    await Promise.all(toRetire.map((session) => retireVoiceConversationSession(session.id).catch(() => {})));
}

async function retireLegacyVoiceConversationSessions(params: Readonly<{
    machineId: string;
    directory: string;
}>): Promise<void> {
    const machineId = normalizeNonEmptyString(params.machineId);
    const state: any = storage.getState();
    if (!machineId) return;
    const directory = resolveRequiredVoiceSpawnDirectoryIdentity(state, machineId, params.directory);
    const toRetire = listVoiceConversationSystemSessions(state)
        .filter((candidate) =>
            candidate.legacyLinked
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === machineId
            && resolveVoiceSpawnDirectoryIdentity(
                state,
                machineId,
                (candidate.metadata as any)?.path,
            ) === directory,
        )
        .map((candidate) => candidate.sessionId);

    await Promise.all(toRetire.map((sessionId) => retireVoiceConversationSession(sessionId).catch(() => {})));
}

async function findExactVoiceHomeConversationSession(params: Readonly<{
    state: any;
    machineId: string;
    directory: string;
    requirements: ResolvedVoiceHomeConversationSessionRequirements | null;
    startupInstructionsMarker: AgentSessionStartupInstructionsMarkerV1 | null;
}>): Promise<ReturnType<typeof findPreferredVoiceConversationSystemSession>> {
    const directoryIdentity = resolveRequiredVoiceSpawnDirectoryIdentity(
        params.state,
        params.machineId,
        params.directory,
    );
    const candidates = listVoiceConversationSystemSessions(params.state)
        .filter((candidate) =>
            !candidate.legacyLinked
            && candidate.reusable
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === params.machineId
            && resolveVoiceSpawnDirectoryIdentity(
                params.state,
                params.machineId,
                (candidate.metadata as any)?.path,
            )
                === directoryIdentity
            && matchesVoiceConversationScope(candidate.metadata ?? null, { kind: 'voice_home' }),
        )
        .sort((left, right) =>
            (right.updatedAt - left.updatedAt) || left.sessionId.localeCompare(right.sessionId));

    if (!params.requirements) return candidates[0] ?? null;
    if (!params.requirements.coldResumeStartupInstructionsEffective) return null;
    for (const candidate of candidates) {
        const metadata = candidate.metadata as Readonly<Record<string, unknown>> | null;
        if (
            stableJsonStringify(metadata?.voiceAgentStartupInstructionsV1)
            !== stableJsonStringify(params.startupInstructionsMarker)
        ) {
            continue;
        }
        let backendTargetMatches = false;
        try {
            backendTargetMatches = buildBackendTargetKeyV2(
                readBackendTargetRefV2(metadata?.backendTarget as Parameters<typeof readBackendTargetRefV2>[0]),
            ) === buildBackendTargetKeyV2(params.requirements.backendTarget);
        } catch {
            backendTargetMatches = false;
        }
        if (!backendTargetMatches) continue;
        if (
            stableJsonStringify(metadata?.connectedServices)
            !== stableJsonStringify(params.requirements.connectedServices)
        ) {
            continue;
        }
        const permissionIntent =
            readPermissionModeIntentFromMetadata(metadata ?? {})?.permissionMode
            ?? normalizeNonEmptyString(candidate.session?.permissionMode)
            ?? normalizeNonEmptyString(metadata?.permissionMode);
        if (permissionIntent !== params.requirements.permissionIntent) continue;
        if (await params.requirements.isReusableSession({
            sessionId: candidate.sessionId,
            metadata: candidate.metadata,
        })) {
            return candidate;
        }
    }
    return null;
}

async function isReplayedVoiceHomeSpawnReusable(params: Readonly<{
    sessionId: string;
    requirements: ResolvedVoiceHomeConversationSessionRequirements | null;
}>): Promise<boolean> {
    const state = storage.getState();
    const session = state?.sessions?.[params.sessionId];
    if (!isReusableVoiceConversationRuntimeSession(session)) return false;
    if (!params.requirements) return true;

    return await params.requirements.isReusableSession({
        sessionId: params.sessionId,
        metadata: readVoiceSessionOwnerMetadataFromState(state, params.sessionId),
    });
}

function projectionSupportsStartupInstructionsV1(params: Readonly<{
    projectionInputs: Awaited<ReturnType<typeof loadDaemonMergedProjectionInputs>>;
    backendTarget: BackendTargetRefV2;
}>): boolean {
    const projection = params.projectionInputs?.pluginProjectionV2;
    if (!projection) return false;
    const backendId = params.backendTarget.backendId;
    const agentId = projection.backendsById[backendId]?.agentId ?? backendId;
    const versions = projection.agentsById[agentId]?.capabilities
        ?.sessions?.startupInstructions?.versions;
    return versions?.length === 1 && versions[0] === 1;
}

async function buildGlobalVoiceAgentStartupInstructions(
    machineId: string,
    backendTarget: BackendTargetRefV2,
): Promise<AgentSessionStartupInstructionsV1> {
    const projectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        serverId: getActiveServerSnapshot().serverId,
    });
    if (!projectionSupportsStartupInstructionsV1({
        projectionInputs,
        backendTarget,
    })) {
        throw Object.assign(
            new Error('The selected Agent runtime does not support global Voice startup instructions.'),
            { code: 'VOICE_AGENT_STARTUP_INSTRUCTIONS_UNSUPPORTED' },
        );
    }
    const instructions = renderPromptPlanV1(
        buildGlobalVoiceAgentStartupInstructionsPlanV1(),
    ).normalize('NFC');
    return AgentSessionStartupInstructionsV1Schema.parse({
        ...GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER,
        instructions,
    });
}

async function ensureVoiceConversationSessionForVoiceHomeUnguarded(
    requirements: VoiceHomeConversationSessionRequirements | null,
): Promise<string> {
    const target = await waitForVoiceHomeSpawnTarget(VOICE_HOME_SPAWN_TARGET_WAIT_TIMEOUT_MS);
    if (!target) {
        throw Object.assign(new Error('voice_conversation_spawn_target_missing'), { code: 'VOICE_CONVERSATION_TARGET_MISSING' });
    }

    assertTargetMachineStructurallyReadyForSpawn(target.machineId);
    await retireLegacyVoiceConversationSessions(target).catch(() => {});
    const state: any = storage.getState();
    const resolvedRequirements = requirements
        ? await resolveVoiceHomeConversationSessionRequirements(requirements, target.machineId)
        : null;
    const backendTarget = resolvedRequirements?.backendTarget
        ?? await resolveVoiceConversationBackendTarget(state, target.machineId);
    const startupInstructions = resolvedRequirements
        ? await buildGlobalVoiceAgentStartupInstructions(
            target.machineId,
            backendTarget,
        )
        : null;

    const bestExisting = await findExactVoiceHomeConversationSession({
        state,
        machineId: target.machineId,
        directory: target.directory,
        requirements: resolvedRequirements,
        startupInstructionsMarker: startupInstructions
            ? GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER
            : null,
    });

    if (bestExisting) {
        await recoverPendingVoiceConversationCustody({
            sessionId: bestExisting.sessionId,
            serverId: getActiveServerSnapshot().serverId,
            failureMessage: 'Voice home session custody could not be completed',
        });
        persistVoiceAutoTargetMachineId(target.machineId);
        await touchVoiceConversationSessionWithScope(
            bestExisting.sessionId,
            { kind: 'voice_home' },
            startupInstructions
                ? GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER
                : undefined,
        );
        await applyVoiceConversationRetentionPolicy({ keepSessionId: bestExisting.sessionId }).catch(() => {});
        return bestExisting.sessionId;
    }

    const serverId = getActiveServerSnapshot().serverId;
    const spawnOptionsWithoutNonce = {
        machineId: target.machineId,
        directory: target.directory,
        transcriptStorage: 'persisted',
        approvedNewDirectoryCreation: true,
        backendTarget,
        permissionMode: resolvedRequirements?.permissionIntent
            ?? resolveVoiceConversationPermissionIntent(state),
        ...(resolvedRequirements?.connectedServices
            ? { connectedServices: resolvedRequirements.connectedServices }
            : {}),
        serverId,
        userAttemptId: buildVoiceSpawnUserAttemptId({
            surface: 'voice_home',
            serverId,
            machineId: target.machineId,
            directory: resolveRequiredVoiceSpawnDirectoryIdentity(
                state,
                target.machineId,
                target.directory,
            ),
            backendTarget,
            requirements: resolvedRequirements,
        }),
    } as const;

    let requestedSpawnNonce = createUiSessionSpawnNonce();
    let staleCustodyReplayRetries = 0;
    let spawned: Awaited<ReturnType<typeof machineSpawnNewSession>>;
    while (true) {
        const spawnOptions = {
            ...spawnOptionsWithoutNonce,
            spawnNonce: requestedSpawnNonce,
        } as const;
        spawned = startupInstructions
            ? await machineSpawnTrustedHiddenSystemSession(
                spawnOptions,
                startupInstructions,
            )
            : await machineSpawnNewSession(spawnOptions);

        if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
            throw toVoiceConversationSpawnError(spawned);
        }

        const custody = spawned.spawnAttemptCustody;
        const isCustodyReplay = custody?.status === 'completed'
            && custody.spawnNonce !== requestedSpawnNonce;
        if (!isCustodyReplay) break;
        if (await isReplayedVoiceHomeSpawnReusable({
            sessionId: spawned.sessionId,
            requirements: resolvedRequirements,
        })) {
            break;
        }

        const cleared = await completeMachineSpawnAttemptCustody(custody);
        if (!cleared) {
            await failVoiceConversationCustodyCompletion({
                sessionId: spawned.sessionId,
                message: 'Stale Voice home session custody could not be cleared',
            });
        }
        if (staleCustodyReplayRetries >= VOICE_HOME_STALE_CUSTODY_REPLAY_RETRY_LIMIT) {
            await failVoiceConversationCustodyCompletion({
                sessionId: spawned.sessionId,
                message: 'Voice home session custody replay remained unavailable',
            });
        }
        staleCustodyReplayRetries += 1;
        requestedSpawnNonce = createUiSessionSpawnNonce();
    }

    persistVoiceAutoTargetMachineId(target.machineId);
    await finalizeSpawnedVoiceConversationSession({
        sessionId: spawned.sessionId,
        scope: { kind: 'voice_home' },
        ...(startupInstructions
            ? { startupInstructionsMarker: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER }
            : {}),
    });
    await applyVoiceConversationRetentionPolicy({ keepSessionId: spawned.sessionId }).catch(() => {});
    if (spawned.spawnAttemptCustody?.status === 'completed') {
        const completed = await completeMachineSpawnAttemptCustody(spawned.spawnAttemptCustody);
        if (!completed) {
            await failVoiceConversationCustodyCompletion({
                sessionId: spawned.sessionId,
                message: 'Voice home session custody could not be completed',
            });
        }
    }
    return spawned.sessionId;
}

export function ensureVoiceConversationSessionForVoiceHome(
    requirements: VoiceHomeConversationSessionRequirements | null = null,
): Promise<string> {
    if (voiceHomeEnsurePromise) {
        if (voiceHomeEnsureRequirements === requirements || (!voiceHomeEnsureRequirements && !requirements)) {
            return voiceHomeEnsurePromise;
        }
        const current = voiceHomeEnsurePromise;
        return current.then(
            () => ensureVoiceConversationSessionForVoiceHome(requirements),
            () => ensureVoiceConversationSessionForVoiceHome(requirements),
        );
    }

    const pending = ensureVoiceConversationSessionForVoiceHomeUnguarded(requirements);
    voiceHomeEnsurePromise = pending;
    voiceHomeEnsureRequirements = requirements;
    void pending.finally(() => {
        if (voiceHomeEnsurePromise === pending) {
            voiceHomeEnsurePromise = null;
            voiceHomeEnsureRequirements = null;
        }
    }).catch(() => {});

    return pending;
}

export function ensureVoiceConversationSessionId(): Promise<string> {
    return ensureVoiceConversationSessionForVoiceHome();
}

function findSessionRootVoiceConversationSessionId(params: Readonly<{
    state: any;
    sessionId: string;
    machineId: string;
    directory: string;
}>): string | null {
    const directoryIdentity = resolveRequiredVoiceSpawnDirectoryIdentity(
        params.state,
        params.machineId,
        params.directory,
    );
    return findPreferredVoiceConversationSystemSession(
        params.state,
        (candidate) =>
            !candidate.legacyLinked
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === params.machineId
            && resolveVoiceSpawnDirectoryIdentity(
                params.state,
                params.machineId,
                (candidate.metadata as any)?.path,
            )
                === directoryIdentity
            && matchesVoiceConversationScope(candidate.metadata ?? null, { kind: 'session_root', sessionRootId: params.sessionId }),
    )?.sessionId ?? null;
}

export async function ensureVoiceConversationSessionForSessionRoot(params: Readonly<{ sessionId: string }>): Promise<string> {
    const sessionId = normalizeNonEmptyString(params.sessionId);
    if (!sessionId) throw new Error('voice_conversation_session_target_missing');

    const target = await resolveSessionRootTarget(sessionId);
    const machineId = target?.machineId ?? null;
    const directory = target?.directory ?? null;
    if (!machineId || !directory) throw new Error('voice_conversation_session_target_missing');
    assertTargetMachineStructurallyReadyForSpawn(machineId);

    await retireLegacyVoiceConversationSessions({ machineId, directory }).catch(() => {});
    let state: any = storage.getState();
    let existingSessionId = findSessionRootVoiceConversationSessionId({
        state,
        sessionId,
        machineId,
        directory,
    });
    if (!existingSessionId) {
        const refreshed = await sync.refreshSessions({ awaitSessionListHydration: true });
        const refreshedHydrationCandidateSessionIds = (refreshed?.sessionIds ?? []).filter((candidateSessionId) => {
            const renderable = storage.getState().sessionListRenderables?.[candidateSessionId];
            // Encrypted rows can be listed before their metadata hydration finishes. They
            // are possible hidden Voice sessions until exact hydration proves otherwise.
            return !renderable
                || renderable.metadata == null
                || renderable.metadata.hiddenSystemSession === true
                || renderable.metadataUnavailable === true;
        });
        await Promise.all(refreshedHydrationCandidateSessionIds.map((candidateSessionId) => (
            sync.ensureSessionVisibleForMessageRoute(candidateSessionId).catch(() => undefined)
        )));
        state = storage.getState();
        existingSessionId = findSessionRootVoiceConversationSessionId({
            state,
            sessionId,
            machineId,
            directory,
        });
    }

    if (existingSessionId) {
        await recoverPendingVoiceConversationCustody({
            sessionId: existingSessionId,
            serverId: getActiveServerSnapshot().serverId,
            failureMessage: 'Voice conversation custody could not be completed',
        });
        await touchVoiceConversationSessionWithScope(existingSessionId, { kind: 'session_root', sessionRootId: sessionId });
        await applyVoiceConversationRetentionPolicy({ keepSessionId: existingSessionId }).catch(() => {});
        return existingSessionId;
    }

    const backendTarget = await resolveVoiceConversationBackendTarget(state, machineId);
    const serverId = getActiveServerSnapshot().serverId;
    const spawnNonce = createUiSessionSpawnNonce();
    const spawned = await machineSpawnNewSession({
        machineId,
        directory,
        transcriptStorage: 'persisted',
        backendTarget,
        permissionMode: resolveVoiceConversationPermissionIntent(state),
        serverId,
        spawnNonce,
        userAttemptId: buildVoiceSpawnUserAttemptId({
            surface: 'voice_session_root',
            serverId,
            machineId,
            directory: resolveRequiredVoiceSpawnDirectoryIdentity(state, machineId, directory),
            backendTarget,
            sessionId,
        }),
    });

    if (!spawned || spawned.type !== 'success' || typeof spawned.sessionId !== 'string') {
        throw toVoiceConversationSpawnError(spawned);
    }

    await finalizeSpawnedVoiceConversationSession({
        sessionId: spawned.sessionId,
        scope: { kind: 'session_root', sessionRootId: sessionId },
    });
    await applyVoiceConversationRetentionPolicy({ keepSessionId: spawned.sessionId }).catch(() => {});
    if (spawned.spawnAttemptCustody?.status === 'completed') {
        const completed = await completeMachineSpawnAttemptCustody(spawned.spawnAttemptCustody);
        if (!completed) {
            await failVoiceConversationCustodyCompletion({
                sessionId: spawned.sessionId,
                message: 'Voice conversation custody could not be completed',
            });
        }
    }

    return spawned.sessionId;
}
