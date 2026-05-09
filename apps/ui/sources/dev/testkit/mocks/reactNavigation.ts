import * as React from 'react';

export type CreateReactNavigationNativeMockOptions = Readonly<{
    isFocused?: boolean;
}>;

export function createReactNavigationNativeMock(options: CreateReactNavigationNativeMockOptions = {}) {
    const isFocused = options.isFocused ?? true;

    return {
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        useIsFocused: () => isFocused,
        useFocusEffect: (effect: () => void | (() => void)) => {
            React.useEffect(() => effect(), [effect]);
        },
    };
}
