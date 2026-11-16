import { useDestinationFocus, useDestinationFocusSignal, type DestinationFocusSignal } from '@/components/appShell/workspace/destinationInstanceContext';

/** Whether this Session's screen is the focused one, for a leaf that draws or gates on it. */
export function useSessionScreenIsFocused(): boolean {
    return useDestinationFocus();
}

/** The same fact by subscription, for work that only starts or stops with focus: a tab switch renders nothing. */
export function useSessionScreenFocusSignal(): DestinationFocusSignal {
    return useDestinationFocusSignal();
}
