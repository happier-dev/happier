import * as React from 'react';

export type NewSessionBackgroundLaunchSnapshot = Readonly<{
    /** Launches handed to the background and not yet settled. */
    starting: number;
    /** The latest settled: its Session to open, or the failure and the draft that kept its text. */
    latest:
        | Readonly<{ kind: 'started'; href: string }>
        | Readonly<{ kind: 'failed'; message: string; draftId: string | null }>
        | null;
}>;

const EMPTY: NewSessionBackgroundLaunchSnapshot = Object.freeze({ starting: 0, latest: null });
let snapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: NewSessionBackgroundLaunchSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

/**
 * One owner for what a composer says about launches that left it behind: the Docked host's last started
 * Session and every other surface read this. Nothing persists, because the Session list and the retained
 * draft already outlive a restart.
 */
export const newSessionBackgroundLaunches = {
    begin(): void {
        publish({ ...snapshot, starting: snapshot.starting + 1 });
    },
    started(href: string): void {
        publish({ starting: Math.max(0, snapshot.starting - 1), latest: { kind: 'started', href } });
    },
    /** A Session this composer presented in place, with no background launch to settle. */
    presented(href: string): void {
        publish({ ...snapshot, latest: { kind: 'started', href } });
    },
    /**
     * A launch that already presented its Session keeps that Session as the receipt: the Session's own
     * start-failure banner and first message say why it did not start.
     */
    failed(message: string, draftId: string | null, presentedHref: string | null = null): void {
        publish({ starting: Math.max(0, snapshot.starting - 1),
            latest: presentedHref ? { kind: 'started', href: presentedHref } : { kind: 'failed', message, draftId } });
    },
    /** The launch ended without an outcome to report (its Account or draft went away). */
    ended(): void {
        publish({ ...snapshot, starting: Math.max(0, snapshot.starting - 1) });
    },
    dismiss(): void {
        if (snapshot.latest) publish({ ...snapshot, latest: null });
    },
    resetForTests(): void {
        snapshot = EMPTY;
        listeners.clear();
    },
    read: (): NewSessionBackgroundLaunchSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
};

export function useNewSessionBackgroundLaunches(): NewSessionBackgroundLaunchSnapshot {
    return React.useSyncExternalStore(newSessionBackgroundLaunches.subscribe, newSessionBackgroundLaunches.read, newSessionBackgroundLaunches.read);
}
