import type { PluginClientApi, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import {
    ForgeReleaseMountedIntentInputV1Schema, type ForgeReleaseMountedIntentOperationV1,
    type ForgeReleaseMountedIntentResultV1,
} from '@happier-dev/triage-protocol/releases/v1';
import { GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 } from '../../releases/contracts.js';

type Handler = (operation: ForgeReleaseMountedIntentOperationV1, signal: AbortSignal) => Promise<ForgeReleaseMountedIntentResultV1>;
type Binding = { invoke: Handler | null };
const acquire = (scope: PluginEphemeralSharedScope, mountId: string) => scope.acquire<Binding>(`github.release-view.v1:${mountId}`, () => {
    const value: Binding = { invoke: null };
    return { value, dispose: () => { value.invoke = null; } };
});

/** Holds only the live callback, in the host's existing Account/plugin/generation scope. */
export function bindReleaseMountedActionsV1(scope: PluginEphemeralSharedScope, mountId: string, invoke: Handler, signal?: AbortSignal): () => void {
    if (signal?.aborted) return () => {};
    const lease = acquire(scope, mountId);
    if (!lease) return () => {};
    lease.value.invoke = invoke;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', release);
        if (lease.value.invoke === invoke) lease.value.invoke = null;
        lease.release();
    };
    signal?.addEventListener('abort', release, { once: true });
    return release;
}
export async function invokeReleaseMountedActionV1(scope: PluginEphemeralSharedScope, input: unknown, signal: AbortSignal): Promise<ForgeReleaseMountedIntentResultV1> {
    const parsed = ForgeReleaseMountedIntentInputV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'rejected' };
    if (signal.aborted) return { status: 'unavailable' };
    const lease = acquire(scope, parsed.data.mountId);
    if (!lease) return { status: 'unavailable' };
    try { return lease.value.invoke ? await lease.value.invoke(parsed.data.operation, signal) : { status: 'unavailable' }; }
    finally { lease.release(); }
}

/** L03's sole github-forge-native artifact calls this from its client activate export. */
export function activateReleaseClientActionsV1(api: PluginClientApi): void {
    api.actions.register(GITHUB_RELEASE_MOUNTED_ACTION_ID_V1, async (input, context) => context.ephemeralSharedScope === null
        ? { status: 'unavailable' } : await invokeReleaseMountedActionV1(context.ephemeralSharedScope, input, context.signal));
}
