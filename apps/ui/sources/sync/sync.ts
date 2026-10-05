// The public sync handle stays independent of the implementation's graph:
// Metro retains a separate transitive graph for every requested lazy entry.
// The app entry loads syncEngine once, before Router or background tasks run.
type SyncRuntime = Pick<typeof import('./syncEngine'),
    'sync' | 'syncCreate' | 'syncHydrateLocalState' | 'syncRestore' | 'syncSwitchServer'>;

export type {
    LoadTargetWindowMessagesTarget,
    LoadTargetWindowMessagesOptions,
    LoadTargetWindowMessagesResult,
    SessionViewportSource,
    SessionViewportAnchorKind,
    SessionViewportAnchorSnapshot,
    SessionViewportSnapshot,
    SessionViewportChangeState,
    SyncMessageTransport,
    SendPendingMessageNowResult,
    SendPendingMessageNowDeliveryIntent,
    SessionSystemRecordRuntime,
    SyncEmbedSessionOptions,
    SyncCreateOptions,
    SyncServerTarget,
} from './syncEngine';

export let sync: SyncRuntime['sync'];
let runtime: SyncRuntime | null = null;

/** Only the app-owned implementation publishes the existing singleton here. */
export function registerSyncRuntime(value: SyncRuntime): void {
    runtime = value;
    sync = value.sync;
}

function readRuntime(): SyncRuntime {
    if (!runtime) throw new Error('Sync runtime has not been loaded by the app entry');
    return runtime;
}

export function syncCreate(...args: Parameters<SyncRuntime['syncCreate']>): ReturnType<SyncRuntime['syncCreate']> {
    return readRuntime().syncCreate(...args);
}

export function syncHydrateLocalState(...args: Parameters<SyncRuntime['syncHydrateLocalState']>): ReturnType<SyncRuntime['syncHydrateLocalState']> {
    return readRuntime().syncHydrateLocalState(...args);
}

export function syncRestore(...args: Parameters<SyncRuntime['syncRestore']>): ReturnType<SyncRuntime['syncRestore']> {
    return readRuntime().syncRestore(...args);
}

export function syncSwitchServer(...args: Parameters<SyncRuntime['syncSwitchServer']>): ReturnType<SyncRuntime['syncSwitchServer']> {
    return readRuntime().syncSwitchServer(...args);
}
