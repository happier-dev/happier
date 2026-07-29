import * as React from 'react';

import {
    createBrowserAutomationControlService,
    type BrowserAutomationControlService,
} from '@/sync/domains/browser/automation';
import type { BrowserShellAutomationState } from '@/components/browser/BrowserShell';

export type UseBrowserAutomationRuntimeInput = Readonly<{
    enabled?: boolean;
    nowMs?: () => number;
}>;

/**
 * B-RC7 (dark-model wiring): construct the in-app browser-automation control service for the host
 * and project it as the `browserAutomation` product model. The control service is the single shared
 * owner that both the in-iframe automation owner (registered by `WebIframeEngine`) and the runtime
 * action path (`runtimeActionExecutor` via the host's `runtimeAutomationAdapter`) resolve through.
 *
 * Mirrors `useBrowserDiagnosticsRuntime`: it is gated by the host's `browser.automation` decision so
 * it stays dormant (returns `null`) until the feature is enabled (fail-closed; SEQ-1 GATES already
 * flipped `browser.*` OFF by default, so this never default-opens). The service instance is stable
 * for the lifetime the feature stays enabled so owners and leases survive re-renders.
 */
export function useBrowserAutomationRuntime(
    input: UseBrowserAutomationRuntimeInput,
): BrowserShellAutomationState | null {
    const enabled = input.enabled === true;
    const nowMs = input.nowMs ?? Date.now;
    const nowMsRef = React.useRef(nowMs);
    nowMsRef.current = nowMs;

    const controlServiceRef = React.useRef<BrowserAutomationControlService | null>(null);
    if (enabled && !controlServiceRef.current) {
        controlServiceRef.current = createBrowserAutomationControlService({
            nowMs: () => nowMsRef.current(),
        });
    }
    if (!enabled) {
        controlServiceRef.current = null;
    }

    const controlService = controlServiceRef.current;
    return React.useMemo<BrowserShellAutomationState | null>(
        () => (controlService ? { controlService, enabled: true } : null),
        [controlService],
    );
}
