import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedServiceBindingsV2, ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

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
    boundConnectedServiceMaterializationDiagnosticValue,
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
    sanitizeConnectedServiceDiagnosticError,
} from '../connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import {
    CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
    CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
} from '../connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';
import { shouldResolveConnectedServiceAuthForSpawn } from '../connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import type { ConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { ConnectedServicesBindingsIngressSchema } from '../connectedServices/parseConnectedServicesBindings';

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

function readConnectedServiceBindingsOrNull(raw: unknown): ConnectedServiceBindingsV2 | null {
    const parsed = ConnectedServicesBindingsIngressSchema.safeParse(raw);
    return parsed.success ? parsed.data ?? null : null;
}

function connectedServiceBindingsRequireMaterializationIdentity(
    bindings: ConnectedServiceBindingsV2 | null,
): bindings is ConnectedServiceBindingsV2 {
    return Boolean(
        bindings
        && Object.values(bindings.bindingsByServiceId)
            .some((binding) => binding.source === 'connected' || binding.source === 'team_resource'),
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
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    serverContract?:
        SessionSyncPendingInputServerContractResult | null;
    repairMissingMaterializationIdentity?: (repair: Readonly<{
        sessionId: string;
        agentId: CatalogAgentId;
        connectedServices: ConnectedServiceBindingsV2;
        vendorResumeId: string | null;
    }>) => Promise<MissingConnectedServiceMaterializationIdentityRepair | null>;
}>): Promise<PreparedDaemonConnectedServices | Readonly<{
    ok: false;
    result: Extract<SpawnSessionResult, { type: 'error' }>;
}>> {
    const admittedBindings = ConnectedServicesBindingsIngressSchema.safeParse(input.options.connectedServices);
    if (!admittedBindings.success) {
        return {
            ok: false,
            result: {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                errorMessage: 'connected_service_bindings_invalid',
            },
        };
    }
    const admittedOptions = {
        ...input.options,
        ...(admittedBindings.data ? { connectedServices: admittedBindings.data } : {}),
    };
    const shouldResolveAuth = shouldResolveConnectedServiceAuthForSpawn(admittedOptions);
    let materializationIdentity =
        readConnectedServiceMaterializationIdentityFromSpawnOptions(input.options)
        ?? readConnectedServiceMaterializationIdentityFromEnvironment(input.options.environmentVariables);
    let missingIdentityRepair: MissingConnectedServiceMaterializationIdentityRepair | null = null;
    if (shouldResolveAuth && !materializationIdentity) {
        if (input.normalizedExistingSessionId) {
            const connectedServices = admittedBindings.data ?? null;
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
        ? { ...admittedOptions, connectedServiceMaterializationIdentityV1: materializationIdentity }
        : admittedOptions;
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
                ...(options.runtimeDescriptorV1
                    ? { runtimeDescriptorV1: options.runtimeDescriptorV1 }
                    : {}),
                resumeReachabilityRequired: spawnSharedStateContinuityRequested,
                resolveQualifiedPurposeBindingSnapshot: (bindings) =>
                    resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                        agentId: input.catalogAgentId!,
                        bindings,
                        contributions: input.pluginContributions,
                    }),
                ...(input.activatePurposeBindings
                    ? {
                        activateQualifiedPurposeBindings: (snapshot) => {
                            const consumer = snapshot.purposes[0]?.consumer;
                            if (!consumer) {
                                throw new Error(
                                    'connected_account_materialization_consumer_unavailable',
                                );
                            }
                            return input.activatePurposeBindings!({
                                subject: {
                                    kind: 'operation',
                                    operationId: materializationKey,
                                    consumer,
                                    // The Session this launch materializes for:
                                    // its direct Team material opens only
                                    // through that Session's Home-admitted
                                    // Team binding (lane 10 child 06 §15).
                                    ...(authSessionId ? { sessionId: authSessionId } : {}),
                                    isCurrent: () => true,
                                },
                                purposes: snapshot.purposes,
                                bindings: snapshot.bindings,
                                ...(snapshot.directMaterialOrigins
                                    ? { directMaterialOrigins: snapshot.directMaterialOrigins }
                                    : {}),
                            });
                        },
                    }
                    : {}),
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
                    // Plugin-authored diagnostic prose reaches the retained
                    // daemon log — and the remote log sink when the dangerous
                    // remote-debug setting is on — so every open scalar is
                    // bounded and redacted by the one Connected Service
                    // diagnostic privacy owner before it is serialized.
                    diagnostics: error.diagnostics.map((diagnostic) => ({
                        code: boundConnectedServiceMaterializationDiagnosticValue(diagnostic.code),
                        providerId: diagnostic.providerId,
                        serviceId: diagnostic.serviceId,
                        reason: boundConnectedServiceMaterializationDiagnosticValue(diagnostic.reason),
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
            // An unclassified resolution failure is still upstream/plugin text:
            // it can name a credential or a local path, and it crosses both the
            // retained daemon log and the spawn result to the requesting client.
            const safeResolutionFailure = sanitizeConnectedServiceDiagnosticError(error);
            logger.debug('[DAEMON RUN] Connected services resolution failed', {
                reason: safeResolutionFailure,
            });
            return {
                ok: false,
                result: {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                    errorMessage: `Connected services resolution failed: ${safeResolutionFailure}`,
                },
            };
        }
        if (missingIdentityRepair) {
            try {
                await missingIdentityRepair.persistAfterMaterialization();
            } catch (error) {
                const cleanup = auth?.cleanupOnFailure ?? null;
                await Promise.resolve(cleanup?.());
                logger.warn('[DAEMON RUN] Failed to persist repaired connected-service materialization identity after exact existing-session materialization', {
                    reason: sanitizeConnectedServiceDiagnosticError(error),
                });
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
        auth
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
