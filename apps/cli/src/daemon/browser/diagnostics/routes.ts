import type { BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from './store';
import type { BrowserDiagnosticsRequestDetailV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserDiagnosticsRequestDetailInput } from '../sidecar/diagnostics/requestDetails';

type ViewReadInput = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    sinceRevision?: number;
    signal?: AbortSignal;
}>;

export type BrowserDiagnosticsRoutes = Readonly<{
    getSnapshot(): Promise<BrowserDiagnosticsSnapshotV1>;
    readViewSnapshot(input: ViewReadInput): Promise<Readonly<{ snapshot: BrowserDiagnosticsSnapshotV1; revision: number }>>;
    readRequestDetail?(input: BrowserDiagnosticsRequestDetailInput): Promise<BrowserDiagnosticsRequestDetailV1>;
}>;

export function createBrowserDiagnosticsRoutes(input: Readonly<{
    store: BrowserDiagnosticsDaemonStore;
    readRequestDetail?: (input: BrowserDiagnosticsRequestDetailInput) => Promise<BrowserDiagnosticsRequestDetailV1>;
}>): BrowserDiagnosticsRoutes {
    return {
        readRequestDetail: input.readRequestDetail,
        async getSnapshot() {
            return input.store.getSnapshot();
        },
        async readViewSnapshot(view) {
            if (view.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (view.sinceRevision !== undefined && input.store.getViewRevision(view) === view.sinceRevision) {
                await new Promise<void>((resolve, reject) => {
                    const cleanup = () => { unsubscribe(); view.signal?.removeEventListener('abort', abort); };
                    const changed = () => {
                        if (input.store.getViewRevision(view) === view.sinceRevision) return;
                        cleanup(); resolve();
                    };
                    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
                    const unsubscribe = input.store.subscribeView(view, changed);
                    view.signal?.addEventListener('abort', abort, { once: true });
                    if (view.signal?.aborted) abort();
                    else changed();
                });
            }
            const snapshot = input.store.getViewSnapshot(view);
            return { revision: input.store.getViewRevision(view), snapshot: {
                ...snapshot, events: snapshot.events.filter(event => event.navigationGeneration === view.navigationGeneration),
            } };
        },
    };
}
