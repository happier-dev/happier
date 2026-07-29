import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import type { BrowserContextDiagnosticsRingBuffer } from './ringBuffer';

/**
 * Tap the daemon diagnostics store's publish + lifecycle path into the offline diagnostics ring
 * buffer WITHOUT mutating the store: the returned store re-exposes the full contract and forwards
 * every method.
 *
 * - `publishEvent` feeds the ring only for accepted, schema-valid events, so the ring inherits the
 *   store's redaction + validation (it never sees raw bodies, cookies, tokens, or storage values).
 * - `clearView` / `clearSession` prune the ring in lockstep with the store. The sidecar diagnostics
 *   bridge already drives `store.clearView` on view close and `store.clearSession` on
 *   session-close/purge/logout; forwarding those two methods here is what keeps closed/purged
 *   diagnostics from lingering in daemon memory (BRW-6 purge posture) rather than accumulating for
 *   the daemon's whole lifetime.
 */
export function tapBrowserDiagnosticsStoreIntoRingBuffer(input: Readonly<{
    store: BrowserDiagnosticsDaemonStore;
    ringBuffer: BrowserContextDiagnosticsRingBuffer;
}>): BrowserDiagnosticsDaemonStore {
    const { store, ringBuffer } = input;
    return {
        ...store,
        publishEvent: (event: BrowserDiagnosticEventV1) => {
            const result = store.publishEvent(event);
            if (result.status === 'accepted') ringBuffer.record(event);
            return result;
        },
        clearView: (clearInput) => {
            ringBuffer.clearView(clearInput);
            store.clearView(clearInput);
        },
        clearSession: (clearInput) => {
            ringBuffer.clearSession(clearInput);
            store.clearSession(clearInput);
        },
    };
}
