import type { BrowserRecordingAttachAdapter } from './runtimeAttachExecutor';

type BrowserRecordingAttachRegistration = Readonly<{
    token: symbol;
    adapter: BrowserRecordingAttachAdapter;
}>;

/**
 * UX-7: keyed by `${browserSessionId}:${viewId}` so each live view owns its own recording-attach
 * slot. The previous registry held a single unkeyed slot — a second view's owner overwrote the
 * first (cross-view misrouting). A `Map` lets every mounted view coexist.
 *
 * The `browser.recording.attachToComposer` action input is recording-scoped (`recordingId`), not
 * view-scoped, so the resolve site cannot always supply a view key yet (threading a view key onto
 * the recording action is the recording family's contract change, BA-5). Until then `read()` with no
 * key resolves the SOLE registered owner deterministically and returns null when ambiguous, so we
 * fail closed instead of misrouting.
 */
const registrations = new Map<string, BrowserRecordingAttachRegistration>();

function registryKey(input: Readonly<{ browserSessionId: string; viewId: string }>): string {
    return `${input.browserSessionId}:${input.viewId}`;
}

/**
 * Registers the active UI recording-attach adapter (the recording-state owner that applies
 * `attachBrowserRecordingToComposer`). The default runtime action executor resolves through this
 * registry so the `browser.recording.attachToComposer` action dispatches to a real owner instead of
 * failing closed.
 */
export function registerBrowserRecordingAttachAdapter(
    input: Readonly<{
        browserSessionId: string;
        viewId: string;
        adapter: BrowserRecordingAttachAdapter;
    }>,
): () => void {
    const token = Symbol('browserRecordingAttachAdapter');
    const key = registryKey(input);
    registrations.set(key, { token, adapter: input.adapter });
    return () => {
        if (registrations.get(key)?.token === token) {
            registrations.delete(key);
        }
    };
}

export function readRegisteredBrowserRecordingAttachAdapter(
    input?: Readonly<{ browserSessionId: string; viewId: string }>,
): BrowserRecordingAttachAdapter | null {
    if (input) {
        return registrations.get(registryKey(input))?.adapter ?? null;
    }
    // No view key available (recording-attach action input is recordingId-scoped, not view-scoped):
    // resolve the sole owner deterministically; null when ambiguous so we never silently misroute.
    if (registrations.size === 1) {
        const [only] = registrations.values();
        return only?.adapter ?? null;
    }
    return null;
}

export function clearBrowserRecordingAttachRegistryForTests(): void {
    registrations.clear();
}
