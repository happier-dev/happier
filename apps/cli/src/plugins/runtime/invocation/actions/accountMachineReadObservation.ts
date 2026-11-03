import { randomUUID } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk';
import { DaemonPluginUiResourceWatchOpenRequestSchema, DaemonPluginUiResourceWatchOpenResponseSchema,
    DaemonPluginUiResourceWatchNextRequestSchema, DaemonPluginUiResourceWatchNextResponseSchema,
    DaemonPluginUiResourceWatchCloseRequestSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { DaemonPluginStructuredMessageActionExecuteRequest } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import type { StoredCredentials } from '@/persistence';
import type { InvokeContributedAction, ContributedActionInvocationResult } from '../services/actions';

/** Consumes the incumbent daemon demand stream; a transport gap retires this exact observation. */
export async function observeAccountMachineActionRead(input: Readonly<{
    credentials: StoredCredentials;
    serverUrl: string;
    machineId: string;
    targetPluginId: string;
    request: DaemonPluginStructuredMessageActionExecuteRequest;
    signal: AbortSignal;
    observation: NonNullable<Parameters<InvokeContributedAction>[0]['readObservation']>;
}>): Promise<ContributedActionInvocationResult> {
    const subscriptionId = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const transport = { credentials: input.credentials, serverUrl: input.serverUrl, machineId: input.machineId,
        authorityCeiling: 'account_automation' as const, requireCurrentMachine: true };
    const watch = { machineId: input.machineId, callerPluginId: input.targetPluginId, subscriptionId,
        expectedCallerOccurrenceId: input.request.expectedContributorOccurrenceId };
    let disposed = false;
    let cleanup: Promise<void> | undefined;
    const dispose = () => {
        if (disposed) return cleanup;
        disposed = true;
        input.signal.removeEventListener('abort', onAbort);
        controller.abort();
        cleanup = callExactMachineRpc({ ...transport, method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
            request: DaemonPluginUiResourceWatchCloseRequestSchema.parse({ machineId: input.machineId,
                callerPluginId: input.targetPluginId, subscriptionId }) }).then(() => {}, () => {
                // Exact-daemon close is best effort; its existing idle reclamation owns an unreachable peer.
            });
        return cleanup;
    };
    const onAbort = () => { void dispose(); };
    const unavailable = (code: string): ContributedActionInvocationResult => ({ status: 'unavailable', code,
        message: 'The selected Machine read observation is unavailable', actionHandlerInvocation: 'notStarted' });
    try {
        const opened = DaemonPluginUiResourceWatchOpenResponseSchema.parse(await callExactMachineRpc({ ...transport,
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
            request: DaemonPluginUiResourceWatchOpenRequestSchema.parse({ ...watch, resource: { actionRead: input.request } }),
            timeoutMs: null, waitForResultOnCancel: true, signal }));
        if (!opened.ok) { await dispose(); return unavailable(opened.code); }
        if (opened.subscriptionId !== subscriptionId) {
            await dispose(); return unavailable('plugin_action_read_observation_unavailable');
        }
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { await dispose(); return unavailable('plugin_action_read_observation_unavailable'); }
        input.observation.accept(Object.freeze({ dispose }));
        void (async () => {
            try {
                while (!signal.aborted) {
                    const next = DaemonPluginUiResourceWatchNextResponseSchema.parse(await callExactMachineRpc({ ...transport,
                        method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT,
                        request: DaemonPluginUiResourceWatchNextRequestSchema.parse(watch), timeoutMs: null, signal }));
                    if (signal.aborted) return;
                    if (!next.ok) throw new PluginError({ code: next.code });
                    if (next.status === 'idle') continue;
                    if (next.event.subscriptionId !== subscriptionId || next.event.kind !== 'readInvalidated') {
                        throw new PluginError({ code: 'plugin_action_read_observation_unavailable' });
                    }
                    input.observation.invalidate();
                }
            } catch {
                if (!signal.aborted) {
                    if (input.observation.retire) input.observation.retire();
                    else input.observation.invalidate();
                }
            } finally { await dispose(); }
        })().catch(() => { /* This lifetime has already retired and closed its transport. */ });
        return { status: 'executed', value: null };
    } catch (error) {
        await dispose();
        return unavailable(error instanceof PluginError ? error.code : 'plugin_action_read_observation_unavailable');
    }
}
