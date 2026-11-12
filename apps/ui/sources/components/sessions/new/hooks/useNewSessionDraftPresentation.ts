import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getSessionDraftSnapshot, subscribeSessionDraft, type SessionDraftSnapshot, type SessionDraftStatus } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { selectSessionDraftSyncBadgeStatus } from '@/components/sessions/drafts/sessionDraftStatusPresentation';
import { getSessionDraftDocumentFieldValue } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';

type NewSessionDraftPresentation = Readonly<Pick<SessionDraftSnapshot, 'materialized' | 'conflict'> & {
    /** Only the status the badge shows: `pending` flips with every remote flush of a typing burst. */
    badgeStatus: SessionDraftStatus | null;
    launchUserAttemptId: string | null;
    authoringOrigin: NonNullable<SessionDraftSnapshot['localSupplement']['newSessionLocalState']>['authoringOrigin'];
    /** The item the draft was opened from: its first attached item's label (pasted media is not an item). */
    subjectLabel: string | null;
}>;

function readLabel(presentation: unknown): string | null {
    const label = presentation && typeof presentation === 'object' ? (presentation as { label?: unknown }).label : null;
    return typeof label === 'string' && label.trim().length > 0 ? label : null;
}

function readSubjectLabel(snapshot: SessionDraftSnapshot): string | null {
    const attachments = getSessionDraftDocumentFieldValue(snapshot.document, { kind: 'composer', field: 'attachments' });
    for (const entry of Array.isArray(attachments) ? attachments : []) {
        if (!entry || typeof entry !== 'object' || 'content' in entry) continue;
        const label = readLabel((entry as { presentation?: unknown }).presentation);
        if (label) return label;
    }
    // A seed the mounted composer has not admitted yet already names its item.
    for (const seed of snapshot.localSupplement.newSessionLocalState?.composerAttachmentSeeds ?? []) {
        const label = readLabel(seed.value.presentation);
        if (label) return label;
    }
    return null;
}

/** Draft presentation above the editor is independent of the model's authoring inputs. */
export function useNewSessionDraftPresentation(scope: ServerAccountScope | null, draftId: string): NewSessionDraftPresentation | null {
    const address = React.useMemo(() => ({ kind: 'newSession' as const, draftId }), [draftId]);
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraft(scope, address, listener) : () => undefined
    ), [address, scope]);
    // The repository must publish real text edits to its editor. The surrounding
    // screen needs only chrome/custody facts, never that document or revision.
    const selectPresentation = useShallow((snapshot: SessionDraftSnapshot | null): NewSessionDraftPresentation | null => snapshot ? {
        materialized: snapshot.materialized,
        badgeStatus: selectSessionDraftSyncBadgeStatus(snapshot.status),
        conflict: snapshot.conflict,
        launchUserAttemptId: snapshot.localSupplement.launchUserAttemptId ?? null,
        authoringOrigin: snapshot.localSupplement.newSessionLocalState?.authoringOrigin,
        subjectLabel: readSubjectLabel(snapshot),
    } : null);
    const getSnapshot = React.useCallback(() => selectPresentation(scope ? getSessionDraftSnapshot(scope, address) : null), [address, scope, selectPresentation]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The folded composer's identity and text marker, without subscribing it to every draft edit. */
export function useNewSessionDraftDockPresentation(scope: ServerAccountScope | null, draftId: string | null): Readonly<{ hasText: boolean; isBot: boolean }> {
    const subscribe = React.useCallback((listener: () => void) => (
        scope && draftId ? subscribeSessionDraft(scope, { kind: 'newSession', draftId }, listener) : () => undefined
    ), [draftId, scope]);
    const selectPresentation = useShallow((snapshot: SessionDraftSnapshot | null) => {
        const text = snapshot ? getSessionDraftDocumentFieldValue(snapshot.document, { kind: 'composer', field: 'text' }) : null;
        const facts = snapshot ? getSessionDraftDocumentFieldValue(snapshot.document, { kind: 'authoring', fieldId: 'initialSessionFacts' }) : null;
        return { hasText: typeof text === 'string' && text.trim().length > 0,
            isBot: Boolean(facts && typeof facts === 'object' && 'bot' in facts && facts.bot) };
    });
    const getSnapshot = React.useCallback(() => selectPresentation(scope && draftId
        ? getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }) : null), [draftId, scope, selectPresentation]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
