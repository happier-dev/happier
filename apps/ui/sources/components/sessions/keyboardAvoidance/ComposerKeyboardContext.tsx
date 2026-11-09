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
    setComposerInputFocused?: (focused: boolean) => void;
    setComposerMeasuredHeight: (height: number) => void;
    subscribeAvailablePanelHeight?: (listener: (height: number) => void) => () => void;
    subscribeKeyboardHeight?: (listener: (height: number) => void) => () => void;
    subscribeListBottomInset?: (listener: (height: number) => void) => () => void;
}>;

const ComposerKeyboardContext = React.createContext<ComposerKeyboardLayout | null>(null);

/**
 * Whether one of the composer's own overlays (the prompt picker) spans the bottom of the transcript.
 * Transcript controls floating there step aside while it is open; only their small leaves read it.
 */
const ComposerOverlayOpenContext = React.createContext(false);
const ComposerOverlayReportContext = React.createContext<((open: boolean) => void) | null>(null);

export function ComposerKeyboardProvider(props: Readonly<{
    children: React.ReactNode;
    layout: ComposerKeyboardLayout;
}>): React.ReactElement {
    const [overlayOpen, setOverlayOpen] = React.useState(false);
    return (
        <ComposerKeyboardContext.Provider value={props.layout}>
            <ComposerOverlayReportContext.Provider value={setOverlayOpen}>
                <ComposerOverlayOpenContext.Provider value={overlayOpen}>
                    {props.children}
                </ComposerOverlayOpenContext.Provider>
            </ComposerOverlayReportContext.Provider>
        </ComposerKeyboardContext.Provider>
    );
}

export function useComposerKeyboardLayout(): ComposerKeyboardLayout | null {
    return React.useContext(ComposerKeyboardContext);
}

export function useComposerOverlayOpen(): boolean {
    return React.useContext(ComposerOverlayOpenContext);
}

/** The composer reports its overlay while it is open; unmounting closes it. */
export function useReportComposerOverlayOpen(open: boolean): void {
    const report = React.useContext(ComposerOverlayReportContext);
    React.useEffect(() => {
        if (!report || !open) return undefined;
        report(true);
        return () => report(false);
    }, [open, report]);
}
