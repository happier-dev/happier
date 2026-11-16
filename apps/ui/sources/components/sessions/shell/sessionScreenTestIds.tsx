import * as React from 'react';
import { View, type ViewProps } from 'react-native';

const SessionScreenTestIdsEnabledContext = React.createContext(true);

export function SessionScreenTestIdsProvider(props: Readonly<{ enabled: boolean; children: React.ReactNode }>) {
    return (
        <SessionScreenTestIdsEnabledContext.Provider value={props.enabled}>
            {props.children}
        </SessionScreenTestIdsEnabledContext.Provider>
    );
}

export function useSessionScreenTestIdsEnabled(): boolean {
    return React.useContext(SessionScreenTestIdsEnabledContext);
}

export function useOptionalSessionScreenTestId(id: string): string | undefined {
    return useSessionScreenTestIdsEnabled() ? id : undefined;
}

export function resolveOptionalSessionScreenTestId(enabled: boolean, id: string): string | undefined {
    return enabled ? id : undefined;
}

/**
 * A View carrying a Session-screen test ID. The ID follows screen focus here, at the one node that carries it,
 * so the component drawing this View does not render when focus moves.
 */
export function SessionScreenTestIdView(props: ViewProps & Readonly<{ sessionScreenTestId: string }>) {
    const { sessionScreenTestId, ...viewProps } = props;
    return <View {...viewProps} testID={useOptionalSessionScreenTestId(sessionScreenTestId)} />;
}
