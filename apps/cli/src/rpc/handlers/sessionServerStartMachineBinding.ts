import type { StoredCredentials } from '@/persistence';
import { SessionServerStartDispatchResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema, SessionSpawnNewActionResultV1Schema,
    readSessionSpawnNewActionResultV1, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { WorkflowTargetUnavailableDetailsV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import {
    createAutomationAccountEncryptionMaterialSnapshotV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { SessionSpawnDirectTargetTransport, MachineActionDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type { CurrentMachineInstallation } from '@/daemon/identity/currentMachineInstallation';
import type { SessionLifecycleActionHandler } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import type { SpawnSessionNonceResolver } from '@/session/services/awaitSpawnedSessionId';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { projectSessionInitialAccessEnvelopeHostErrorResult } from '@/session/actions/cliActionDeps/sessionSpawnErrors';

import {
    registerSessionServerStartRpcHandler,
    type SessionServerStartRpcRegistrationOptions,
} from './sessionServerStart';
import { createMachineSessionDirectTargetTransport } from './sessionServerStartLifecycleAdapter';

/** The reserved API consumes creation results while its delegate speaks Action vocabulary. */
function projectActionFailure(failure: ActionExecuteFailure): Extract<SessionSpawnNewResultV1, { type: 'error' }> {
    const cause = failure.failureCause ? { failureCause: failure.failureCause } : {};
    const typed = SessionSpawnNewResultV1Schema.safeParse(failure.details);
    if (typed.success && typed.data.type === 'error') return { ...cause, ...typed.data };
    const unavailable = failure.errorCode === 'target_unavailable'
        ? WorkflowTargetUnavailableDetailsV1Schema.safeParse(failure.details) : null;
    if (unavailable?.success) {
        const { reason } = unavailable.data;
        return { type: 'error', code: 'spawn_failed', retryable: false, ...cause,
            launchError: { kind: 'launch_error', code: reason, message: reason } };
    }
    const code = failure.errorCode === 'invalid_parameters' ? 'invalid_input' : failure.errorCode;
    const accessFailure = projectSessionInitialAccessEnvelopeHostErrorResult({ code });
    if (accessFailure) return { ...cause, ...accessFailure };
    // Unknown Action codes retain the existing launch owner and a code-only
    // preview. Arbitrary Action prose cannot become a launch diagnostic.
    const launchFailure = projectSessionSpawnFailure({ errorCode: code, errorMessage: code });
    const permanent = code === 'invalid_input' || code === 'target_required' || code === 'target_unavailable'
        || code === 'incompatible_target' || code === 'organization_invalid' || code === 'creation_conflict'
        || code === 'permission_denied';
    const direct = SessionSpawnNewResultV1Schema.safeParse({ type: 'error', code, ...cause,
        retryable: permanent ? false : launchFailure.retryable });
    return direct.success && direct.data.type === 'error' ? direct.data : { ...cause, ...launchFailure };
}

export type MachineSessionServerStartRpcRegistrationOptions = Readonly<{
    machineId: string;
    readMachineMetadataSnapshot?: SessionSpawnDirectTargetTransport['readMachineMetadataSnapshot'];
    token: string;
    readCredentials: () => Promise<StoredCredentials | null>;
    resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
    resolveInstallationId: () => string | null | Promise<string | null>;
    resolveAccountEncryptionCurrentness:
        SessionServerStartRpcRegistrationOptions['resolveAccountEncryptionCurrentness'];
    spawnLifecycleHandler: SessionLifecycleActionHandler;
    resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
    machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
    sessionCreationInstallation?: Pick<CurrentMachineInstallation['identity'], 'installationId' | 'privateKey'>;
    machineAdmissionTransport?: NonNullable<
        Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
    >;
}>;

/**
 * Binds the reserved receiver to the same V2 Action owner used by ordinary
 * creation, replacing only its exact-machine transport with direct daemon
 * lifecycle calls. This prevents a target daemon from routing its own start
 * back through the Socket ingress it is currently servicing.
 */
export function registerMachineSessionServerStartRpcHandler(
    rpc: Parameters<typeof registerSessionServerStartRpcHandler>[0],
    options: MachineSessionServerStartRpcRegistrationOptions,
): SessionSpawnDirectTargetTransport {
    const directTargetTransport = createMachineSessionDirectTargetTransport({
        machineId: options.machineId,
        ...(options.readMachineMetadataSnapshot ? { readMachineMetadataSnapshot: options.readMachineMetadataSnapshot } : {}),
        spawnLifecycleHandler: options.spawnLifecycleHandler,
        ...(options.resolveSpawnSessionByNonce
            ? { resolveSpawnSessionByNonce: options.resolveSpawnSessionByNonce }
            : {}),
    });
    registerSessionServerStartRpcHandler(rpc, {
        machineId: options.machineId,
        resolveAccountId: options.resolveAccountId,
        resolveInstallationId: options.resolveInstallationId,
        resolveAccountEncryptionCurrentness:
            options.resolveAccountEncryptionCurrentness,
        resolveAccountEncryptionMaterial: async (signal) => {
            if (signal?.aborted) return null;
            let credentials: StoredCredentials | null;
            try {
                credentials = await options.readCredentials();
            } catch {
                return null;
            }
            if (signal?.aborted || !credentials || credentials.token !== options.token) return null;
            return createAutomationAccountEncryptionMaterialSnapshotV1(credentials);
        },
        executeSessionStart: async (input, context) => {
            let credentials: StoredCredentials | null;
            try {
                credentials = await options.readCredentials();
            } catch (error) {
                return context.signal.aborted
                    ? { type: 'error', code: 'cancelled', retryable: true }
                    : { type: 'error', code: 'spawn_failed', retryable: true,
                        failureCause: projectActionFailureCauseV1(error, 'session.target_preparation') };
            }
            if (!credentials || credentials.token !== options.token) {
                return { type: 'error', code: 'permission_denied', retryable: false };
            }
            if (context.signal.aborted) {
                return { type: 'error', code: 'cancelled', retryable: true };
            }
            const executor = createCliActionExecutorFromCredentials({
                credentials,
                machineId: options.machineId,
                sessionSpawnDirectTargetTransport: directTargetTransport,
                ...(options.machineActionDirectTargetTransport
                    ? { machineActionDirectTargetTransport: options.machineActionDirectTargetTransport } : {}),
                ...(options.sessionCreationInstallation ? {
                    externalActionMachineInstallationId: options.sessionCreationInstallation.installationId,
                    externalActionMachineRequestPrivateKey: options.sessionCreationInstallation.privateKey,
                } : {}),
                ...(options.machineAdmissionTransport
                    ? { machineAdmissionTransport: options.machineAdmissionTransport }
                    : {}),
            });
            try {
                const execution = await executor.execute('session.spawn_new', projectSessionSpawnNewActionInputV2(input), {
                    surface: 'cli',
                    authority: 'account_automation',
                    actionCaller: context.actionCaller,
                    signal: context.signal,
                });
                if (!execution.ok) {
                    return projectActionFailure(execution);
                }
                const result = SessionSpawnNewActionResultV1Schema.safeParse(execution.result);
                return result.success
                    ? SessionServerStartDispatchResultV1Schema.parse(readSessionSpawnNewActionResultV1(result.data))
                    : { type: 'error', code: 'spawn_failed', retryable: true };
            } catch {
                return context.signal.aborted
                    ? { type: 'error', code: 'cancelled', retryable: true }
                    : { type: 'error', code: 'spawn_failed', retryable: true };
            }
        },
    });
    return directTargetTransport;
}
