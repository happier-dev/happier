import * as React from 'react';

import { useSetting } from '@/sync/store/settingsReadHooks';
import {
    resolveSessionListLayoutChoice,
    type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';

type SessionListLayoutIntentValue = Readonly<{
    choice: SessionListLayoutChoice | null;
    /** Yields the visit intent to an explicit layout choice the person just made. */
    yieldToExplicitChoice: () => void;
}>;

const NO_SESSION_LIST_LAYOUT_INTENT: SessionListLayoutIntentValue = {
    choice: null,
    yieldToExplicitChoice: () => {},
};

const SessionListLayoutIntentContext =
    React.createContext<SessionListLayoutIntentValue>(NO_SESSION_LIST_LAYOUT_INTENT);

/**
 * Declares the initial layout of one hosted visit.
 *
 * Compatibility routes such as `/session/recent` open the canonical Sessions list in
 * a specific arrangement without becoming a second list, a route-specific layout
 * field, or a writer of the Account preference. The intent lives exactly as long as
 * the host stays mounted, so Back restores the stored layout with no settings
 * request and no cross-device change — and it yields the moment the person chooses
 * a layout explicitly, so View options never becomes an inert control.
 */
export function SessionListLayoutIntentProvider(props: Readonly<{
    choice: SessionListLayoutChoice;
    children: React.ReactNode;
}>) {
    const [yieldedFrom, setYieldedFrom] = React.useState<SessionListLayoutChoice | null>(null);
    const yieldToExplicitChoice = React.useCallback(() => {
        setYieldedFrom(props.choice);
    }, [props.choice]);
    const value = React.useMemo<SessionListLayoutIntentValue>(() => ({
        choice: yieldedFrom === props.choice ? null : props.choice,
        yieldToExplicitChoice,
    }), [props.choice, yieldToExplicitChoice, yieldedFrom]);
    return (
        <SessionListLayoutIntentContext.Provider value={value}>
            {props.children}
        </SessionListLayoutIntentContext.Provider>
    );
}

export function useSessionListLayoutIntent(): SessionListLayoutChoice | null {
    return React.useContext(SessionListLayoutIntentContext).choice;
}

/**
 * Lets the one explicit-layout writer retire a visit intent, so the rendered
 * arrangement follows the choice the person just made instead of the host's
 * opening intent.
 */
export function useYieldSessionListLayoutIntent(): () => void {
    return React.useContext(SessionListLayoutIntentContext).yieldToExplicitChoice;
}

/**
 * The one reader of the effective Session-list layout.
 *
 * Every surface that arranges the list — the index builder, the shell chrome and the
 * drag/reorder policy — resolves the same choice here so a host intent and the stored
 * preference cannot disagree between them.
 */
export function useSessionListLayoutChoice(): SessionListLayoutChoice {
    const sessionListLayoutV1 = useSetting('sessionListLayoutV1');
    const transientIntent = useSessionListLayoutIntent();
    return resolveSessionListLayoutChoice({
        sessionListLayoutV1,
    }, transientIntent);
}
