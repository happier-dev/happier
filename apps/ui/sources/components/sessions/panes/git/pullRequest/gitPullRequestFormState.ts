import * as React from 'react';

import type { ScmCreatePrResult } from '@/scm/pullRequests/selectScmCreatePrResult';
import type { ScmOperationErrorCode } from '@happier-dev/protocol/scm';

/**
 * Whether a session's "New pull request" form is open and where it lives (Git lab PR / PRD). The form's
 * *content* is the session draft (`useSessionScmDraft`); this owner holds only the presentation fact, which is
 * ephemeral: closing keeps the draft, and reopening shows the same text.
 */
export type GitPullRequestFormPlacement = 'sidebar' | 'details';
export type GitPullRequestFormState = Readonly<{
    open: boolean;
    /** `null` until the sidebar (the mounted Git section) places a new request. */
    placement: GitPullRequestFormPlacement | null;
}>;

const CLOSED: GitPullRequestFormState = Object.freeze({ open: false, placement: null });

const states = new Map<string, GitPullRequestFormState>();
const listeners = new Map<string, Set<() => void>>();

function keyFor(sessionId: string, serverId: string | null | undefined): string {
    return JSON.stringify([serverId ?? null, sessionId]);
}

function write(key: string, next: GitPullRequestFormState): void {
    const previous = states.get(key) ?? CLOSED;
    if (previous.open === next.open && previous.placement === next.placement) return;
    if (!next.open) states.delete(key);
    else states.set(key, next);
    listeners.get(key)?.forEach((listener) => listener());
}

/** The Create PR action (the header's next step or its menu) asks for the form; the Git section places it. */
export function requestGitPullRequestForm(sessionId: string, serverId?: string | null): void {
    const key = keyFor(sessionId, serverId);
    const current = states.get(key);
    if (current?.open) return;
    write(key, { open: true, placement: null });
}

export function moveGitPullRequestForm(sessionId: string, serverId: string | null | undefined, placement: GitPullRequestFormPlacement): void {
    write(keyFor(sessionId, serverId), { open: true, placement });
}

export function closeGitPullRequestForm(sessionId: string, serverId?: string | null): void {
    write(keyFor(sessionId, serverId), CLOSED);
}

export function readGitPullRequestFormState(sessionId: string, serverId?: string | null): GitPullRequestFormState {
    return states.get(keyFor(sessionId, serverId)) ?? CLOSED;
}

export function useGitPullRequestFormState(sessionId: string, serverId?: string | null): GitPullRequestFormState {
    const key = keyFor(sessionId, serverId);
    const subscribe = React.useCallback((listener: () => void) => {
        let set = listeners.get(key);
        if (!set) {
            set = new Set();
            listeners.set(key, set);
        }
        set.add(listener);
        return () => {
            set?.delete(listener);
        };
    }, [key]);
    const read = React.useCallback(() => states.get(key) ?? CLOSED, [key]);
    return React.useSyncExternalStore(subscribe, read, read);
}

export function resetGitPullRequestFormsForTests(): void {
    states.clear();
    listeners.clear();
}

/** A phone's Details is a pushed route, so the form always opens there; elsewhere the user's setting decides. */
export function resolveGitPullRequestFormPlacement(input: Readonly<{
    setting: 'sidebar' | 'details' | undefined | null;
    phone: boolean;
}>): GitPullRequestFormPlacement {
    if (input.phone) return 'details';
    return input.setting === 'details' ? 'details' : 'sidebar';
}

export type GitPullRequestCreateOutcome =
    | ScmCreatePrResult
    | Readonly<{ kind: 'blocked'; message: string }>;

export type GitPullRequestFormAfterCreate = Readonly<{
    clearDraft: boolean;
    closeForm: boolean;
    created: Readonly<{ number: number | null; url: string }> | null;
    failure: Readonly<{ errorCode?: ScmOperationErrorCode; blocked?: boolean; message: string }> | null;
    openedProviderPage: string | null;
}>;

/** What the form does with a create attempt: a created PR spends the draft; anything else keeps it. */
export function resolveGitPullRequestFormAfterCreate(outcome: GitPullRequestCreateOutcome): GitPullRequestFormAfterCreate {
    switch (outcome.kind) {
        case 'created':
        case 'reused':
            return {
                clearDraft: true,
                closeForm: true,
                created: { number: outcome.number ?? null, url: outcome.url },
                failure: null,
                openedProviderPage: null,
            };
        case 'provider-page':
            return { clearDraft: false, closeForm: false, created: null, failure: null, openedProviderPage: outcome.url };
        case 'failed':
            return {
                clearDraft: false, closeForm: false, created: null,
                failure: { errorCode: outcome.errorCode, message: outcome.message }, openedProviderPage: null,
            };
        case 'blocked':
            return {
                clearDraft: false, closeForm: false, created: null,
                failure: { blocked: true, message: outcome.message }, openedProviderPage: null,
            };
    }
}
