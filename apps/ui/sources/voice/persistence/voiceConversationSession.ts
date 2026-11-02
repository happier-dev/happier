
import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { AgentSessionStartupInstructionsV1Schema, type AgentSessionStartupInstructionsV1, type AgentSessionStartupInstructionsMarkerV1 } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { isConnectedServiceUxDiagnosticSpawnErrorDetail, SessionSpawnLaunchErrorV1Schema } from '@happier-dev/protocol/spawnSession';
import { renderPromptPlanV1 } from '@happier-dev/protocol/prompts/promptPlanV1';
import { ConnectedServiceBindingsV2IngressSchema, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import {
    readPermissionModeIntentFromMetadata,
    buildGlobalVoiceAgentStartupInstructionsPlanV1,
    GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_ID,
    GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_REVISION,
    type PermissionIntent,
} from '@happier-dev/agents';

import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createAbortRacer } from '@/voice/agent/voiceAgentAbort';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import { resolveVoiceConfiguredAgentTarget } from '@/voice/agent/resolveVoiceConfiguredAgentTarget';
import { canAttemptMachineSpawn, resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import type { Metadata } from '@happier-dev/session-core/state';
import {
    completePendingMachineSpawnAttemptCustodyForSession,
} from '@/sync/ops/machines';
import { executeSessionSpawnNewAction } from '@/sync/ops/actions/sessionSpawnNewAction';
import { resumeSession, sessionUnarchiveWithServerScope } from '@/sync/ops/sessions';
import { resolveSpawnAttemptDirectoryIdentity } from '@/sync/domains/session/spawn/spawnAttemptKey';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { resolveMachineForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { sync } from '@/sync/sync';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceExecutionMachineIdFromState, resolveVoiceExecutionMachineSelectionFromState } from '@/voice/settings/executionMachine';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { buildVoiceSpawnUserAttemptId } from '@/voice/shared/voiceSpawnAttempt';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { resolveVoiceSessionModelSelection } from '@/voice/agent/resolveVoiceSessionModelSelection';
import { readSafeVoiceRuntimeFailureCode } from '@/voice/runtime/voiceRuntimeFailureCode';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readAdmittedConnectedAccountCatalogInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { resolveAgentConnectedServicesDefaultBindings } from '@/sync/domains/connectedServices/resolveAgentConnectedServicesDefaultBindings';

import {
    matchesVoiceConversationScope,
    writeVoiceConversationScopeMetadata,
    type VoiceConversationScopeMetadata,
} from './voiceConversationScopeMetadata';
import { persistVoiceAutoTargetMachineId, readVoiceAutoTargetMachineId } from './voiceAutoTargetMachineSettings';
import {
    findPreferredVoiceConversationSystemSession,
    findReusableVoiceConversationRuntimeSessionId,
    isReusableVoiceConversationRuntimeSession,
    listVoiceConversationSystemSessions,
    isVoiceConversationSystemSessionMetadata,
    shouldRetireLegacyVoiceConversationSession,
    VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

export {
    findReusableVoiceConversationRuntimeSessionId,
    findVoiceConversationSessionId,
    isVoiceConversationSystemSessionMetadata,
    VOICE_CONVERSATION_SYSTEM_SESSION_KEY,
} from './voiceConversationSystemSessionLookup';

const VOICE_CONVERSATION_METADATA_COMMIT_FAILED =
    'VOICE_CONVERSATION_METADATA_COMMIT_FAILED';
const VOICE_CONVERSATION_CUSTODY_COMPLETION_FAILED =
    'VOICE_CONVERSATION_CUSTODY_COMPLETION_FAILED';
const VOICE_CONVERSATION_RETIREMENT_FAILED =
    'VOICE_CONVERSATION_RETIREMENT_FAILED';

/**
 * Structural discriminator for the finalization step that failed. Callers and
 * logs need the distinct reason. The underlying cause stays non-enumerable for
 * local diagnosis; public failure projections expose only the typed code/reason.
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

    constructor(sessionId: string, reason: VoiceConversationSessionMetadataCommitReason, cause?: unknown) {
        super('Voice conversation session metadata could not be committed', { cause });
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
    connectedServices?: ConnectedServiceBindingsV2;
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

    for (const recent of state?.authoringMemory?.recentMachinePaths ?? []) {
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
    for (const recent of state?.authoringMemory?.recentMachinePaths ?? []) {
        if (normalizeNonEmptyString(recent?.machineId) !== normalizedMachineId) continue;
        const recentDirectory = normalizeNonEmptyString(recent?.path);
        if (recentDirectory) return recentDirectory;
    }
    return null;
}

function resolveRecentVoiceDirectoryForRouteMachine(state: any, routeMachineId: string | null | undefined): string | null {
    const normalizedRouteMachineId = normalizeNonEmptyString(routeMachineId);
    if (!normalizedRouteMachineId) return null;
    for (const recent of state?.authoringMemory?.recentMachinePaths ?? []) {
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
        : readVoiceAutoTargetMachineId(canonicalState);
    const directory =
        resolveVoiceHomeDirectory(canonicalState, machineId)
        ?? resolveRecentVoiceDirectoryForMachine(canonicalState, configuredOriginId)
        ?? resolveRecentVoiceDirectoryForRouteMachine(canonicalState, machineId);
    return directory ? { machineId, directory } : null;
}

export function resolveVoiceHomeDaemonMachineId(state: any = storage.getState()): string | null {
    return resolveVoiceExecutionMachineIdFromState(withCanonicalVoiceSettings(state));
}

async function resolveVoiceConversationBackendTarget(state: any, machineId: string, signal?: AbortSignal): Promise<BackendTargetRefV2> {
    const settings = state?.settings ?? {};
    const agentCfg = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent;
    const agentSource = normalizeNonEmptyString(agentCfg?.agentSource) ?? 'session';
    const requestedAgentId = normalizeNonEmptyString(agentCfg?.agentId);

    // An explicitly configured voice Agent is the user's selection, bundled or
    // externally installed. The exact persisted selection facts resolve against
    // the current catalog and fail closed when the selection is no longer
    // supported; selections written before exact facts existed keep resolving
    // through their raw id.
    if (agentSource === 'agent' && requestedAgentId) {
        const resolved = await resolveVoiceConfiguredAgentTarget({
            machineId,
            signal,
            accountScope: state?.settingsScope ?? null,
            selection: {
                agentId: requestedAgentId,
                agentTargetKey: agentCfg?.agentTargetKey ?? null,
                agentIdentity: agentCfg?.agentIdentity ?? null,
            },
        });
        if (!resolved.ok) {
            throw Object.assign(
                new Error('The configured Voice Agent is no longer available. Re-select it in Voice settings.'),
                { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' },
            );
        }
        return resolved.backendTarget;
    }

    const scope = state?.settingsScope;
    const lifetime = captureActiveServerAccountScopeLifetime();
    const unavailable = () => Object.assign(new Error('The Voice Agent catalog is unavailable.'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    if (!scope || !lifetime || !areAccountSettingsScopesEqual(scope, lifetime.scope)) throw unavailable();
    const snapshot = getAcpCatalogSnapshot(scope);
    if (snapshot?.catalog.status !== 'ready' || snapshot.stale) await refreshAcpCatalog(scope);
    if (!lifetime.isCurrent()) throw unavailable();
    const daemonMergedProjectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        signal,
        serverId: scope.serverId,
    });
    const catalog = getAcpCatalogSnapshot(scope)?.catalog;
    if (!lifetime.isCurrent() || catalog?.status !== 'ready') throw unavailable();
    const preferredTarget = resolvePreferredBackendTargetFromProjection({
        lastUsedAgent: settings.lastUsedAgent,
        lastUsedBackendTarget: settings.lastUsedBackendTarget,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
        acpCatalogSnapshot: catalog,
        daemonMergedProjectionInputs,
    });
    return resolveOperationalBackendTargetForAgentSelection({
        backendTarget: preferredTarget,
        mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById,
    }) ?? {
        kind: 'backend',
        backendId: preferredTarget.kind === 'agent'
            ? buildQualifiedPluginContributionKey(preferredTarget.identity)
            : preferredTarget.backendId,
    };
}

async function resolveVoiceConversationAgentTarget(
    machineId: string,
    backendTarget: PersistedBackendTargetRefV2,
    serverId: string,
    accountLifetime?: ActiveServerAccountScopeLifetime,
    signal?: AbortSignal,
) {
    const projectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        serverId,
        signal,
    });
    if (accountLifetime) assertVoiceConversationAccountCurrent(accountLifetime);
    const agentTarget = resolveAgentExecutionTargetForBackendTarget({
        backendTarget,
        daemonMergedProjectionInputs: projectionInputs,
    });
    if (!agentTarget) {
        throw Object.assign(
            new Error('The selected Voice Agent cannot be represented by the canonical Session creation contract.'),
            { code: 'VOICE_AGENT_BACKEND_TARGET_UNAVAILABLE' },
        );
    }
    return agentTarget;
}

/** Capture the same Account-purpose choice New Session uses before deriving carrier identity. */
async function resolveVoiceConversationDefaultBindings(params: Readonly<{
    machineId: string;
    backendTarget: PersistedBackendTargetRefV2;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
}>): Promise<ConnectedServiceBindingsV2 | undefined> {
    const projection = await loadDaemonMergedProjectionInputs({ machineId: params.machineId,
        serverId: params.accountLifetime.scope.serverId, signal: params.signal });
    assertVoiceConversationAccountCurrent(params.accountLifetime);
    const operationalTarget = resolveOperationalBackendTargetForAgentSelection({
        backendTarget: params.backendTarget,
        mergedProviderProjectionById: projection?.mergedProviderProjectionById,
    });
    if (!operationalTarget) {
        throw Object.assign(new Error('voice_agent_selection_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
    const agentId = projection?.mergedBackendProjectionById[operationalTarget.backendId]?.agentId
        ?? operationalTarget.backendId;
    const agent = resolveAgentCatalogProjection(agentId, {
        enabledAgentIds: [],
        mergedProviderProjectionById: projection?.mergedProviderProjectionById,
        mergedBackendProjectionById: projection?.mergedBackendProjectionById,
    });
    if (!agent.identity || agent.connectedAccounts.length === 0) return undefined;
    const account = await captureLazyActionAccountContext(params.accountLifetime.scope.serverId, params.signal);
    try {
        if (account.accountId !== params.accountLifetime.scope.accountId) {
            throw Object.assign(new Error('voice_agent_selection_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
        }
        const catalog = await readAdmittedConnectedAccountCatalogInContext(account, 'purposes', params.signal);
        assertVoiceConversationAccountCurrent(params.accountLifetime);
        if (catalog.status !== 'ready' || catalog.record.key !== 'purposes') {
            throw Object.assign(new Error('connected_account_purpose_catalog_unavailable'), {
                code: 'connected_account_purpose_catalog_unavailable',
            });
        }
        return resolveAgentConnectedServicesDefaultBindings({ settings: storage.getState().settings,
            purposeBindings: catalog.record.value, agentId, consumer: agent.identity,
            declarations: agent.connectedAccounts });
    } finally {
        account.dispose();
    }
}

function assertVoiceConversationAccountCurrent(lifetime: ActiveServerAccountScopeLifetime): void {
    if (lifetime.isCurrent() && areAccountSettingsScopesEqual(lifetime.scope, storage.getState().settingsScope)) return;
    throw Object.assign(new Error('The Voice Agent Account is no longer current.'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
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
    signal?: AbortSignal;
}>): Promise<BackendTargetRefV2 | null> {
    const machineId = normalizeNonEmptyString(input.machineId);
    if (machineId) {
        const projectionInputs = await loadDaemonMergedProjectionInputs({
            machineId,
            serverId: getActiveServerSnapshot().serverId,
            signal: input.signal,
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
                if (bundledAgentId === agentId) {
                    return { kind: 'backend', backendId: bundledAgentId };
                }
                return {
                    kind: 'backend',
                    backendId: buildQualifiedPluginContributionKey(input.agent),
                };
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
    signal?: AbortSignal,
): Promise<ResolvedVoiceHomeConversationSessionRequirements> {
    let backendTarget = requirements.backendTarget ?? null;
    if (!backendTarget && requirements.agentIdentity) {
        backendTarget = await resolveQualifiedAgentBackendTargetForMachine({
            machineId,
            agent: requirements.agentIdentity,
            signal,
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

function toVoiceConversationSpawnError(spawned: unknown): Error {
    const spawnRecord = spawned && typeof spawned === 'object' && !Array.isArray(spawned)
        ? spawned as Readonly<Record<string, unknown>>
        : {};
    const launchError = SessionSpawnLaunchErrorV1Schema.safeParse(spawnRecord.errorDetail);
    const launchErrorCode = launchError.success ? launchError.data.code : null;
    const errorCode = launchErrorCode ?? readSafeVoiceRuntimeFailureCode(spawned) ?? normalizeNonEmptyString(spawnRecord.errorCode);
    const errorMessage = normalizeNonEmptyString(spawnRecord.errorMessage);
    const rawErrorDetail = spawnRecord.errorDetail;
    const errorDetail = isConnectedServiceUxDiagnosticSpawnErrorDetail(rawErrorDetail)
        ? rawErrorDetail
        : null;
    const uxDiagnostic = errorDetail?.uxDiagnostic ?? (launchError.success ? launchError.data.uxDiagnostic : null);
    const isRetryableProviderFailure = spawnRecord.retryableProviderFailure === true;
    const safeMessage = isRetryableProviderFailure
        ? 'service_temporarily_unavailable'
        : uxDiagnostic?.code ?? launchErrorCode ?? errorMessage ?? 'voice_conversation_spawn_failed';
    return Object.assign(
        new Error(safeMessage),
        {
            code: isRetryableProviderFailure
                ? 'service_temporarily_unavailable'
                : errorCode ?? 'VOICE_CONVERSATION_SPAWN_FAILED',
            ...(errorDetail ? { errorDetail } : {}),
            ...(uxDiagnostic ? { uxDiagnostic } : {}),
            ...(spawnRecord.spawnAttemptCustody
                ? { spawnAttemptCustody: spawnRecord.spawnAttemptCustody }
                : {}),
        },
    );
}

async function spawnVoiceConversationSession(params: Readonly<{
    machineId: string;
    serverId: string;
    directory: string;
    backendTarget: PersistedBackendTargetRefV2;
    permissionMode: PermissionIntent;
    creationKey: ReturnType<typeof buildVoiceSpawnUserAttemptId>;
    connectedServices?: ConnectedServiceBindingsV2;
    modelSelection?: SessionModelSelectionV1;
    startupInstructions?: AgentSessionStartupInstructionsV1;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
}>): Promise<Readonly<{ sessionId: string; disposition: 'created' | 'rejoined' }>> {
    const agentTarget = await resolveVoiceConversationAgentTarget(
        params.machineId,
        params.backendTarget,
        params.serverId,
        params.accountLifetime,
        params.signal,
    );
    params.signal?.throwIfAborted();
    const action = await executeSessionSpawnNewAction({
        creationKey: params.creationKey,
        executionTarget: {
            serverId: params.serverId,
            machineId: params.machineId,
        },
        directory: { kind: 'path', path: params.directory },
        agentTarget,
        permissionMode: params.permissionMode,
        transcriptStorage: 'persisted',
        ...(params.modelSelection !== undefined ? { modelSelection: params.modelSelection } : {}),
        ...(params.connectedServices
            ? { connectedServices: params.connectedServices }
            : {}),
        ...(params.startupInstructions
            ? { agentSessionStartupInstructionsV1: params.startupInstructions }
            : {}),
    }, {
        // This prepares the carrier for the host-admitted conversation. Model
        // tools keep the automation-owned Voice Action surface separately.
        surface: 'ui',
        serverId: params.serverId,
        ...(params.accountLifetime ? { expectedAccountId: params.accountLifetime.scope.accountId } : {}),
        actionRequestId: params.creationKey,
        signal: params.signal,
    });
    if (!action.ok) {
        throw toVoiceConversationSpawnError({
            errorCode: action.errorCode,
            errorMessage: action.errorCode,
        });
    }
    if (action.result.type !== 'success') {
        // The strict Action result already carries the launch owner's typed
        // cause. Keep its code without exposing diagnostic prose to Voice.
        const launchErrorCode = 'launchError' in action.result ? action.result.launchError?.code : undefined;
        throw toVoiceConversationSpawnError(action.result.type === 'error'
            ? {
                errorCode: launchErrorCode ?? action.result.code,
                errorMessage: launchErrorCode ?? action.result.code,
                errorDetail: 'launchError' in action.result ? action.result.launchError : undefined,
                retryableProviderFailure:
                    'providerError' in action.result
                    && action.result.providerError?.retryable === true
                    && action.result.providerError.action === 'retry',
            }
            : {
                errorCode: 'VOICE_CONVERSATION_SPAWN_PENDING',
                errorMessage: 'voice_conversation_spawn_pending',
            });
    }
    return action.result;
}

function resolveTargetMachineForSpawn(state: any, machineId: string): any {
    return resolveMachineForActiveServerFromState(state, machineId)
        ?? state?.machines?.[machineId]
        ?? null;
}

function assertTargetMachineStructurallyReadyForSpawn(machineId: string, accountLifetime = captureActiveServerAccountScopeLifetime()): void {
    const state = storage.getState();
    const machine = resolveTargetMachineForSpawn(state, machineId);
    const target = { selectedMachineId: machineId, machine, scope: accountLifetime?.isCurrent() ? accountLifetime.scope : null };
    if (canAttemptMachineSpawn(target)) return;
    const readiness = resolveMachineSpawnReadiness(target);
    if (readiness.status === 'unknown') {
        throw Object.assign(new Error('Target machine presence has not been observed since reconnect.'),
            { code: 'VOICE_AGENT_TARGET_MACHINE_UNOBSERVED' });
    }
    if (readiness.status === 'keyUnavailable') {
        throw Object.assign(
            new Error('Target machine is locked because secure access is unavailable.'),
            { code: 'VOICE_AGENT_TARGET_MACHINE_KEY_UNAVAILABLE' },
        );
    }
    throw Object.assign(
        new Error('Target machine daemon is offline. Start or reconnect the daemon before starting local voice.'),
        { code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' },
    );
}

async function waitForSessionMetadata(address: SessionAddress, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const metadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), address);
        if (metadata) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new VoiceConversationSessionMetadataCommitError(
        address.sessionId,
        'session_metadata_wait_timed_out',
    );
}

async function resolveSessionRootTarget(
    rootAddress: SessionAddress,
): Promise<Readonly<{ machineId: string; directory: string }> | null> {
    // Callers reach here only for a Home this runtime has mounted, so the Home-local id
    // addresses exactly one Session in the machine-target owner's state.
    const readTarget = () => {
        const resolvedTarget = readMachineTargetForSession(rootAddress.sessionId);
        const machineId = normalizeNonEmptyString(resolvedTarget?.machineId);
        const directory = normalizeNonEmptyString(resolvedTarget?.basePath);
        return machineId && directory ? { machineId, directory } : null;
    };

    const existingTarget = readTarget();
    if (existingTarget) return existingTarget;

    await Promise.resolve(sync.ensureSessionVisibleForMessageRoute(rootAddress.sessionId, {
        serverId: rootAddress.serverId,
    })).catch(() => {});
    return readTarget();
}

let voiceHomeEnsurePromise: Promise<string> | null = null;
let voiceHomeEnsureRequirements: VoiceHomeConversationSessionRequirements | null = null;
let voiceHomeEnsureController: AbortController | null = null;
const voiceHomeEnsureReaders = new Set<symbol>();

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
    } catch (cause) {
        throw new VoiceConversationSessionMetadataCommitError(
            sessionId,
            'metadata_write_rejected',
            cause,
        );
    }
}

function resolveConversationRetentionLimit(state: any): number {
    const agentCfg = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent;
    const policy = agentCfg?.rootSessionPolicy === 'keep_warm' ? 'keep_warm' : 'single';
    if (policy === 'single') return 1;
    const raw = Number(agentCfg?.maxWarmRoots ?? 3);
    return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 3;
}

async function retireVoiceConversationSession(sessionId: string): Promise<void> {
    await sync.patchSessionMetadataWithRetry(sessionId, (metadata) => {
        const nextMetadata = {
            ...metadata,
            ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_RETIRED_SYSTEM_SESSION_KEY, hidden: true }),
        };
        Reflect.deleteProperty(nextMetadata, 'voiceAgentRunV1');
        return nextMetadata;
    });
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
    accountLifetime?: ActiveServerAccountScopeLifetime;
}>): Promise<void> {
    const completed = await completePendingMachineSpawnAttemptCustodyForSession({
        sessionId: params.sessionId,
        serverId: params.serverId,
    });
    if (params.accountLifetime) assertVoiceConversationAccountCurrent(params.accountLifetime);
    if (completed === false) {
        await failVoiceConversationCustodyCompletion({
            sessionId: params.sessionId,
            message: params.failureMessage,
        });
    }
}

async function ensureVoiceConversationRuntime(params: Readonly<{
    sessionId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal?: AbortSignal;
}>): Promise<void> {
    assertVoiceConversationAccountCurrent(params.accountLifetime);
    const serverId = params.accountLifetime.scope.serverId;
    const metadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), {
        serverId, sessionId: params.sessionId,
    });
    const machineId = normalizeNonEmptyString(metadata?.machineId);
    const directory = normalizeNonEmptyString(metadata?.path);
    const backend = resolveSessionActionDefaultBackend({ session: { metadata } });
    const backendTarget = resolveSessionActionDefaultTarget(backend);
    if (!machineId || !directory || !backendTarget) {
        throw Object.assign(new Error('voice_agent_selection_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
    const agentTarget = await resolveVoiceConversationAgentTarget(
        machineId, backendTarget, serverId, params.accountLifetime, params.signal,
    );
    // A retained transcript or active projection does not prove RPC liveness.
    // The daemon's existing resume owner adopts a serviceable runner or starts
    // the same Session, retaining its Agent/account and native resume identity.
    const resumed = await resumeSession({
        sessionId: params.sessionId, serverId, machineId, directory, agentTarget,
        // Carrier preparation belongs to the host-admitted person's Voice
        // Start, just like fresh creation above. Automatic wake keeps its
        // separate shared Resume admission and cannot consume a person's hold.
        executionAuthority: 'present_user',
        accountLifetime: params.accountLifetime, waitForReady: true,
        signal: params.signal,
    });
    assertVoiceConversationAccountCurrent(params.accountLifetime);
    if (resumed.type !== 'success' || resumed.sessionId !== params.sessionId) {
        const failure = toVoiceConversationSpawnError(resumed.type === 'error'
            ? { ...resumed, errorMessage: resumed.errorCode }
            : { errorCode: 'VOICE_CONVERSATION_SPAWN_PENDING', errorMessage: 'voice_conversation_spawn_pending' });
        // Keep the Resume owner's diagnostic without projecting private prose
        // into Voice recovery, logs or serialized public failure state.
        if (resumed.type === 'error') Object.defineProperty(failure, 'cause', { value: resumed, enumerable: false });
        throw failure;
    }
}

async function finalizeSpawnedVoiceConversationSession(params: Readonly<{
    sessionId: string;
    scope: VoiceConversationScopeMetadata;
    startupInstructionsMarker?: AgentSessionStartupInstructionsMarkerV1;
    accountLifetime: ActiveServerAccountScopeLifetime;
}>): Promise<void> {
    const address = { serverId: params.accountLifetime.scope.serverId, sessionId: params.sessionId };
    try {
        try {
            await sync.refreshSessions();
            assertVoiceConversationAccountCurrent(params.accountLifetime);
            // A list refresh can publish a layout-1 shell without its private
            // owner view. Demand that exact Session through Sync's by-ID owner
            // before waiting for the metadata the finalization write needs.
            if (!readVoiceSessionOwnerMetadataFromState(storage.getState(), address)) {
                await sync.ensureSessionVisibleForMessageRoute(params.sessionId, {
                    serverId: address.serverId,
                    hydrateMessages: false,
                    scopeCurrentness: params.accountLifetime.isCurrent,
                });
            }
        } catch (cause) {
            throw new VoiceConversationSessionMetadataCommitError(
                params.sessionId,
                'session_refresh_failed',
                cause,
            );
        }
        if (params.accountLifetime) assertVoiceConversationAccountCurrent(params.accountLifetime);
        await waitForSessionMetadata(address, 15_000);
        if (params.accountLifetime) assertVoiceConversationAccountCurrent(params.accountLifetime);
        await touchVoiceConversationSessionWithScope(
            params.sessionId,
            params.scope,
            params.startupInstructionsMarker,
        );
    } catch (cause) {
        if (params.accountLifetime) assertVoiceConversationAccountCurrent(params.accountLifetime);
        const primaryFailure =
            cause instanceof VoiceConversationSessionMetadataCommitError
                ? cause
                : new VoiceConversationSessionMetadataCommitError(
                    params.sessionId,
                    'unknown',
                    cause,
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
    fixedSelection?: Readonly<{
        backendTarget: PersistedBackendTargetRefV2;
        connectedServices?: ConnectedServiceBindingsV2;
        permissionMode: PermissionIntent;
    }>;
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
            && candidate.session.archivedAt == null
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

    if (!params.requirements) return candidates.find(candidate => !params.fixedSelection
        || matchesVoiceConversationExecutionSelection({ state: params.state, sessionId: candidate.sessionId,
            ...params.fixedSelection })) ?? null;
    if (!params.requirements.coldResumeStartupInstructionsEffective) return null;
    for (const candidate of candidates) {
        const metadata = candidate.metadata as Readonly<Record<string, unknown>> | null;
        if (
            stableJsonStringify(metadata?.voiceAgentStartupInstructionsV1)
            !== stableJsonStringify(params.startupInstructionsMarker)
        ) {
            continue;
        }
        if (!matchesVoiceConversationExecutionSelection({ state: params.state, sessionId: candidate.sessionId,
            backendTarget: params.requirements.backendTarget, connectedServices: params.requirements.connectedServices })) continue;
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

function projectionSupportsStartupInstructionsV1(params: Readonly<{
    projectionInputs: Awaited<ReturnType<typeof loadDaemonMergedProjectionInputs>>;
    backendTarget: BackendTargetRefV2;
}>): boolean {
    const projection = params.projectionInputs?.pluginProjectionV2;
    if (!projection) return false;
    const versions = projection.agentsById[params.backendTarget.backendId]?.capabilities
        ?.sessions?.startupInstructions?.versions;
    return versions?.length === 1 && versions[0] === 1;
}

async function buildGlobalVoiceAgentStartupInstructions(
    machineId: string,
    backendTarget: BackendTargetRefV2,
    serverId: string,
    signal?: AbortSignal,
): Promise<AgentSessionStartupInstructionsV1> {
    const projectionInputs = await loadDaemonMergedProjectionInputs({
        machineId,
        serverId,
        signal,
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
    signal: AbortSignal,
): Promise<string> {
    const expectedSettingsScope = storage.getState().settingsScope;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime || !areAccountSettingsScopesEqual(expectedSettingsScope, accountLifetime.scope)) {
        throw Object.assign(new Error('The Voice Agent Account is unavailable.'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
    assertVoiceConversationAccountCurrent(accountLifetime);
    // Start consumes the current prerequisite, rather than polling a missing
    // target while presenting an active connection attempt. Selection already
    // distinguishes an unobserved Machine from an unavailable one.
    const target = resolveVoiceHomeSpawnTarget(storage.getState());
    assertVoiceConversationAccountCurrent(accountLifetime);
    if (!target) {
        const selection = resolveVoiceExecutionMachineSelectionFromState(withCanonicalVoiceSettings(storage.getState()));
        if (selection.kind === 'selected_unknown' || selection.kind === 'selected_unreachable') {
            throw Object.assign(new Error('voice_execution_machine_unavailable'), {
                code: selection.kind === 'selected_unknown'
                    ? 'VOICE_AGENT_TARGET_MACHINE_UNOBSERVED' : 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
            });
        }
        throw Object.assign(new Error('voice_conversation_spawn_target_missing'), { code: 'VOICE_CONVERSATION_TARGET_MISSING' });
    }

    // Bind persistence to the Account that selected this exact target before
    // any retirement, requirement resolution, recovery, or spawn await.
    const state: any = storage.getState();
    assertTargetMachineStructurallyReadyForSpawn(target.machineId, accountLifetime);
    await retireLegacyVoiceConversationSessions(target).catch(() => {});
    assertVoiceConversationAccountCurrent(accountLifetime);
    const resolvedRequirements = requirements
        ? await resolveVoiceHomeConversationSessionRequirements(requirements, target.machineId, signal)
        : null;
    const backendTarget = resolvedRequirements?.backendTarget
        ?? await resolveVoiceConversationBackendTarget(state, target.machineId, signal);
    const permissionMode = resolvedRequirements?.permissionIntent ?? resolveVoiceConversationPermissionIntent(state);
    const fixedAgent = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent.agentSource === 'agent';
    let connectedServices = resolvedRequirements?.connectedServices;
    if (!resolvedRequirements && fixedAgent) {
        connectedServices = await resolveVoiceConversationDefaultBindings({ machineId: target.machineId,
            backendTarget, accountLifetime, signal });
    }
    signal.throwIfAborted();
    assertVoiceConversationAccountCurrent(accountLifetime);
    const startupInstructions = resolvedRequirements
        ? await buildGlobalVoiceAgentStartupInstructions(
            target.machineId,
            backendTarget,
            accountLifetime.scope.serverId,
            signal,
        )
        : null;
    assertVoiceConversationAccountCurrent(accountLifetime);

    signal.throwIfAborted();

    const bestExisting = await findExactVoiceHomeConversationSession({
        state,
        machineId: target.machineId,
        directory: target.directory,
        requirements: resolvedRequirements,
        startupInstructionsMarker: startupInstructions
            ? GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER
            : null,
        ...(!resolvedRequirements && fixedAgent ? { fixedSelection: { backendTarget, connectedServices, permissionMode } } : {}),
    });

    assertVoiceConversationAccountCurrent(accountLifetime);

    if (bestExisting) {
        await recoverPendingVoiceConversationCustody({
            sessionId: bestExisting.sessionId,
            serverId: accountLifetime.scope.serverId,
            accountLifetime,
            failureMessage: 'Voice home session custody could not be completed',
        });
        await ensureVoiceConversationRuntime({ sessionId: bestExisting.sessionId, accountLifetime, signal });
        assertVoiceConversationAccountCurrent(accountLifetime);
        persistVoiceAutoTargetMachineId(target.machineId, expectedSettingsScope);
        await touchVoiceConversationSessionWithScope(
            bestExisting.sessionId,
            { kind: 'voice_home' },
            startupInstructions
                ? GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER
                : undefined,
        );
        assertVoiceConversationAccountCurrent(accountLifetime);
        await applyVoiceConversationRetentionPolicy({ keepSessionId: bestExisting.sessionId }).catch(() => {});
        return bestExisting.sessionId;
    }

    if (!resolvedRequirements && !fixedAgent) {
        connectedServices = await resolveVoiceConversationDefaultBindings({ machineId: target.machineId,
            backendTarget, accountLifetime, signal });
    }
    const serverId = accountLifetime.scope.serverId;
    const creationKey = buildVoiceSpawnUserAttemptId({
            surface: 'voice_home',
            serverId,
            machineId: target.machineId,
            directory: resolveRequiredVoiceSpawnDirectoryIdentity(
                state,
                target.machineId,
                target.directory,
            ),
            backendTarget,
            connectedServices,
            permissionMode,
            requirements: resolvedRequirements,
        });
    const spawned = await spawnVoiceConversationSession({
        machineId: target.machineId,
        serverId,
        accountLifetime,
        signal,
        directory: target.directory,
        backendTarget,
        permissionMode,
        creationKey,
        ...(connectedServices
            ? { connectedServices }
            : {}),
        ...(startupInstructions ? { startupInstructions } : {}),
    });
    const spawnedSessionId = spawned.sessionId;

    assertVoiceConversationAccountCurrent(accountLifetime);
    if (spawned.disposition === 'rejoined' && resolvedRequirements
        && !resolvedRequirements.coldResumeStartupInstructionsEffective) {
        // The same cold-resume prerequisite applies whether discovery finds
        // the carrier or deterministic creation rejoins it.
        throw Object.assign(new Error('voice_agent_startup_instructions_unsupported'), {
            code: 'VOICE_AGENT_STARTUP_INSTRUCTIONS_UNSUPPORTED',
        });
    }
    persistVoiceAutoTargetMachineId(target.machineId, expectedSettingsScope);
    await finalizeSpawnedVoiceConversationSession({
        sessionId: spawnedSessionId,
        scope: { kind: 'voice_home' },
        accountLifetime,
        ...(startupInstructions
            ? { startupInstructionsMarker: GLOBAL_VOICE_AGENT_STARTUP_INSTRUCTIONS_MARKER }
            : {}),
    });
    assertVoiceConversationAccountCurrent(accountLifetime);
    // Tag rejoin restores the Session and authenticates its recipe. A previously
    // stopped runner still needs the canonical Resume owner before media opens.
    if (spawned.disposition === 'rejoined') {
        await ensureVoiceConversationRuntime({ sessionId: spawnedSessionId, accountLifetime, signal });
    }
    await applyVoiceConversationRetentionPolicy({ keepSessionId: spawnedSessionId }).catch(() => {});
    return spawnedSessionId;
}

export function ensureVoiceConversationSessionForVoiceHome(
    requirements: VoiceHomeConversationSessionRequirements | null = null,
    signal?: AbortSignal,
): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const join = (pending: Promise<string>) => {
        const reader = Symbol();
        voiceHomeEnsureReaders.add(reader);
        return createAbortRacer(signal).race(pending).finally(() => {
            voiceHomeEnsureReaders.delete(reader);
            if (voiceHomeEnsurePromise === pending && voiceHomeEnsureReaders.size === 0) {
                voiceHomeEnsureController?.abort();
            }
        });
    };
    if (voiceHomeEnsurePromise) {
        if (!voiceHomeEnsureController?.signal.aborted
            && (voiceHomeEnsureRequirements === requirements || (!voiceHomeEnsureRequirements && !requirements))) {
            return join(voiceHomeEnsurePromise);
        }
        const current = join(voiceHomeEnsurePromise);
        return current.then(
            () => ensureVoiceConversationSessionForVoiceHome(requirements, signal),
            () => ensureVoiceConversationSessionForVoiceHome(requirements, signal),
        );
    }

    const controller = new AbortController();
    const retirement = captureActiveServerAccountScopeLifetime()?.onRetire(() => controller.abort());
    const pending = ensureVoiceConversationSessionForVoiceHomeUnguarded(requirements, controller.signal);
    voiceHomeEnsurePromise = pending;
    voiceHomeEnsureRequirements = requirements;
    voiceHomeEnsureController = controller;
    void pending.finally(() => {
        retirement?.dispose();
        if (voiceHomeEnsurePromise === pending) {
            voiceHomeEnsurePromise = null;
            voiceHomeEnsureRequirements = null;
            voiceHomeEnsureController = null;
        }
    }).catch(() => {});

    return join(pending);
}

export function ensureVoiceConversationSessionId(signal?: AbortSignal): Promise<string> {
    return ensureVoiceConversationSessionForVoiceHome(null, signal);
}

function matchesVoiceConversationExecutionSelection(params: Readonly<{
    state: ReturnType<typeof storage.getState>;
    sessionId: string;
    backendTarget: PersistedBackendTargetRefV2;
    connectedServices?: ConnectedServiceBindingsV2;
    permissionMode?: PermissionIntent;
}>): boolean {
    const metadata = readVoiceSessionOwnerMetadataFromState(params.state, params.sessionId);
    try {
        const target = resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session: { metadata } }));
        const connectedServices = metadata?.connectedServices == null ? undefined
            : ConnectedServiceBindingsV2IngressSchema.parse(metadata.connectedServices);
        return target !== null && buildBackendTargetKeyV2(target) === buildBackendTargetKeyV2(params.backendTarget)
            && stableJsonStringify(connectedServices) === stableJsonStringify(params.connectedServices)
            && (params.permissionMode === undefined
                || (readPermissionModeIntentFromMetadata(metadata ?? {})?.permissionMode
                    ?? params.state.sessions[params.sessionId]?.permissionMode) === params.permissionMode);
    } catch {
        return false;
    }
}

function findSessionRootVoiceConversationSessionId(params: Readonly<{
    state: any;
    sessionId: string;
    machineId: string;
    directory: string;
    backendTarget: PersistedBackendTargetRefV2;
    connectedServices?: ConnectedServiceBindingsV2;
    permissionMode: PermissionIntent;
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
            && candidate.session.archivedAt == null
            && normalizeNonEmptyString((candidate.metadata as any)?.machineId) === params.machineId
            && resolveVoiceSpawnDirectoryIdentity(
                params.state,
                params.machineId,
                (candidate.metadata as any)?.path,
            )
                === directoryIdentity
            && matchesVoiceConversationExecutionSelection({ state: params.state, sessionId: candidate.sessionId,
                backendTarget: params.backendTarget, connectedServices: params.connectedServices,
                permissionMode: params.permissionMode })
            && matchesVoiceConversationScope(candidate.metadata ?? null, { kind: 'session_root', sessionRootId: params.sessionId }),
    )?.sessionId ?? null;
}

export async function ensureVoiceConversationSessionForSessionRoot(params: Readonly<{
    sessionRootAddress: SessionAddress;
    signal?: AbortSignal;
}>): Promise<string> {
    const rootAddress = normalizeSessionAddress(
        params.sessionRootAddress?.serverId,
        params.sessionRootAddress?.sessionId,
    );
    if (!rootAddress) throw new Error('voice_conversation_session_target_missing');
    // Spawn, retirement, custody and hidden-session lookup all run against the Home this runtime
    // has mounted. Two Homes can hold the same Session id, so an unmounted Home would silently
    // attach the conversation to a different Session instead of the requested root.
    if (!areServerProfileIdentifiersEquivalent(rootAddress.serverId, getActiveServerSnapshot().serverId)) {
        throw new Error('voice_conversation_session_home_not_mounted');
    }
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) {
        throw Object.assign(new Error('voice_agent_account_scope_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
    assertVoiceConversationAccountCurrent(accountLifetime);
    const sessionId = rootAddress.sessionId;

    // An explicit Start on a synced Voice conversation resumes that carrier.
    // Its recorded voice_home/session_root scope must not become a root pointing
    // at itself; ordinary coding roots still use the exact scoped lookup below.
    let requestedMetadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), rootAddress);
    if (!requestedMetadata) {
        await sync.ensureSessionVisibleForMessageRoute(sessionId, { serverId: rootAddress.serverId });
        requestedMetadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), rootAddress);
    }
    if (isVoiceConversationSystemSessionMetadata(requestedMetadata)
        && !shouldRetireLegacyVoiceConversationSession({ metadata: requestedMetadata })) {
        assertVoiceConversationAccountCurrent(accountLifetime);
        if (storage.getState().sessions[sessionId]?.archivedAt != null) {
            // Explicit continuation owns this exact carrier, independently of
            // today's idle-start recipe. Restore it before exact-Account Resume.
            params.signal?.throwIfAborted();
            const restored = await sessionUnarchiveWithServerScope(sessionId, { serverId: rootAddress.serverId });
            assertVoiceConversationAccountCurrent(accountLifetime);
            if (!restored.success) {
                throw Object.assign(new Error('voice_conversation_unarchive_failed'), { code: 'VOICE_CONVERSATION_UNARCHIVE_FAILED' });
            }
        }
        await recoverPendingVoiceConversationCustody({ sessionId, serverId: rootAddress.serverId,
            accountLifetime, failureMessage: 'Voice conversation custody could not be completed' });
        await ensureVoiceConversationRuntime({ sessionId, accountLifetime, signal: params.signal });
        await applyVoiceConversationRetentionPolicy({ keepSessionId: sessionId }).catch(() => {});
        return sessionId;
    }

    const target = await resolveSessionRootTarget(rootAddress);
    assertVoiceConversationAccountCurrent(accountLifetime);
    const machineId = target?.machineId ?? null;
    const directory = target?.directory ?? null;
    if (!machineId || !directory) throw new Error('voice_conversation_session_target_missing');
    assertTargetMachineStructurallyReadyForSpawn(machineId);

    await retireLegacyVoiceConversationSessions({ machineId, directory }).catch(() => {});
    let state: any = storage.getState();
    const agentCfg = readLocalConversationVoiceSettings(readCanonicalVoiceSettingsFromState(state)).agent;
    const followsRoot = agentCfg.agentSource === 'session' && agentCfg.providerChat?.status !== 'configured';
    const rootMetadata = readVoiceSessionOwnerMetadataFromState(state, rootAddress);
    const rootBackend = followsRoot ? resolveSessionActionDefaultBackend({
        session: { metadata: rootMetadata },
    }) : null;
    const rootBackendTarget = resolveSessionActionDefaultTarget(rootBackend);
    if (followsRoot && !rootBackendTarget) {
        throw Object.assign(new Error('voice_agent_selection_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
    const backendTarget = rootBackendTarget ?? await resolveVoiceConversationBackendTarget(state, machineId, params.signal);
    assertVoiceConversationAccountCurrent(accountLifetime);
    const connectedServices = followsRoot && rootMetadata?.connectedServices != null
        ? ConnectedServiceBindingsV2IngressSchema.parse(rootMetadata.connectedServices)
        : followsRoot ? undefined : await resolveVoiceConversationDefaultBindings({ machineId,
            backendTarget, accountLifetime, signal: params.signal });
    const permissionMode = resolveVoiceConversationPermissionIntent(state);
    const needsRootModel = followsRoot && agentCfg.chatModelSource === 'session';
    const modelSelection = needsRootModel && rootBackend?.defaultAgentId ? await resolveVoiceSessionModelSelection({
        sessionAddress: rootAddress, agentId: rootBackend.defaultAgentId, agentTargetKey: buildBackendTargetKeyV2(backendTarget),
        signal: params.signal,
    }) : null;
    assertVoiceConversationAccountCurrent(accountLifetime);
    if (needsRootModel && !modelSelection) {
        throw Object.assign(new Error('voice_agent_selection_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
    let existingSessionId = findSessionRootVoiceConversationSessionId({
        state,
        sessionId,
        machineId,
        directory,
        backendTarget,
        connectedServices,
        permissionMode,
    });
    if (!existingSessionId) {
        const refreshed = await sync.refreshSessions({ awaitSessionListHydration: true });
        // The root Home was resolved and validated before these awaits. Focus can move while the
        // authoritative list loads, and two Homes can hold the same Session id, so both the row
        // read and the hydration request stay bound to that captured Home rather than re-reading
        // focus after the await.
        const refreshedHydrationCandidateSessionIds = (refreshed?.sessionIds ?? []).filter((candidateSessionId) => {
            const state = storage.getState();
            const renderable = state.sessionListRowsByServerId?.[rootAddress.serverId]?.[candidateSessionId];
            // Encrypted rows can be listed before their metadata hydration finishes. They
            // are possible hidden Voice sessions until exact hydration proves otherwise.
            return !renderable
                || renderable.metadata == null
                || renderable.metadata.hiddenSystemSession === true
                || renderable.metadataUnavailable === true;
        });
        await Promise.all(refreshedHydrationCandidateSessionIds.map((candidateSessionId) => (
            sync.ensureSessionVisibleForMessageRoute(candidateSessionId, {
                serverId: rootAddress.serverId,
            }).catch(() => undefined)
        )));
        state = storage.getState();
        existingSessionId = findSessionRootVoiceConversationSessionId({
            state,
            sessionId,
            machineId,
            directory,
            backendTarget,
            connectedServices,
            permissionMode,
        });
    }

    if (existingSessionId) {
        assertVoiceConversationAccountCurrent(accountLifetime);
        await recoverPendingVoiceConversationCustody({
            sessionId: existingSessionId,
            serverId: rootAddress.serverId,
            accountLifetime,
            failureMessage: 'Voice conversation custody could not be completed',
        });
        await ensureVoiceConversationRuntime({ sessionId: existingSessionId, accountLifetime, signal: params.signal });
        await touchVoiceConversationSessionWithScope(existingSessionId, { kind: 'session_root', sessionRootId: sessionId });
        await applyVoiceConversationRetentionPolicy({ keepSessionId: existingSessionId }).catch(() => {});
        return existingSessionId;
    }

    const serverId = rootAddress.serverId;
    const creationKey = buildVoiceSpawnUserAttemptId({
            surface: 'voice_session_root',
            serverId,
            machineId,
            directory: resolveRequiredVoiceSpawnDirectoryIdentity(state, machineId, directory),
            backendTarget,
            connectedServices,
            modelSelection: modelSelection?.ref ?? null,
            permissionMode,
            sessionId,
        });
    const spawned = await spawnVoiceConversationSession({
        machineId,
        serverId,
        accountLifetime,
        signal: params.signal,
        directory,
        backendTarget,
        ...(connectedServices ? { connectedServices } : {}),
        ...(modelSelection ? { modelSelection } : {}),
        permissionMode,
        creationKey,
    });
    const spawnedSessionId = spawned.sessionId;

    await finalizeSpawnedVoiceConversationSession({
        sessionId: spawnedSessionId,
        scope: { kind: 'session_root', sessionRootId: sessionId },
        accountLifetime,
    });
    assertVoiceConversationAccountCurrent(accountLifetime);
    if (spawned.disposition === 'rejoined') {
        await ensureVoiceConversationRuntime({ sessionId: spawnedSessionId, accountLifetime, signal: params.signal });
    }
    await applyVoiceConversationRetentionPolicy({ keepSessionId: spawnedSessionId }).catch(() => {});

    return spawnedSessionId;
}
