import * as React from 'react';
import { Platform, Pressable, type PressableProps } from 'react-native';

type WebDragSourceHandlers = Readonly<{
    onDragStart?: (event: any) => void;
    onDragEnd?: (event: any) => void;
}>;

export type SplitCanvasDragSourceViewProps = PressableProps & WebDragSourceHandlers & Readonly<{
    draggable?: boolean;
}>;

export function SplitCanvasDragSourceView(props: SplitCanvasDragSourceViewProps): React.ReactElement {
    const { onDragStart, onDragEnd, draggable = true, ...rest } = props;
    const handlersRef = React.useRef<WebDragSourceHandlers>({
        onDragStart,
        onDragEnd,
    });

    handlersRef.current = {
        onDragStart,
        onDragEnd,
    };
    const attachedHostRef = React.useRef<HTMLElement | null>(null);
    const detachHostListenersRef = React.useRef<(() => void) | null>(null);

    const detachHostListeners = React.useCallback(() => {
        detachHostListenersRef.current?.();
        detachHostListenersRef.current = null;
        attachedHostRef.current = null;
    }, []);

    const setHostRef = React.useCallback((node: unknown) => {
        if (Platform.OS !== 'web') return;

        const hostElement = (node as HTMLElement | null) ?? null;
        if (hostElement === attachedHostRef.current) return;

        detachHostListeners();
        if (!hostElement) return;

        hostElement.setAttribute('draggable', draggable ? 'true' : 'false');

        const listeners: ReadonlyArray<readonly [keyof GlobalEventHandlersEventMap, EventListener]> = [
            ['dragstart', (event) => handlersRef.current.onDragStart?.(event)],
            ['dragend', (event) => handlersRef.current.onDragEnd?.(event)],
        ];

        for (const [type, listener] of listeners) {
            hostElement.addEventListener(type, listener);
        }

        attachedHostRef.current = hostElement;
        detachHostListenersRef.current = () => {
            for (const [type, listener] of listeners) {
                hostElement.removeEventListener(type, listener);
            }
        };
    }, [detachHostListeners, draggable]);

    React.useEffect(() => detachHostListeners, [detachHostListeners]);

    return (
        <Pressable
            {...rest}
            ref={setHostRef}
        />
    );
}
