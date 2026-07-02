import * as React from 'react';
import type { SharedValue } from 'react-native-reanimated';

export type ComposerKeyboardLayout = Readonly<{
    availablePanelHeight: SharedValue<number>;
    bottomInset: SharedValue<number>;
    composerHeight: SharedValue<number>;
    isKeyboardLiftSuppressed: SharedValue<boolean>;
    keyboardHeightForInset: SharedValue<number>;
    keyboardHeightLive: SharedValue<number>;
    keyboardProgress: SharedValue<number>;
    listBottomInset: SharedValue<number>;
    getKeyboardHeight?: () => number;
    retainKeyboardLift?: () => () => void;
    setComposerMeasuredHeight: (height: number) => void;
    subscribeAvailablePanelHeight?: (listener: (height: number) => void) => () => void;
    subscribeKeyboardHeight?: (listener: (height: number) => void) => () => void;
    subscribeListBottomInset?: (listener: (height: number) => void) => () => void;
}>;

const ComposerKeyboardContext = React.createContext<ComposerKeyboardLayout | null>(null);

export function ComposerKeyboardProvider(props: Readonly<{
    children: React.ReactNode;
    layout: ComposerKeyboardLayout;
}>): React.ReactElement {
    return (
        <ComposerKeyboardContext.Provider value={props.layout}>
            {props.children}
        </ComposerKeyboardContext.Provider>
    );
}

export function useComposerKeyboardLayout(): ComposerKeyboardLayout | null {
    return React.useContext(ComposerKeyboardContext);
}
