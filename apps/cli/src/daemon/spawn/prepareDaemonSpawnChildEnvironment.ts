import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { configuration } from '@/configuration';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type {
    ProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';
import type {
    ProviderRedactionLease,
    ProviderStreamingSanitizer,
} from '@/providers/spawn/redaction';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import type { ResolvedTerminalRequest } from '@/terminal/runtime/terminalConfig';
import { logger } from '@/ui/logger';

import type { resolveConnectedServiceAuthForSpawn } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { withConnectedServiceMaterializationIdentityEnv } from '../connectedServices/materialization/identity';
import { buildTrackedSessionRespawnEnvironmentVariables } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { buildProviderSpawnErrorResult } from './buildProviderSpawnErrorResult';
import {
    HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
    serializePendingFirstInputForEnv,
} from './pendingFirstInput';
import {
    HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY,
    serializeInitialGoalForEnv,
} from './initialGoal';
import {
    HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
    serializePersistedTakeoverAdmissionForEnv,
} from './persistedTakeoverAdmission';

type ConnectedServiceAuth = Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>;
export async function prepareDaemonSpawnChildEnvironment(input: Readonly<{
    options: SpawnSessionOptions;
    existingSessionMetadata?: Readonly<Record<string, unknown>> | null;
    resolvedAgentId?: string | null;
    effectiveModelSelection: SpawnSessionOptions['modelSelection'];
    terminal: SpawnSessionOptions['terminal'];
    admittedTerminalRequest?: ResolvedTerminalRequest;
    profileEnvironmentVariables: Readonly<Record<string, string>>;
    daemonSpawnHooks: DaemonSpawnHooks | null;
    pluginRuntimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
    processEnv: NodeJS.ProcessEnv;
    connectedServiceAuth: ConnectedServiceAuth;
    connectedServiceMaterializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
    providerBindingAttempt: ProviderSpawnAuthorizationAttempt | null;
    providerAgentTargetKey: string | null;
    providerDiagnosticRedactionLease: ProviderRedactionLease;
    launchResourceScope: ProviderLaunchResourceScope;
}>): Promise<Readonly<{
    ok: false;
    result: Extract<SpawnSessionResult, { type: 'error' }>;
}> | Readonly<{
    ok: true;
    spawnEnvironment: Extract<Awaited<ReturnType<typeof resolveSpawnChildEnvironment>>, { ok: true }>;
    extraEnv: Record<string, string>;
    extraEnvForChild: Record<string, string>;
    trackedSpawnOptions: SpawnSessionOptions;
    terminalRequest: ReturnType<typeof resolveTerminalRequestFromSpawnOptions>;
    sanitizeDiagnosticText: (value: string) => string;
    createStreamingSanitizer?: () => ProviderStreamingSanitizer;
}>> {
    const providerBindingLaunchInput = (() => {
        if (!input.providerBindingAttempt) return null;
        if (!input.providerAgentTargetKey) {
            throw new Error('Provider binding launch requires an Agent target key');
        }
        return Object.freeze({
            attempt: input.providerBindingAttempt,
            agentTargetKey: input.providerAgentTargetKey,
        });
    })();
    const materializeProviderBindingAfterHooks =
        providerBindingLaunchInput
        && 'materializeAfterHooks' in providerBindingLaunchInput.attempt
            ? providerBindingLaunchInput.attempt.materializeAfterHooks
            : null;
    const spawnEnvironment = await resolveSpawnChildEnvironment({
        happyHomeDir: configuration.happyHomeDir,
        pluginRuntimeRegistry: input.pluginRuntimeRegistry,
        options: input.options,
        ...(input.existingSessionMetadata ? { existingSessionMetadata: input.existingSessionMetadata } : {}),
        resolvedAgentId: input.resolvedAgentId,
        profileEnvironmentVariables: input.profileEnvironmentVariables,
        daemonSpawnHooks: input.daemonSpawnHooks,
        processEnv: input.processEnv,
        logDebug: (message) => logger.debug(message),
        logInfo: (message) => logger.info(message),
        logWarn: (message) => logger.warn(message),
        connectedServiceAuth: input.connectedServiceAuth,
        ...(input.options.requesterSessionBootstrap ? { allowNativeAccountCredentials: false } : {}),
        ...(providerBindingLaunchInput
            ? {
                providerBindingContext: {
                    v: 1 as const,
                    agentTargetKey: providerBindingLaunchInput.agentTargetKey,
                    connectionId: providerBindingLaunchInput.attempt.authorization.ticket.connectionId,
                    modelId: providerBindingLaunchInput.attempt.authorization.binding.selection.model.id,
                },
                runtimePrerequisitesAlreadyResolved:
                    materializeProviderBindingAfterHooks !== null,
                ...(materializeProviderBindingAfterHooks
                    ? {
                        materializeProviderBindingAfterHooks:
                            async () => {
                                const materialized =
                                    await materializeProviderBindingAfterHooks();
                                if (!materialized.ok) {
                                    return {
                                        ok: false as const,
                                        errorCode:
                                            SPAWN_SESSION_ERROR_CODES
                                                .SPAWN_VALIDATION_FAILED,
                                        errorMessage:
                                            materialized.error.code,
                                        providerError:
                                            materialized.error,
                                    };
                                }
                                input.providerDiagnosticRedactionLease.add(
                                    materialized.redactionLease.values(),
                                );
                                return {
                                    ok: true as const,
                                    providerEnvironmentOverlay:
                                        materialized.materialization
                                            .providerEnvironmentOverlay,
                                    providerBindingLaunchHandoff: {
                                        v: 1 as const,
                                        materialization:
                                            materialized.materialization
                                                .launchMaterialization,
                                        sessionBindingMetadata:
                                            providerBindingLaunchInput
                                                .attempt.authorization
                                                .sessionBindingMetadata,
                                    },
                                };
                            },
                    }
                    : {}),
            }
            : {}),
    });
    if (spawnEnvironment.cleanupOnFailure || spawnEnvironment.cleanupOnExit) {
        input.launchResourceScope.register({
            onFailure: spawnEnvironment.cleanupOnFailure ?? (() => {}),
            onExit: spawnEnvironment.cleanupOnExit ?? (() => {}),
        });
    }
    if (!spawnEnvironment.ok) {
        return {
            ok: false,
            result: spawnEnvironment.providerError
                ? buildProviderSpawnErrorResult(spawnEnvironment.providerError)
                : {
                    type: 'error',
                    errorCode: spawnEnvironment.errorCode,
                    errorMessage: spawnEnvironment.errorMessage,
                    ...(spawnEnvironment.agentId !== undefined ? { agentId: spawnEnvironment.agentId } : {}),
                },
        };
    }

    const extraEnv = spawnEnvironment.expandedEnvironmentVariables;
    const connectedServiceChildEnvironment = input.connectedServiceMaterializationIdentity
        ? withConnectedServiceMaterializationIdentityEnv(
            spawnEnvironment.extraEnvForChild,
            input.connectedServiceMaterializationIdentity,
        )
        : spawnEnvironment.extraEnvForChild;
    const extraEnvForChild = { ...connectedServiceChildEnvironment };
    // Inherited daemon/tmux state is never requester authority. Only the
    // admitted launch owner supplies this exact protected Session custody.
    delete extraEnvForChild.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
    delete extraEnvForChild.HAPPIER_SESSION_REQUESTER_SESSION_ID;
    if (input.options.requesterSessionCredentialFile) {
        if (!input.options.existingSessionId) throw new Error('requester_session_custody_requires_committed_session');
        extraEnvForChild.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE = input.options.requesterSessionCredentialFile;
        extraEnvForChild.HAPPIER_SESSION_REQUESTER_SESSION_ID = input.options.existingSessionId;
    }
    delete extraEnvForChild[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
    if (input.options.pendingFirstInput) {
        extraEnvForChild[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY] =
            serializePendingFirstInputForEnv(input.options.pendingFirstInput);
    }
    delete extraEnvForChild[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY];
    if (input.options.initialGoal) {
        extraEnvForChild[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY] =
            serializeInitialGoalForEnv(input.options.initialGoal);
    }
    delete extraEnvForChild[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
    if (input.options.persistedTakeoverAdmission) {
        extraEnvForChild[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY] =
            serializePersistedTakeoverAdmissionForEnv(
                input.options.persistedTakeoverAdmission,
            );
    }
    const trackedSessionEnvironmentVariables = buildTrackedSessionRespawnEnvironmentVariables({
        expandedEnvironmentVariables: extraEnv,
        extraEnvForChild,
        excludedEnvironmentVariableKeys: [
            ...(spawnEnvironment.providerEnvKeys ?? []),
            HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
            HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY,
            HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
            'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE',
            'HAPPIER_SESSION_REQUESTER_SESSION_ID',
        ],
    });
    const {
        initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
        pendingFirstInput: _pendingFirstInput,
        initialGoal: _initialGoal,
        initialAccess: _initialAccess,
        reportsTo: _reportsTo,
        initialSessionRolesV1: _initialSessionRolesV1,
        freshSessionCreation: _freshSessionCreation,
        managedDirectorySeed: _managedDirectorySeed,
        primaryTeamId: _primaryTeamId,
        persistedTakeoverAdmission: _persistedTakeoverAdmission,
        verifyRequesterMachineAdmissionCurrent: _verifyRequesterMachineAdmissionCurrent,
        beforeSessionRunnerLaunch: _beforeSessionRunnerLaunch,
        requesterSessionCredentialFile: _requesterSessionCredentialFile,
        requesterSessionBootstrap: _requesterSessionBootstrap,
        requesterSessionRuntimeContext: _requesterSessionRuntimeContext,
        modelSelection: _requestedModelSelection,
        providerBindingMetadataV1: _priorProviderBindingMetadataV1,
        providerBindingSecurityChangeConfirmationV1: _transientProviderBindingSecurityChangeConfirmationV1,
        ...trackedSpawnOptionsBase
    } = input.options;
    const trackedSpawnOptions: SpawnSessionOptions = {
        ...trackedSpawnOptionsBase,
        ...(input.effectiveModelSelection
            ? { modelSelection: input.effectiveModelSelection }
            : {}),
        ...(input.providerBindingAttempt
            ? { providerBindingMetadataV1: input.providerBindingAttempt.authorization.sessionBindingMetadata }
            : {}),
        ...(trackedSessionEnvironmentVariables
            ? { environmentVariables: trackedSessionEnvironmentVariables }
            : {}),
        ...(spawnEnvironment.materializationDiagnostics
            ? { materializationDiagnostics: spawnEnvironment.materializationDiagnostics }
            : {}),
    };

    return {
        ok: true,
        spawnEnvironment,
        extraEnv,
        extraEnvForChild,
        trackedSpawnOptions,
        terminalRequest: input.admittedTerminalRequest ?? resolveTerminalRequestFromSpawnOptions({
            happyHomeDir: configuration.happyHomeDir,
            terminal: input.terminal,
            environmentVariables: extraEnv,
        }),
        sanitizeDiagnosticText: input.providerDiagnosticRedactionLease.redact,
        createStreamingSanitizer:
            input.providerDiagnosticRedactionLease.createStreamingSanitizer,
    };
}
