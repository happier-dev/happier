import type * as React from 'react';

export type PresentationNoticeSeverity = 'info' | 'warning' | 'error';

/**
 * A caller-owned inverse offered beside the notice.
 *
 * The host renders the control and nothing else: it performs no Board, domain or
 * wire mutation, and it never accepts an executable wire/plugin callback. The
 * publisher binds `run` to its exact target and owns the result. Presentation
 * inverses restore only unchanged fields; remote inverses use the existing
 * audited action owner and surface failures through this notice owner. A replaced
 * notice stops offering its inverse; there is no undo stack or separate lifetime.
 */
export type PresentationNoticeUndo = Readonly<{
    /** Already-localized action label, e.g. "Undo". */
    label: string;
    run: () => void;
}>;

export type PresentationNotice = Readonly<{
    key: string;
    message: string;
    severity: PresentationNoticeSeverity;
    /**
     * The identity mark of what the notice is about (a Session's avatar, a document's glyph), drawn
     * before the message. Presentation only: the host gives it no behaviour.
     */
    leading?: React.ReactNode;
    /** The part of `message` that names its subject; the host sets it in the stronger weight. */
    emphasis?: string;
    undo?: PresentationNoticeUndo;
}>;

/**
 * The app's transient presentation notice owner.
 *
 * `CurrentSessionPresentationRuntime` renders it and is mounted app-globally by
 * `AuthenticatedAppRuntimeMounts`. Until now the notice lived in that
 * component's local state, reachable only from the daemon's
 * `CurrentSessionPresentation` command stream. Mounted plugin UI needs the same
 * outcome for its `notify` host method (§3.4), and UI-T21 forbids a
 * plugin-only notification store — so the state moved out of the component into
 * this module. Committed personal recipient facts also publish here; none of
 * these producers creates a separate queue or notification history.
 *
 * It follows the presentation domain's existing module-store idiom
 * (`sessionComposerPresentationTargets.ts`): a single current value plus
 * listeners, no queue and no scheduler. A newer notice replaces an older one,
 * which is what a single transient notice host can show.
 */
let current: PresentationNotice | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function publishPresentationNotice(notice: PresentationNotice): void {
    current = notice;
    emit();
}

/**
 * Retire a notice. Passing the key makes retirement exact: a timer that fires
 * after a newer notice arrived does not clear the newer one.
 */
export function retirePresentationNotice(key?: string): void {
    if (current === null) return;
    if (key !== undefined && current.key !== key) return;
    current = null;
    emit();
}

export function readPresentationNotice(): PresentationNotice | null {
    return current;
}

export function subscribePresentationNotices(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
