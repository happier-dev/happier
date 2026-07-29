import type { BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from './store';

export type BrowserDiagnosticsRoutes = Readonly<{
    getSnapshot(): Promise<BrowserDiagnosticsSnapshotV1>;
}>;

export function createBrowserDiagnosticsRoutes(input: Readonly<{
    store: Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot'>;
}>): BrowserDiagnosticsRoutes {
    return {
        async getSnapshot() {
            return input.store.getSnapshot();
        },
    };
}
