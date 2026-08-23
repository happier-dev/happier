import type { SessionLifecycleActionHandler } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import type { SpawnSessionNonceResolver } from '@/session/services/awaitSpawnedSessionId';
import type { DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';

export type MachineSessionServerStartSpawnLifecycleTransportOptions = Readonly<{
    spawnLifecycleHandler: SessionLifecycleActionHandler;
    resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
}>;

export type MachineSessionDirectTargetTransportOptions = Readonly<{
    machineId: string;
    spawnLifecycleHandler: SessionLifecycleActionHandler;
    resolveSpawnSessionByNonce?: SpawnSessionNonceResolver;
}>;

function hasCommittedSessionIdentity(result: unknown): boolean {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const candidate = result as Readonly<{ type?: unknown; sessionId?: unknown }>;
    return candidate.type === 'success'
        && typeof candidate.sessionId === 'string'
        && candidate.sessionId.trim().length > 0;
}

/**
 * The server-origin receiver replaces only the exact-machine transport. The
 * canonical Session lifecycle handler remains the sole create-or-rejoin owner.
 */
export function createMachineSessionServerStartSpawnLifecycleTransport(
    options: MachineSessionServerStartSpawnLifecycleTransportOptions,
): DirectSpawnedSessionTransport {
    return {
        spawn: async (request, spawnOptions) => {
            spawnOptions?.signal?.throwIfAborted();
            const result = await options.spawnLifecycleHandler(request);
            // A nonblank identity from the canonical lifecycle owner is
            // already a committed Session fact. Let the existing Session
            // settlement preserve it and report a cancelled initial input
            // nested beneath that success; cancellation before commitment
            // remains authoritative.
            if (!hasCommittedSessionIdentity(result)) {
                spawnOptions?.signal?.throwIfAborted();
            }
            return result;
        },
        resolveSpawnSessionByNonce: async (spawnNonce, resolveOptions) => {
            resolveOptions?.signal?.throwIfAborted();
            const result = options.resolveSpawnSessionByNonce
                ? await options.resolveSpawnSessionByNonce(spawnNonce)
                : { status: 'unsupported' as const };
            resolveOptions?.signal?.throwIfAborted();
            return result;
        },
    };
}

/**
 * The exact-daemon transport is shared by the server-origin receiver and
 * host-stamped local Action ingress. It replaces only the transport beneath
 * the canonical Session Action owner; target normalization and lifecycle
 * authority remain there.
 */
export function createMachineSessionDirectTargetTransport(
    options: MachineSessionDirectTargetTransportOptions,
): SessionSpawnDirectTargetTransport {
    return {
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
}
