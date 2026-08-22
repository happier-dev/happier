import {
    DaemonPluginCollectionCandidatePreparationRequestV1Schema,
    DaemonPluginCollectionCandidatePreparationResponseV1Schema,
    type DaemonPluginCollectionCandidatePreparationResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

export type DaemonPluginCollectionCandidatePreparationTarget = Readonly<{
    serverIdentityId: string;
    machineId: string;
}>;

type CandidatePreparationRuntimeRegistry = Pick<
    ResolvedExecutablePluginRuntimeRegistry,
    | 'prepareCollectionMigrationCandidates'
    | 'retireCollectionMigrationCandidates'
>;

export type DaemonPluginCollectionCandidatePreparationHandlerOptions = Readonly<{
    /** Resolves the receiving daemon's current server/machine route identity. */
    resolveCurrentTarget: (params: Readonly<{ signal?: AbortSignal }>) => Promise<
        DaemonPluginCollectionCandidatePreparationTarget | null
    >;
    /**
     * The existing projection-runtime lease keeps the exact committed runtime
     * alive through callback preparation. It is not a candidate-stage cache.
     */
    acquireRuntimeRegistryLease: () => Promise<Readonly<{
        registry: CandidatePreparationRuntimeRegistry;
        release: () => Promise<void>;
    }>>;
}>;

type UnavailableCode = Extract<
    DaemonPluginCollectionCandidatePreparationResponseV1,
    { kind: 'unavailable' }
>['code'];

function unavailable(code: UnavailableCode): DaemonPluginCollectionCandidatePreparationResponseV1 {
    return DaemonPluginCollectionCandidatePreparationResponseV1Schema.parse({
        version: 1,
        kind: 'unavailable',
        code,
    });
}

function isSameTarget(
    left: DaemonPluginCollectionCandidatePreparationTarget,
    right: DaemonPluginCollectionCandidatePreparationTarget,
): boolean {
    return left.serverIdentityId === right.serverIdentityId
        && left.machineId === right.machineId;
}

/**
 * The daemon-side adapter owns only RPC target currentness and bounded wire
 * results. The runtime registry remains the sole executable-module and
 * Account Data candidate owner.
 */
export function createDaemonPluginCollectionCandidatePreparationHandler(
    options: DaemonPluginCollectionCandidatePreparationHandlerOptions,
) {
    return async (
        value: unknown,
        context?: RpcHandlerContext,
    ): Promise<DaemonPluginCollectionCandidatePreparationResponseV1> => {
        const parsed = DaemonPluginCollectionCandidatePreparationRequestV1Schema.safeParse(value);
        if (!parsed.success) return unavailable('invalid_request');
        const request = parsed.data;
        const signal = context?.signal ?? new AbortController().signal;

        const isRequestCurrent = async (): Promise<boolean> => {
            if (signal.aborted) return false;
            let current: DaemonPluginCollectionCandidatePreparationTarget | null;
            try {
                current = await options.resolveCurrentTarget({ signal });
            } catch {
                return false;
            }
            return !signal.aborted
                && current !== null
                && isSameTarget(current, request.daemonTarget);
        };

        if (signal.aborted) return unavailable('candidate_currentness_changed');
        let currentTarget: DaemonPluginCollectionCandidatePreparationTarget | null;
        try {
            currentTarget = await options.resolveCurrentTarget({ signal });
        } catch {
            return unavailable('daemon_target_unavailable');
        }
        if (signal.aborted) return unavailable('candidate_currentness_changed');
        if (!currentTarget) return unavailable('daemon_target_unavailable');
        if (!isSameTarget(currentTarget, request.daemonTarget)) {
            return unavailable('daemon_target_mismatch');
        }

        let lease: Awaited<ReturnType<
            DaemonPluginCollectionCandidatePreparationHandlerOptions['acquireRuntimeRegistryLease']
        >> | null = null;
        try {
            lease = await options.acquireRuntimeRegistryLease();
            if (request.operation === 'prepare') {
                const prepare = lease.registry.prepareCollectionMigrationCandidates;
                if (!prepare) return unavailable('candidate_preparation_unavailable');
                const result = await prepare({
                    source: request.source,
                    candidate: request.candidate,
                    signal,
                    isRequestCurrent,
                });
                if (result.kind === 'unavailable') return unavailable(result.code);
                return DaemonPluginCollectionCandidatePreparationResponseV1Schema.parse({
                    version: 1,
                    kind: 'prepared',
                    bindings: result.bindings,
                });
            }

            const retire = lease.registry.retireCollectionMigrationCandidates;
            if (!retire) return unavailable('candidate_preparation_unavailable');
            await retire({
                bindings: request.bindings,
                signal,
                isRequestCurrent,
            });
            if (!await isRequestCurrent()) return unavailable('candidate_currentness_changed');
            return DaemonPluginCollectionCandidatePreparationResponseV1Schema.parse({
                version: 1,
                kind: 'retired',
            });
        } catch {
            return unavailable(signal.aborted
                ? 'candidate_currentness_changed'
                : 'candidate_preparation_unavailable');
        } finally {
            try {
                await lease?.release();
            } catch {
                // Lease disposal cannot create a second runtime owner or turn
                // an already-completed bounded response into an uncaught RPC error.
            }
        }
    };
}

export function registerDaemonPluginCollectionCandidatePreparationHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonPluginCollectionCandidatePreparationHandlerOptions,
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_PLUGIN_COLLECTION_CANDIDATE_PREPARATION_EXECUTE,
        createDaemonPluginCollectionCandidatePreparationHandler(options),
    );
}
