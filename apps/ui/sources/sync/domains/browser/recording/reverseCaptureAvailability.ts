import * as React from 'react';
import type { BrowserRecordingCaptureKindV1 } from '@happier-dev/protocol';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';

const registeredMachineCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function normalizeMachineId(machineId: string | null | undefined): string | null {
    const normalized = machineId?.trim();
    return normalized && normalized.length > 0 ? normalized : null;
}

function emitChange(): void {
    for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function registerDesktopBrowserRecordingReverseCaptureHandler(machineId: string): () => void {
    const normalized = normalizeMachineId(machineId);
    if (!normalized) return () => {};
    registeredMachineCounts.set(normalized, (registeredMachineCounts.get(normalized) ?? 0) + 1);
    emitChange();
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        const count = registeredMachineCounts.get(normalized) ?? 0;
        if (count <= 1) {
            registeredMachineCounts.delete(normalized);
        } else {
            registeredMachineCounts.set(normalized, count - 1);
        }
        emitChange();
    };
}

export function hasDesktopBrowserRecordingReverseCaptureHandler(
    machineId: string | null | undefined,
): boolean {
    const normalized = normalizeMachineId(machineId);
    return normalized ? (registeredMachineCounts.get(normalized) ?? 0) > 0 : false;
}

export function useDesktopBrowserRecordingReverseCaptureHandler(
    machineId: string | null | undefined,
): boolean {
    return React.useSyncExternalStore(
        subscribe,
        () => hasDesktopBrowserRecordingReverseCaptureHandler(machineId),
        () => false,
    );
}

export function browserViewCanUseNativeViewCapture(view: BrowserControlViewState): boolean {
    return view.target.kind === 'externalUrl'
        && view.adapterKind === 'externalUrl'
        && view.engineKind === 'desktopWebView';
}

export function isBrowserRecordingCaptureSourceAvailable(input: Readonly<{
    view: BrowserControlViewState;
    captureKind: BrowserRecordingCaptureKindV1;
    nativeViewCaptureHandlerRegistered: boolean;
}>): boolean {
    if (input.captureKind !== 'nativeViewCapture') return false;
    return input.nativeViewCaptureHandlerRegistered
        && browserViewCanUseNativeViewCapture(input.view);
}
