import * as React from 'react';
import { readExecutionRunLauncherComparisonReview } from '@/components/sessions/runs/launcher/useExecutionRunLauncherDraft';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    getSessionDraftSnapshot,
    readSessionLauncherDraftKeysFromDraft,
    readSessionLauncherDraftPreviewFromDraft,
    subscribeSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

const NONE: readonly string[] = Object.freeze([]);

/** The Session's one draft, read for the active Account: where every launcher draft lives. */
function useSessionLauncherDraftSource(input: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const binding = useServerCredentialAccountScopeBinding(input.serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const address = React.useMemo(() => ({ kind: 'session' as const, sessionId: input.sessionId }), [input.sessionId]);
    const subscribe = React.useCallback(
        (listener: () => void) => (scope ? subscribeSessionDraft(scope, address, listener) : () => undefined),
        [address, scope],
    );
    return { scope, address, subscribe };
}

/**
 * The launcher drafts this Session still holds unsent text for, read from its one draft owner so a
 * start nobody has open (a phone's Run page, a closed tab) stays findable from Work.
 */
export function useSessionRetainedLauncherDraftKeys(input: Readonly<{ sessionId: string; serverId?: string | null }>): readonly string[] {
    const { scope, address, subscribe } = useSessionLauncherDraftSource(input);
    const lastRef = React.useRef<{ document: unknown; keys: readonly string[] }>({ document: null, keys: NONE });
    const read = React.useCallback((): readonly string[] => {
        if (!scope) return NONE;
        const document = getSessionDraftSnapshot(scope, address)?.document ?? null;
        if (lastRef.current.document === document) return lastRef.current.keys;
        const next = readSessionLauncherDraftKeysFromDraft(document);
        const previous = lastRef.current.keys;
        // Keep the reference while the keys are equal, so typing in a launcher does not re-render Work.
        const keys = next.length === previous.length && next.every((key, index) => key === previous[index])
            ? previous
            : next.length === 0 ? NONE : next;
        lastRef.current = { document, keys };
        return keys;
    }, [address, scope]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * The first line of one launcher draft's unsent text, for its Work row to say what the draft is. A
 * string, so the row that shows it re-renders as that text changes and the rest of Work does not.
 */
export function useSessionLauncherDraftPreview(input: Readonly<{ sessionId: string; serverId?: string | null; draftKey: string }>): string {
    const { scope, address, subscribe } = useSessionLauncherDraftSource(input);
    const read = React.useCallback((): string => (
        scope ? readSessionLauncherDraftPreviewFromDraft(getSessionDraftSnapshot(scope, address)?.document, input.draftKey) : ''
    ), [address, input.draftKey, scope]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Read on open, from the current Account's same retained draft; no second context store. */
export function useReadRetainedComparisonReviewDraft(input: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const { scope, address } = useSessionLauncherDraftSource(input);
    return React.useCallback((draftKey: string) => scope ? readExecutionRunLauncherComparisonReview(
        getSessionDraftSnapshot(scope, address)?.document ?? null, draftKey) : null, [address, scope]);
}
