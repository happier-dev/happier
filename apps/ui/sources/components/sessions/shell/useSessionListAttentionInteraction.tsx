import * as React from 'react';

type FocusTarget = Readonly<{
    matches?: (selector: string) => boolean;
    contains?: (target: unknown) => boolean;
}>;

export type SessionListAttentionInteraction = Readonly<{
    subscribe: (notify: () => void) => () => void;
    getSnapshot: () => boolean;
    setActivity: (token: object, active: boolean) => void;
    releaseKeyboard: () => void;
    reset: () => void;
    zoneProps: Readonly<{
        onPointerEnter: (event: { pointerType?: string; nativeEvent?: { pointerType?: string } }) => void;
        onPointerLeave: () => void;
        onPointerDownCapture: () => void;
        onTouchStart: () => void;
        onTouchEnd: () => void;
        onTouchCancel: () => void;
        onFocus: (event: { target?: FocusTarget; nativeEvent?: { target?: FocusTarget } }) => void;
        onBlur: (event: { currentTarget?: FocusTarget; relatedTarget?: unknown; nativeEvent?: { relatedTarget?: unknown } }) => void;
        onKeyDownCapture: (event: { key?: string }) => void;
    }>;
}>;

export const SessionListAttentionInteractionContext = React.createContext<SessionListAttentionInteraction | null>(null);

/** One mounted boolean projection; rows report lifetimes without subscribing to it. */
export function useSessionListAttentionInteractionOwner(): SessionListAttentionInteraction {
    const inheritedController = React.useContext(SessionListAttentionInteractionContext);
    const [controller] = React.useState<SessionListAttentionInteraction>(() => {
        if (inheritedController) return inheritedController;
        let pointerInside = false;
        let keyboardNavigating = false;
        let touchActive = false;
        let held = false;
        const activities = new Set<object>();
        const listeners = new Set<() => void>();
        const publish = () => {
            const next = pointerInside || keyboardNavigating || touchActive || activities.size > 0;
            if (held === next) return;
            held = next;
            for (const notify of listeners) notify();
        };
        const releaseKeyboard = () => { keyboardNavigating = false; publish(); };
        const releaseTouch = () => { touchActive = false; publish(); };
        return {
            subscribe: (notify) => {
                listeners.add(notify);
                return () => { listeners.delete(notify); };
            },
            getSnapshot: () => held,
            setActivity: (token, active) => {
                if (active) activities.add(token);
                else activities.delete(token);
                publish();
            },
            releaseKeyboard,
            reset: () => {
                pointerInside = false;
                keyboardNavigating = false;
                touchActive = false;
                activities.clear();
                publish();
            },
            zoneProps: {
                onPointerEnter: (event) => {
                    const pointerType = event.pointerType ?? event.nativeEvent?.pointerType;
                    if (pointerType !== 'mouse' && pointerType !== 'pen') return;
                    pointerInside = true;
                    publish();
                },
                onPointerLeave: () => { pointerInside = false; publish(); },
                onPointerDownCapture: releaseKeyboard,
                onTouchStart: () => { touchActive = true; keyboardNavigating = false; publish(); },
                onTouchEnd: releaseTouch,
                onTouchCancel: releaseTouch,
                onFocus: (event) => {
                    const target = event.target ?? event.nativeEvent?.target;
                    if (target?.matches?.(':focus-visible') !== true) return;
                    keyboardNavigating = true;
                    publish();
                },
                onBlur: (event) => {
                    if (event.currentTarget?.contains?.(event.relatedTarget ?? event.nativeEvent?.relatedTarget)) return;
                    releaseKeyboard();
                },
                onKeyDownCapture: (event) => {
                    if (!['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter'].includes(event.key ?? '')) return;
                    keyboardNavigating = true;
                    publish();
                },
            },
        } satisfies SessionListAttentionInteraction;
    });
    return inheritedController ?? controller;
}

const subscribeInactive = () => () => {};
const readInactive = () => false;

export function useSessionListAttentionInteractionHeld(controller: SessionListAttentionInteraction | null): boolean {
    return React.useSyncExternalStore(controller?.subscribe ?? subscribeInactive, controller?.getSnapshot ?? readInactive, readInactive);
}

/** Report an existing menu, peek, gesture or move lifetime without subscribing its row. */
export function useSessionListAttentionActivity(): (active: boolean) => void {
    const controller = React.useContext(SessionListAttentionInteractionContext);
    const token = React.useRef({});
    React.useEffect(() => () => controller?.setActivity(token.current, false), [controller]);
    return React.useCallback((active: boolean) => controller?.setActivity(token.current, active), [controller]);
}
