import * as React from 'react';

export type SessionResumeAction = () => Promise<boolean>;

const SessionResumeContext = React.createContext<SessionResumeAction | null>(null);

export function SessionResumeProvider(props: {
    onResumeSession: SessionResumeAction;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <SessionResumeContext.Provider value={props.onResumeSession}>
            {props.children}
        </SessionResumeContext.Provider>
    );
}

export function useSessionResumeAction(): SessionResumeAction | null {
    return React.useContext(SessionResumeContext);
}
