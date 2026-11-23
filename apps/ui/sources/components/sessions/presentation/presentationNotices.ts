import type * as React from 'react';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

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
export type PresentationNoticeControl = Readonly<{
    /** Already-localized action label, e.g. "Undo". */
    label: string;
    run: () => void;
}>;
export type PresentationNoticeUndo = PresentationNoticeControl;

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
    /** An explicit next step bound by the local publisher to its exact target. */
    action?: PresentationNoticeControl;
    /** Result custody for an inverse whose original surface may already be closed. */
    approval?: ActionApprovalContinuation;
    /** Stays until dismissed, retired by its publisher, or replaced by a newer notice. */
    sticky?: boolean;
}>;

/** Whether the notice host schedules its ordinary presentation lifetime. */
export function shouldSchedulePresentationNoticeRetirement(notice: PresentationNotice | null, controlEngaged: boolean): boolean {
    return notice !== null && notice.sticky !== true && !controlEngaged;
}

// Only plain transient messages remain alongside newer publications. Controls and sticky
// notices use the existing current-notice contract, including exact inverse ownership.
const EMPTY_NOTICES: readonly PresentationNotice[] = [];
let current: readonly PresentationNotice[] = EMPTY_NOTICES;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function publishPresentationNotice(notice: PresentationNotice): void {
    current = [
        ...current.filter((previous) => previous.key !== notice.key
            && !previous.sticky && !previous.undo && !previous.action && !previous.approval),
        notice,
    ];
    emit();
}

/**
 * Retire a notice. Passing the key makes retirement exact: a timer that fires
 * after a newer notice arrived does not clear the newer one.
 */
export function retirePresentationNotice(key?: string): void {
    if (current.length === 0) return;
    const remaining = key === undefined ? EMPTY_NOTICES : current.filter((notice) => notice.key !== key);
    if (remaining.length === current.length) return;
    current = remaining.length > 0 ? remaining : EMPTY_NOTICES;
    emit();
}

export function readPresentationNotice(): PresentationNotice | null {
    return current.at(-1) ?? null;
}

export function readPresentationNotices(): readonly PresentationNotice[] {
    return current;
}

export function subscribePresentationNotices(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
