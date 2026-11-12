import { PluginError } from '@happier-dev/plugin-sdk';
import { raceWithAbort } from '@happier-dev/cli-common/plugins/http';
import type { TargetedContributionManifestDeclaration } from '@happier-dev/cli-common/plugins/registration';
import { DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { StoredCredentials } from '@/persistence';

type SourceRead = Readonly<{ machineId: string; targetPluginId: string; sourcePluginId?: string; signal?: AbortSignal }>;
type AdmittedSources = Readonly<{ revision: string; declarations: readonly TargetedContributionManifestDeclaration[] }>;
type PendingSources = { controller: AbortController; consumers: number; promise: Promise<readonly TargetedContributionManifestDeclaration[]> };

/** One reader per Account registry: every read checks the exact Machine;
 * only changed bodies cross declaration admission again. No timer or push state. */
export function createAccountMachineSourceDeclarationReader(authority: Readonly<{ credentials: StoredCredentials; serverUrl: string }>): (input: SourceRead) => Promise<readonly TargetedContributionManifestDeclaration[]> {
    const admitted = new Map<string, AdmittedSources>();
    const pending = new Map<string, PendingSources>();
    return async (input: SourceRead): Promise<readonly TargetedContributionManifestDeclaration[]> => {
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
                }));
                controller.signal.throwIfAborted();
                if (result.status === 'sourceDeclarationsUnchanged' && result.pluginId === input.targetPluginId
                    && previous && result.sourceRevision === previous.revision) return previous.declarations;
                if (result.status !== 'sourceDeclarations' || result.pluginId !== input.targetPluginId) {
                    throw new PluginError({ code: result.status === 'unavailable' ? result.code : 'plugin_targeted_contributions_unavailable',
                        message: 'Current Machine source declarations are unavailable' });
                }
                if (result.sourceRevision) admitted.set(key, { revision: result.sourceRevision, declarations: result.sourceDeclarations });
                else admitted.delete(key);
                return result.sourceDeclarations;
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
