import * as React from 'react';

export type FocusReturnTarget = Readonly<{
    focus?: () => void;
    isConnected?: boolean;
}> | null | undefined;

export type FocusReturnRef = Readonly<{
    current: FocusReturnTarget;
}> | null | undefined;

type FocusReturnContextValue = Readonly<{
    fallbackRef: React.MutableRefObject<FocusReturnTarget>;
}>;

const FocusReturnContext = React.createContext<FocusReturnContextValue | null>(null);

function canFocusTarget(target: FocusReturnTarget): target is NonNullable<FocusReturnTarget> & { focus: () => void } {
    return typeof target?.focus === 'function' && target.isConnected !== false;
}

export function restoreFocusToBestTarget(
    triggerRef: FocusReturnRef,
    fallbackRef?: FocusReturnRef,
): boolean {
    const trigger = triggerRef?.current;
    if (canFocusTarget(trigger)) {
        trigger.focus();
        return true;
    }

    const fallback = fallbackRef?.current;
    if (canFocusTarget(fallback)) {
        fallback.focus();
        return true;
    }

    return false;
}

export function FocusReturnProvider(props: React.PropsWithChildren) {
    const fallbackRef = React.useRef<FocusReturnTarget>(null);
    const value = React.useMemo<FocusReturnContextValue>(() => ({ fallbackRef }), []);
    return (
        <FocusReturnContext.Provider value={value}>
            {props.children}
        </FocusReturnContext.Provider>
    );
}

export function useFocusReturnFallbackRef<T extends FocusReturnTarget>() {
    const context = React.useContext(FocusReturnContext);
    const localFallbackRef = React.useRef<FocusReturnTarget>(null);
    const fallbackRef = context?.fallbackRef ?? localFallbackRef;
    return fallbackRef as React.MutableRefObject<T>;
}

export function useRestoreFocusToTrigger(triggerRef: FocusReturnRef) {
    const context = React.useContext(FocusReturnContext);
    return React.useCallback(() => {
        return restoreFocusToBestTarget(triggerRef, context?.fallbackRef);
    }, [context?.fallbackRef, triggerRef]);
}
