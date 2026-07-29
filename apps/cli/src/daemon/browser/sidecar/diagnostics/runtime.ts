import {
    BrowserAdapterCapabilitiesV1Schema,
    type BrowserAdapterCapabilitiesV1,
    type BrowserDiagnosticFamilyV1,
} from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import type {
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarCdpPageHandle,
    BrowserSidecarViewLifecycleEvent,
    BrowserSidecarViewLifecycleSubscriber,
} from '../controlAdapter';
import { createBrowserSidecarDiagnosticsEventSourceBridge } from './eventSource';
import { createSidecarCdpDiagnosticsEventSource } from './cdpEventSource';

/**
 * The diagnostics families a CDP sidecar feeds live. The product Chromium sidecar reports `cdp`
 * fidelity for each, which is what the bridge requires before it will start a source.
 */
const SIDECAR_CDP_DIAGNOSTIC_FAMILIES: readonly BrowserDiagnosticFamilyV1[] = [
    'network',
    'console',
    'pageError',
    'pageInfo',
];

const SIDECAR_CDP_DIAGNOSTICS_CAPABILITIES: BrowserAdapterCapabilitiesV1 = BrowserAdapterCapabilitiesV1Schema.parse({
    adapterKind: 'chromiumSidecar',
    supportedTargetKinds: ['externalUrl'],
    diagnosticsFidelityByFamily: {
        network: 'cdp',
        console: 'cdp',
        pageError: 'cdp',
        pageInfo: 'cdp',
    },
});

// openView establishes a view at the initial navigation generation (the automation service and the
// context routes both anchor at 0). Per-navigation generation progression is a live-session concern.
const INITIAL_NAVIGATION_GENERATION = 0;

type SidecarCdpDiagnosticsContextCapture = Readonly<{
    transport: Readonly<{
        dispatchPageCommand(input: BrowserSidecarCdpPageHandle & Readonly<{
            method: string;
            params?: Record<string, unknown>;
        }>): Promise<unknown>;
    }>;
    resolvePageHandle(view: Readonly<{ browserSessionId: string; viewId: string }>): BrowserSidecarCdpPageHandle | null;
    subscribeCdpEvents(listener: BrowserSidecarCdpEventSubscriber): () => void;
    subscribeViewLifecycle(listener: BrowserSidecarViewLifecycleSubscriber): () => void;
}>;

export type SidecarCdpDiagnosticsRuntimeInput = Readonly<{
    ownerAccountId: string;
    store: Pick<BrowserDiagnosticsDaemonStore, 'publishEvent' | 'clearView' | 'clearSession'>;
    contextCapture: SidecarCdpDiagnosticsContextCapture;
    /** Live `browser.diagnostics` gate; re-read at attach and per event for fail-closed publication. */
    isEnabled: () => boolean;
    nowMs?: () => number;
    onError?: (error: unknown) => void;
}>;

export type SidecarCdpDiagnosticsRuntime = Readonly<{
    dispose(): void;
}>;

/**
 * Production wiring of the live CDP → diagnostics lane. It bridges the SAME live CDP transport (event
 * stream) into the daemon diagnostics store/ring publish path, per bound view. A per-view event
 * source is started the moment the control adapter binds a view (openView) and stopped on unbind
 * (closeView). Built ONLY when `browser.diagnostics` is enabled AND the sidecar exposes the live CDP
 * event surface; otherwise it is never constructed and the ring stays empty (honest fail-closed).
 */
export function createSidecarCdpDiagnosticsRuntime(
    input: SidecarCdpDiagnosticsRuntimeInput,
): SidecarCdpDiagnosticsRuntime {
    const bridge = createBrowserSidecarDiagnosticsEventSourceBridge({
        ownerAccountId: input.ownerAccountId,
        store: input.store,
        nowMs: input.nowMs ?? (() => Date.now()),
    });
    let sourceSequence = 0;

    function attachView(view: Pick<BrowserSidecarViewLifecycleEvent, 'browserSessionId' | 'viewId'>): void {
        // Fail-closed at bind time: a server-disabled gate yields no source and no unavailable spam.
        // A later gate flip is handled per event inside the source.
        if (!input.isEnabled()) return;
        const pageHandle = input.contextCapture.resolvePageHandle(view);
        if (!pageHandle) return;

        sourceSequence += 1;
        const source = createSidecarCdpDiagnosticsEventSource({
            sourceId: `sidecar_cdp_diag_${view.viewId}_${sourceSequence}`,
            pageHandle,
            transport: {
                dispatchPageCommand: input.contextCapture.transport.dispatchPageCommand,
                subscribeCdpEvents: input.contextCapture.subscribeCdpEvents,
            },
            isEnabled: input.isEnabled,
            ...(input.nowMs ? { now: input.nowMs } : {}),
            ...(input.onError ? { onError: input.onError } : {}),
        });

        bridge.attachView({
            requesterAccountId: input.ownerAccountId,
            browserSessionId: view.browserSessionId,
            viewId: view.viewId,
            navigationGeneration: INITIAL_NAVIGATION_GENERATION,
            adapterCapabilities: SIDECAR_CDP_DIAGNOSTICS_CAPABILITIES,
            featureEnabled: input.isEnabled(),
            policyAllowed: true,
            source,
            families: SIDECAR_CDP_DIAGNOSTIC_FAMILIES,
        });
    }

    const unsubscribeLifecycle = input.contextCapture.subscribeViewLifecycle((event) => {
        if (event.type === 'bound') {
            attachView(event);
            return;
        }
        bridge.closeView({ browserSessionId: event.browserSessionId, viewId: event.viewId });
    });

    return {
        dispose() {
            unsubscribeLifecycle();
            bridge.dispose();
        },
    };
}
