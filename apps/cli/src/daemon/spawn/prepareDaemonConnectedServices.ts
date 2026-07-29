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

import { buildSpawnResumeUnreachableErrorResult } from '../connectedServices/buildSpawnResumeUnreachableErrorResult';
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
import {
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
    resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn,
    type AgentSpawnPurposeContributions,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { shouldResolveConnectedServiceAuthForSpawn } from '../connectedServices/shouldResolveConnectedServiceAuthForSpawn';

type SpawnCredentials = NonNullable<Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['credentials']>;
type SpawnApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];
type SpawnAccountUsageStore = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['accountUsageStore'];
type SpawnAuthGroupSwitchCoordinator = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator'];
type SpawnPredictiveSwitchGuard = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['predictiveSwitchGuard'];
type ConnectedServiceAuth = Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>;

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
    agentId: CatalogAgentId;
    reason: string;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
    return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
        errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
        uxDiagnostic: buildConnectedServiceUxDiagnostic({
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
            failurePhase: 'materialization',
            source: 'spawn_resume',
            agentId: input.agentId,
            retryable: false,
            diagnostics: { reason: input.reason },
        }),
    });
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
    catalogAgentIdForConnectedServices: CatalogAgentId;
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
    }>) => Promise<ConnectedServiceMaterializationIdentityV1 | null>;
}>): Promise<PreparedDaemonConnectedServices | Readonly<{
    ok: false;
    result: Extract<SpawnSessionResult, { type: 'error' }>;
}>> {
    const shouldResolveAuth = shouldResolveConnectedServiceAuthForSpawn(input.options);
    let materializationIdentity =
        readConnectedServiceMaterializationIdentityFromSpawnOptions(input.options)
        ?? readConnectedServiceMaterializationIdentityFromEnvironment(input.options.environmentVariables);
    if (shouldResolveAuth && !materializationIdentity) {
        if (input.normalizedExistingSessionId) {
            const connectedServices = readConnectedServiceBindingsOrNull(input.options.connectedServices);
            if (
                input.catalogAgentId
                && connectedServiceBindingsRequireMaterializationIdentity(connectedServices)
                && input.repairMissingMaterializationIdentity
            ) {
                materializationIdentity = await input.repairMissingMaterializationIdentity({
                    sessionId: input.normalizedExistingSessionId,
                    agentId: input.catalogAgentId,
                    connectedServices,
                    vendorResumeId: input.effectiveResume || null,
                });
            }
            if (!materializationIdentity) {
                return {
                    ok: false,
                    result: buildMaterializationIdentityMissingSpawnErrorResult({
                        agentId: input.catalogAgentId ?? input.catalogAgentIdForConnectedServices,
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
                resolveRequestAuthPurposeBindings: (bindings) =>
                    resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn({
                        agentId: input.catalogAgentId!,
                        bindings,
                        contributions: input.pluginContributions,
                    }),
                allowLegacyUnfencedOneShotMaterialization: true,
                serverContract: input.serverContract,
            });
        } catch (error) {
            if (error instanceof ConnectedServiceSpawnResumeUnreachableError) {
                logger.warn('[DAEMON RUN] Connected services resume reachability re-verify failed; failing closed before spawn', {
                    agentId: error.agentId,
                    errorCode: error.errorCode,
                    failurePhase: error.failurePhase,
                    vendorResumeId: error.vendorResumeId,
                    cwd: error.cwd,
                    targetMaterializedRoot: error.targetMaterializedRoot,
                    reason: error.reason,
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
    } else if (shouldResolveAuth && !input.catalogAgentId) {
        logger.warn('[DAEMON RUN] Ignoring connected-services spawn request for configured backend target');
    }

    const effectiveBindings = auth?.connectedServicesBindings ?? options.connectedServices;
    const effectiveBindingsV1 = readConnectedServiceBindingsOrNull(effectiveBindings);
    const qualifiedPurposeBindingSnapshot =
        auth?.ongoingRuntimeRegistrationAllowed === false
        ? null
        : effectiveBindingsV1
        ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            agentId: input.catalogAgentId ?? input.catalogAgentIdForConnectedServices,
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
