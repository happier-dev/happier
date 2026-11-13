import { isPluginError } from '@happier-dev/plugin-sdk';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { raceWithAbort } from '@happier-dev/cli-common/plugins/http';
import type { TargetedContributionManifestSnapshot } from '@happier-dev/cli-common/plugins/registration';
import { DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectPluginActionFailureCode } from '@happier-dev/protocol/plugins/actions/invocation';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { StoredCredentials } from '@/persistence';

type SourceRead = Readonly<{ machineId: string; targetPluginId: string; sourcePluginId?: string; signal?: AbortSignal }>;
type AdmittedSources = Readonly<{ revision: string; snapshot: TargetedContributionManifestSnapshot }>;
type PendingSources = { controller: AbortController; consumers: number; promise: Promise<TargetedContributionManifestSnapshot> };

/** One reader per Account registry: every read checks the exact Machine;
 * only changed bodies cross declaration admission again. No timer or push state. */
export function createAccountMachineSourceDeclarationReader(authority: Readonly<{ credentials: StoredCredentials; serverUrl: string }>): (input: SourceRead) => Promise<TargetedContributionManifestSnapshot> {
    const admitted = new Map<string, AdmittedSources>();
    const pending = new Map<string, PendingSources>();
    return async (input: SourceRead): Promise<TargetedContributionManifestSnapshot> => {
        input.signal?.throwIfAborted();
        const key = JSON.stringify([input.machineId, input.targetPluginId, input.sourcePluginId]);
        let active = pending.get(key);
        if (!active) {
            const controller = new AbortController();
            const previous = admitted.get(key);
            const promise = (async () => {
                const request = DaemonPluginUiTargetedContributionsReadRequestSchema.parse({ machineId: input.machineId,
                    pluginId: input.targetPluginId, readMode: 'sourceDeclarations',
                    ...(input.sourcePluginId === undefined ? {} : { sourcePluginId: input.sourcePluginId }),
                    ...(previous ? { knownSourceRevision: previous.revision } : {}),
                });
                const result = DaemonPluginUiTargetedContributionsReadResponseSchema.parse(await callExactMachineRpc({
                    ...authority, machineId: input.machineId,
                    method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ, request,
                    requireCurrentMachine: true, timeoutMs: null, signal: controller.signal,
                }).catch((error: unknown) => {
                    if (isPluginError(error)) throw error;
                    // Declaration reads precede handler admission. Preserve the
                    // transport owner's cause instead of inventing origin loss.
                    const cause = readRpcErrorCode(error)
                        ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
                    throw createPluginActionHandlerNotStartedError({ code: projectPluginActionFailureCode(cause) });
                }));
                controller.signal.throwIfAborted();
                if (result.status === 'sourceDeclarationsUnchanged' && result.pluginId === input.targetPluginId
                    && previous && result.sourceRevision === previous.revision) return previous.snapshot;
                if (result.status !== 'sourceDeclarations' || result.pluginId !== input.targetPluginId) {
                    throw createPluginActionHandlerNotStartedError({ code: result.status === 'unavailable' ? result.code : 'plugin_targeted_contributions_unavailable',
                        message: 'Current Machine source declarations are unavailable' });
                }
                const snapshot: TargetedContributionManifestSnapshot = { declarations: result.sourceDeclarations,
                    ...(result.unavailablePlugins === undefined ? {} : { unavailablePlugins: result.unavailablePlugins }) };
                if (result.sourceRevision) admitted.set(key, { revision: result.sourceRevision, snapshot });
                else admitted.delete(key);
                return snapshot;
            })();
            active = { controller, consumers: 0, promise };
            pending.set(key, active);
            const entry = active;
            void promise.then(() => {
                if (pending.get(key) === entry) pending.delete(key);
            }, () => {
                if (pending.get(key) === entry) { pending.delete(key); admitted.delete(key); }
            });
        }
        active.consumers += 1;
        try { return await raceWithAbort(active.promise, input.signal); }
        finally {
            active.consumers -= 1;
            if (active.consumers === 0 && pending.get(key) === active) {
                pending.delete(key);
                active.controller.abort();
            }
        }
    };
}
