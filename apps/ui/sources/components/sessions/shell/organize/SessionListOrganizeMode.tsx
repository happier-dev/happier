import * as React from 'react';

import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';

/**
 * Phone "Organize list" mode (DnD lab K1): the one intentional moment a phone list drags. Rows show
 * grips and swipe/long-press step aside until Done. It is transient list state for this mounted list,
 * never a preference, and exists only where the primary pointer is a finger (desktop rows carry
 * themselves).
 */
export type SessionListOrganizeMode = Readonly<{
    available: boolean;
    active: boolean;
    enter: () => void;
    exit: () => void;
}>;

const INERT: SessionListOrganizeMode = Object.freeze({
    available: false,
    active: false,
    enter: () => undefined,
    exit: () => undefined,
});

const SessionListOrganizeModeContext = React.createContext<SessionListOrganizeMode>(INERT);

export function SessionListOrganizeModeProvider(props: React.PropsWithChildren): React.ReactElement {
    const available = isTouchPrimaryPointer();
    const [active, setActive] = React.useState(false);
    const enter = React.useCallback(() => setActive(true), []);
    const exit = React.useCallback(() => setActive(false), []);
    const value = React.useMemo<SessionListOrganizeMode>(
        () => (available ? { available, active, enter, exit } : INERT),
        [active, available, enter, exit],
    );
    return <SessionListOrganizeModeContext.Provider value={value}>{props.children}</SessionListOrganizeModeContext.Provider>;
}

export function useSessionListOrganizeMode(): SessionListOrganizeMode {
    return React.useContext(SessionListOrganizeModeContext);
}
