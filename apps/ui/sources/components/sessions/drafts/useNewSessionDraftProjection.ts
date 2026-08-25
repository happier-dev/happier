import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeNewSessionDraft,
    type SessionDraftSnapshot,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { NewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';

function hostSignature(snapshot: SessionDraftSnapshot | null): string {
    if (!snapshot || snapshot.address.kind !== 'newSession' || snapshot.document.target.kind !== 'newSession') {
        return 'absent';
    }
    const authoring = snapshot.document.target.authoring as Readonly<Record<string, Readonly<{ mutationId: string }>>>;
    const authoringSignature = Object.entries(authoring)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldId, field]) => `${fieldId}:${field.mutationId}`)
        .join('|');
    return JSON.stringify({
        materialized: snapshot.materialized,
        authoring: authoringSignature,
        conflict: snapshot.conflict,
        localSupplement: snapshot.localSupplement,
    });
}

/**
 * Screen-level New Session projection. Composer-only repository revisions deliberately retain
 * the previous snapshot identity: the prompt leaf observes text separately, while authoring,
 * launch custody, conflict, and materialization changes still rerender their host surfaces.
 */
export function useNewSessionDraftHostSnapshot(
    scope: ServerAccountScope | null,
    draftId: string,
): SessionDraftSnapshot | null {
    const address = React.useMemo(() => ({ kind: 'newSession', draftId } as const), [draftId]);
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraft(scope, address, listener) : () => undefined
    ), [address, scope]);
    const readHostSnapshot = React.useMemo(() => {
        let initialized = false;
        let previousSignature = '';
        let previousSnapshot: SessionDraftSnapshot | null = null;
        return () => {
            const next = scope ? getSessionDraftSnapshot(scope, address) : null;
            const signature = hostSignature(next);
            if (initialized && signature === previousSignature) return previousSnapshot;
            initialized = true;
            previousSignature = signature;
            previousSnapshot = next;
            return next;
        };
    }, [address, scope]);
    return React.useSyncExternalStore(subscribe, readHostSnapshot, readHostSnapshot);
}

/**
 * Keeps the leaf prompt store projected from the repository's canonical merged document without
 * subscribing the complete New Session screen model to each keystroke. During the one
 * ephemeral-to-durable handoff, a real local edit is staged first; otherwise the durable draft
 * is adopted. After that handoff, repository conflict/rebase ordering is the sole authority.
 */
export function useNewSessionDraftPromptProjection(params: Readonly<{
    scope: ServerAccountScope | null;
    draftId: string;
    promptStore: NewSessionPromptStore;
    hasLocalEdit: () => boolean;
    preferInitialPrompt?: boolean;
}>): void {
    const address = React.useMemo(() => ({ kind: 'newSession', draftId: params.draftId } as const), [params.draftId]);

    React.useEffect(() => {
        const scope = params.scope;
        if (!scope) return;
        let isInitialProjection = true;
        const project = () => {
            const snapshot = getSessionDraftSnapshot(scope, address);
            const durableText = snapshot?.document.composer.text.value;
            const localText = params.promptStore.getPrompt();
            if (isInitialProjection && (params.hasLocalEdit() || params.preferInitialPrompt === true) && durableText !== localText) {
                isInitialProjection = false;
                writeNewSessionDraft({
                    scope,
                    draftId: params.draftId,
                    patch: { text: localText },
                    materializationIntent: 'userEdit',
                });
                return;
            }
            isInitialProjection = false;
            if (typeof durableText === 'string') params.promptStore.setPrompt(durableText);
        };
        const unsubscribe = subscribeSessionDraft(scope, address, project);
        project();
        return unsubscribe;
    }, [address, params.draftId, params.hasLocalEdit, params.preferInitialPrompt, params.promptStore, params.scope]);
}
