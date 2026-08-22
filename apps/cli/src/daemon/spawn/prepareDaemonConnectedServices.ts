import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    ConnectedServiceBindingsV1Schema,
    resolveConnectedServicesProviderStateSharingPolicyV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type {
    SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { configuration } from '@/configuration';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';

import {
    buildSpawnResumeUnreachableErrorResult,
    resolveSafeResumeUnreachableDiagnosticReason,
} from '../connectedServices/buildSpawnResumeUnreachableErrorResult';
import {
    buildConnectedServiceCredentialSpawnErrorResult,
    buildConnectedServiceDiagnosticSpawnValidationErrorResult,
    buildConnectedServiceMaterializationSpawnErrorResult,
} from '../connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { buildConnectedServiceUxDiagnostic } from '../connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { ConnectedServiceMaterializationBlockedError } from '../connectedServices/materialize/materializeConnectedServicesForSpawn';
import {
    readConnectedServiceMaterializationIdentityFromEnvironment,
    readConnectedServiceMaterializationIdentityFromSpawnOptions,
    resolveConnectedServiceMaterializationIdentityForSpawn,
} from '../connectedServices/materialization/identity';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import {
    ConnectedServiceSpawnResumeUnreachableError,
    resolveConnectedServiceAuthForSpawn,
} from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { ConnectedServiceAuthGroupQuotaProbeIncompleteError } from '../connectedServices/accountGroups/quotas/preTurnQuotaProbe';
import {
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
    type AgentSpawnPurposeContributions,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
    CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
} from '../connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';
import { shouldResolveConnectedServiceAuthForSpawn } from '../connectedServices/shouldResolveConnectedServiceAuthForSpawn';

type SpawnCredentials = NonNullable<Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['credentials']>;
type SpawnApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];
type SpawnAccountUsageStore = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['accountUsageStore'];
type SpawnAuthGroupSwitchCoordinator = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator'];
type SpawnPredictiveSwitchGuard = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['predictiveSwitchGuard'];
type ConnectedServiceAuth = Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>;

export type MissingConnectedServiceMaterializationIdentityRepair = Readonly<{
    identity: ConnectedServiceMaterializationIdentityV1;
    persistAfterMaterialization: () => Promise<void>;
}>;

function readConnectedServiceBindingsOrNull(raw: unknown): ConnectedServiceBindingsV1 | null {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

function connectedServiceBindingsRequireMaterializationIdentity(
    bindings: ConnectedServiceBindingsV1 | null,
): bindings is ConnectedServiceBindingsV1 {
    return Boolean(
        bindings
        && Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected'),
    );
}

function buildMaterializationIdentityMissingSpawnErrorResult(input: Readonly<{
    /** Absent for a configured backend target, which has no catalog Agent identity. */
    agentId: CatalogAgentId | null;
    reason: string;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
    return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
        errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
        uxDiagnostic: buildConnectedServiceUxDiagnostic({
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
            failurePhase: 'materialization',
            source: 'spawn_resume',
            ...(input.agentId ? { agentId: input.agentId } : {}),
            retryable: false,
            diagnostics: { reason: input.reason },
        }),
    });
}

export function buildConnectedServiceQuotaPreflightIncompleteSpawnErrorResult(): Extract<SpawnSessionResult, { type: 'error' }> {
    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_service_quota_preflight_incomplete',
    };
}

export type PreparedDaemonConnectedServices = Readonly<{
    ok: true;
    auth: ConnectedServiceAuth;
    materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
    options: SpawnSessionOptions;
    effectiveBindings: SpawnSessionOptions['connectedServices'];
    materializationKey: string;
    authSessionId: string | undefined;
    qualifiedPurposeBindingSnapshot: ReturnType<
        typeof resolveQualifiedPurposeBindingSnapshotForAgentSpawn
    >;
}>;

export async function prepareDaemonConnectedServices(input: Readonly<{
    options: SpawnSessionOptions;
    normalizedExistingSessionId: string;
    requestedSessionId: string;
    effectiveResume: string;
    catalogAgentId: CatalogAgentId | null;
    credentials: SpawnCredentials;
    api: SpawnApi;
    providerAccountUsageStore?: SpawnAccountUsageStore;
    connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null;
    authGroupSwitchCoordinator?: SpawnAuthGroupSwitchCoordinator | null;
    predictiveSwitchGuard?: SpawnPredictiveSwitchGuard;
    processEnv: NodeJS.ProcessEnv;
    connectedServicesMaterializationBaseDir: string;
    pluginContributions: AgentSpawnPurposeContributions;
    serverContract?:
        SessionSyncPendingInputServerContractResult | null;
    repairMissingMaterializationIdentity?: (repair: Readonly<{
        sessionId: string;
        agentId: CatalogAgentId;
        connectedServices: ConnectedServiceBindingsV1;
        vendorResumeId: string | null;
    }>) => Promise<MissingConnectedServiceMaterializationIdentityRepair | null>;
}>): Promise<PreparedDaemonConnectedServices | Readonly<{
    ok: false;
    result: Extract<SpawnSessionResult, { type: 'error' }>;
}>> {
    const shouldResolveAuth = shouldResolveConnectedServiceAuthForSpawn(input.options);
    let materializationIdentity =
        readConnectedServiceMaterializationIdentityFromSpawnOptions(input.options)
        ?? readConnectedServiceMaterializationIdentityFromEnvironment(input.options.environmentVariables);
    let missingIdentityRepair: MissingConnectedServiceMaterializationIdentityRepair | null = null;
    if (shouldResolveAuth && !materializationIdentity) {
        if (input.normalizedExistingSessionId) {
            const connectedServices = readConnectedServiceBindingsOrNull(input.options.connectedServices);
            if (
                input.catalogAgentId
                && connectedServiceBindingsRequireMaterializationIdentity(connectedServices)
                && input.repairMissingMaterializationIdentity
            ) {
                missingIdentityRepair = await input.repairMissingMaterializationIdentity({
                    sessionId: input.normalizedExistingSessionId,
                    agentId: input.catalogAgentId,
                    connectedServices,
                    vendorResumeId: input.effectiveResume || null,
                });
                materializationIdentity = missingIdentityRepair?.identity ?? null;
            }
            if (!materializationIdentity) {
                return {
                    ok: false,
                    result: buildMaterializationIdentityMissingSpawnErrorResult({
                        agentId: input.catalogAgentId,
                        reason: 'missing_identity_and_resume_state',
                    }),
                };
            }
        } else {
            materializationIdentity = resolveConnectedServiceMaterializationIdentityForSpawn({
                options: input.options,
            });
        }
    }

    const options: SpawnSessionOptions = materializationIdentity
        ? { ...input.options, connectedServiceMaterializationIdentityV1: materializationIdentity }
        : { ...input.options };
    const materializationKey =
        materializationIdentity?.id
        || input.normalizedExistingSessionId
        || input.requestedSessionId
        || 'unmaterialized-connected-services';
    const authSessionId = input.normalizedExistingSessionId || undefined;
    let auth: ConnectedServiceAuth = null;

    if (shouldResolveAuth && input.catalogAgentId) {
        const activeAccountSettings = getActiveAccountSettingsSnapshot();
        const spawnSharedStateContinuityRequested = resolveConnectedServicesProviderStateSharingPolicyV1(
            (activeAccountSettings?.settings as { connectedServicesProviderStateSharingSettingsV1?: unknown } | null)
                ?.connectedServicesProviderStateSharingSettingsV1,
            input.catalogAgentId,
        ).stateMode === 'shared';
        try {
            auth = await resolveConnectedServiceAuthForSpawn({
                agentId: input.catalogAgentId,
                connectedServicesBindingsRaw: options.connectedServices,
                materializationKey,
                activeServerDir: configuration.activeServerDir,
                baseDir: input.connectedServicesMaterializationBaseDir,
                sessionDirectory: options.directory,
                credentials: input.credentials,
                api: input.api,
                accountUsageStore: input.providerAccountUsageStore ?? null,
                quotaFreshnessMs: 5 * 60_000,
                nowMs: () => Date.now(),
                ...(authSessionId ? { sessionId: authSessionId } : {}),
                authGroupSwitchCoordinator: input.authGroupSwitchCoordinator ?? null,
                predictiveSwitchGuard: input.predictiveSwitchGuard ?? null,
                accountSettings: activeAccountSettings?.settings ?? null,
                processEnv: input.processEnv,
                credentialRefreshService: input.connectedServiceRefreshCoordinator,
                vendorResumeId: input.effectiveResume || null,
                resumeReachabilityRequired: spawnSharedStateContinuityRequested,
                resolveQualifiedPurposeBindingSnapshot: (bindings) =>
                    resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                        agentId: input.catalogAgentId!,
                        bindings,
                        contributions: input.pluginContributions,
                    }),
                allowLegacyUnfencedOneShotMaterialization: true,
                serverContract: input.serverContract,
            });
        } catch (error) {
            if (error instanceof ConnectedServiceAuthGroupQuotaProbeIncompleteError) {
                logger.warn('[DAEMON RUN] Connected-services quota preflight incomplete; failing closed before spawn', {
                    agentId: input.catalogAgentId,
                    reason: error.result.reason,
                    requestedProfileCount: error.result.requestedProfileCount,
                    completedProfileCount: error.result.completedProfileCount,
                });
                return {
                    ok: false,
                    result: buildConnectedServiceQuotaPreflightIncompleteSpawnErrorResult(),
                };
            }
            if (error instanceof ConnectedServiceSpawnResumeUnreachableError) {
                logger.warn('[DAEMON RUN] Connected services resume reachability re-verify failed; failing closed before spawn', {
                    agentId: error.agentId,
                    errorCode: error.errorCode,
                    failurePhase: error.failurePhase,
                    vendorResumeId: CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
                    cwd: CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
                    targetMaterializedRoot: error.targetMaterializedRoot
                        ? CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER
                        : null,
                    reason: resolveSafeResumeUnreachableDiagnosticReason(error),
                });
                return { ok: false, result: buildSpawnResumeUnreachableErrorResult(error) };
            }
            if (error instanceof ConnectedServiceMaterializationBlockedError) {
                logger.warn('[DAEMON RUN] Connected services materialization failed; failing closed before spawn', {
                    agentId: input.catalogAgentId,
                    diagnostics: error.diagnostics.map((diagnostic) => ({
                        code: diagnostic.code,
                        providerId: diagnostic.providerId,
                        serviceId: diagnostic.serviceId,
                        reason: diagnostic.reason,
                        severity: diagnostic.severity,
                    })),
                });
                return {
                    ok: false,
                    result: buildConnectedServiceMaterializationSpawnErrorResult({
                        agentId: input.catalogAgentId,
                        diagnostics: error.diagnostics,
                    }),
                };
            }
            const credentialError = buildConnectedServiceCredentialSpawnErrorResult({
                agentId: input.catalogAgentId,
                error,
            });
            if (credentialError) {
                logger.warn('[DAEMON RUN] Connected services credential preflight failed; failing closed before spawn', {
                    agentId: input.catalogAgentId,
                    code: credentialError.errorMessage,
                });
                return { ok: false, result: credentialError };
            }
            logger.debug('[DAEMON RUN] Connected services resolution failed', error);
            return {
                ok: false,
                result: {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                    errorMessage: error instanceof Error
                        ? `Connected services resolution failed: ${error.message}`
                        : 'Connected services resolution failed.',
                },
            };
        }
        if (missingIdentityRepair) {
            try {
                await missingIdentityRepair.persistAfterMaterialization();
            } catch (error) {
                const cleanup = auth?.cleanupOnFailure ?? null;
                await Promise.resolve(cleanup?.());
                logger.warn('[DAEMON RUN] Failed to persist repaired connected-service materialization identity after exact existing-session materialization', error);
                return {
                    ok: false,
                    result: buildMaterializationIdentityMissingSpawnErrorResult({
                        agentId: input.catalogAgentId,
                        reason: 'identity_repair_persist_failed',
                    }),
                };
            }
        }
    } else if (shouldResolveAuth && !input.catalogAgentId) {
        logger.warn('[DAEMON RUN] Ignoring connected-services spawn request for configured backend target');
    }

    const effectiveBindings = auth?.connectedServicesBindings ?? options.connectedServices;
    const effectiveBindingsV1 = readConnectedServiceBindingsOrNull(effectiveBindings);
    const qualifiedPurposeBindingSnapshot =
        auth?.ongoingRuntimeRegistrationAllowed === false
        ? null
        : auth
        ? auth.qualifiedPurposeBindingSnapshot
        : effectiveBindingsV1 && input.catalogAgentId
        ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            agentId: input.catalogAgentId,
            bindings: effectiveBindingsV1,
            contributions: input.pluginContributions,
        })
        : null;
    return {
        ok: true,
        auth,
        materializationIdentity,
        options: {
            ...options,
            ...(effectiveBindings ? { connectedServices: effectiveBindings } : {}),
        },
        effectiveBindings,
        materializationKey,
        authSessionId,
        qualifiedPurposeBindingSnapshot,
    };
}
