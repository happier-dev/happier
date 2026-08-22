import type { StoredCredentials } from '@/persistence';
import { SessionServerStartDispatchResultV1Schema } from '@happier-dev/protocol';
import {
    createAutomationAccountEncryptionMaterialSnapshotV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type { SessionLifecycleActionHandler } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import type { SpawnSessionNonceResolver } from '@/session/services/awaitSpawnedSessionId';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';

import {
    registerSessionServerStartRpcHandler,
    type SessionServerStartRpcRegistrationOptions,
} from './sessionServerStart';
import { createMachineSessionServerStartSpawnLifecycleTransport } from './sessionServerStartLifecycleAdapter';

export type MachineSessionServerStartRpcRegistrationOptions = Readonly<{
    machineId: string;
    token: string;
    readCredentials: () => Promise<StoredCredentials | null>;
    resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
    resolveInstallationId: () => string | null | Promise<string | null>;
    resolveAccountEncryptionCurrentness:
        SessionServerStartRpcRegistrationOptions['resolveAccountEncryptionCurrentness'];
    spawnLifecycleHandler: SessionLifecycleActionHandler;
    resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
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
): void {
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
            } catch {
                credentials = null;
            }
            if (!credentials || credentials.token !== options.token) {
                return { type: 'error', code: 'permission_denied', retryable: false };
            }
            if (context.signal.aborted) {
                return { type: 'error', code: 'cancelled', retryable: true };
            }
            const directTargetTransport: SessionSpawnDirectTargetTransport = {
                machineId: options.machineId,
                prepare: async (request, prepareOptions) =>
                    await prepareSessionCreationTarget({
                        request,
                        ...(prepareOptions?.signal ? { signal: prepareOptions.signal } : {}),
                    }),
                spawnedSession: createMachineSessionServerStartSpawnLifecycleTransport({
                    spawnLifecycleHandler: options.spawnLifecycleHandler,
                    ...(options.resolveSpawnSessionByNonce
                        ? { resolveSpawnSessionByNonce: options.resolveSpawnSessionByNonce }
                        : {}),
                }),
            };
            const executor = createCliActionExecutor({
                token: credentials.token,
                credentials,
                sessionId: 'cli-global',
                mode: 'plain',
                ctx: null,
                sessionSpawnDirectTargetTransport: directTargetTransport,
                ...(options.machineAdmissionTransport
                    ? { machineAdmissionTransport: options.machineAdmissionTransport }
                    : {}),
            });
            try {
                const execution = await executor.execute('session.spawn_new', input, {
                    surface: 'cli',
                    actionCaller: context.actionCaller,
                    signal: context.signal,
                });
                if (!execution.ok) {
                    return execution.errorCode === 'invalid_parameters'
                        ? { type: 'error', code: 'invalid_input', retryable: false }
                        : { type: 'error', code: 'spawn_failed', retryable: true };
                }
                const result = SessionServerStartDispatchResultV1Schema.safeParse(execution.result);
                return result.success
                    ? result.data
                    : { type: 'error', code: 'spawn_failed', retryable: true };
            } catch {
                return context.signal.aborted
                    ? { type: 'error', code: 'cancelled', retryable: true }
                    : { type: 'error', code: 'spawn_failed', retryable: true };
            }
        },
    });
}
