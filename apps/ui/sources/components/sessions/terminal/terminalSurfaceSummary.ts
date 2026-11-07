import * as React from 'react';

import type { EmbeddedTerminalPaneController, EmbeddedTerminalPaneStatus } from '@/components/terminal/embedded/types';

export type TerminalSurfaceFailure = 'machine-unreachable' | 'connection-lost' | 'failed' | null;

const MACHINE_UNREACHABLE_ERROR = 'terminal_machine_unreachable';

/** One classifier for the retained frame, strip, list and Jump surfaces. */
export function projectTerminalSurfaceFailure(
    controller: Pick<EmbeddedTerminalPaneController, 'status' | 'error' | 'connectionLost' | 'readOnly'>,
): TerminalSurfaceFailure {
    if (controller.status !== 'error') return null;
    if (controller.error === MACHINE_UNREACHABLE_ERROR) return 'machine-unreachable';
    if (controller.connectionLost || controller.readOnly) return 'connection-lost';
    return 'failed';
}

/**
 * What a mounted terminal view last knew about its process, by terminal key: its own title (OSC),
 * its last bell, its connection/exit status and the address it printed. The strip, the list view
 * and Jump read it for tabs that are not on screen, so a hidden tab keeps its last-known name and
 * status instead of going blank. It is view state published by the terminal controller's mounted
 * leaf: no output, nothing persisted, and the daemon stays the process authority.
 */
export type TerminalSurfaceSummary = Readonly<{
    title: string | null;
    /** The last bell not yet seen in a focused view. */
    bell: string | null;
    status: EmbeddedTerminalPaneStatus;
    /** The controller's error code while `status` is `error` (an unreachable machine is not a failed terminal). */
    error: string | null;
    /** Canonical presentation classification shared by every terminal surface. */
    failure: TerminalSurfaceFailure;
    url: string | null;
}>;

const summaries = new Map<string, TerminalSurfaceSummary>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
    version += 1;
    for (const listener of listeners) listener();
}

function sameSummary(a: TerminalSurfaceSummary | undefined, b: TerminalSurfaceSummary): boolean {
    return a !== undefined && a.title === b.title && a.bell === b.bell && a.status === b.status
        && a.error === b.error && a.failure === b.failure && a.url === b.url;
}

/** Called by the mounted leaf when its controller's facts change; notifies only on a real change. */
export function publishTerminalSurfaceSummary(terminalKey: string, next: TerminalSurfaceSummary): void {
    if (sameSummary(summaries.get(terminalKey), next)) return;
    summaries.set(terminalKey, next);
    notify();
}

/** A focused view has shown the bell; the tab stops asking for attention. */
export function acknowledgeTerminalSurfaceBell(terminalKey: string): void {
    const current = summaries.get(terminalKey);
    if (!current || current.bell === null) return;
    summaries.set(terminalKey, { ...current, bell: null });
    notify();
}

/** A closed terminal has no last-known state worth keeping. */
export function forgetTerminalSurfaceSummary(terminalKey: string): void {
    if (summaries.delete(terminalKey)) notify();
}

export function peekTerminalSurfaceSummary(terminalKey: string): TerminalSurfaceSummary | null {
    return summaries.get(terminalKey) ?? null;
}

export function subscribeTerminalSurfaceSummaries(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** One terminal's summary; re-renders only when that terminal's summary changes. */
export function useTerminalSurfaceSummary(terminalKey: string | null): TerminalSurfaceSummary | null {
    const read = React.useCallback(() => (terminalKey ? summaries.get(terminalKey) ?? null : null), [terminalKey]);
    return React.useSyncExternalStore(subscribeTerminalSurfaceSummaries, read, read);
}

/**
 * Several terminals' summaries as one stable array: the same array is returned until one of the
 * requested summaries changes, so a strip of five tabs renders once per real change.
 */
export function useTerminalSurfaceSummaries(terminalKeys: readonly string[]): readonly (TerminalSurfaceSummary | null)[] {
    const cache = React.useRef<{ keys: readonly string[]; version: number; value: readonly (TerminalSurfaceSummary | null)[] } | null>(null);
    const read = React.useCallback(() => {
        const previous = cache.current;
        if (previous && previous.keys === terminalKeys && previous.version === version) return previous.value;
        const value = terminalKeys.map((key) => summaries.get(key) ?? null);
        const reused = previous && previous.value.length === value.length && value.every((item, index) => item === previous.value[index])
            ? previous.value : value;
        cache.current = { keys: terminalKeys, version, value: reused };
        return reused;
    }, [terminalKeys]);
    return React.useSyncExternalStore(subscribeTerminalSurfaceSummaries, read, read);
}
