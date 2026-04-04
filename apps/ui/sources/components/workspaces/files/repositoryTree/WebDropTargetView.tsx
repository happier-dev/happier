import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';

type WebDragDropHandlers = Readonly<{
    onDragEnter?: (event: any) => void;
    onDragLeave?: (event: any) => void;
    onDragOver?: (event: any) => void;
    onDrop?: (event: any) => void;
}>;

export type WebDropTargetViewProps = ViewProps & WebDragDropHandlers;

export function WebDropTargetView(props: WebDropTargetViewProps): React.ReactElement {
    const { onDragEnter, onDragLeave, onDragOver, onDrop, ...rest } = props;
    const handlersRef = React.useRef<WebDragDropHandlers>({
        onDragEnter,
        onDragLeave,
        onDragOver,
        onDrop,
    });

    handlersRef.current = {
        onDragEnter,
        onDragLeave,
        onDragOver,
        onDrop,
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

        const listeners: ReadonlyArray<readonly [keyof GlobalEventHandlersEventMap, EventListener]> = [
            ['dragenter', (event) => handlersRef.current.onDragEnter?.(event)],
            ['dragleave', (event) => handlersRef.current.onDragLeave?.(event)],
            ['dragover', (event) => handlersRef.current.onDragOver?.(event)],
            ['drop', (event) => handlersRef.current.onDrop?.(event)],
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
    }, [detachHostListeners]);

    React.useEffect(() => detachHostListeners, [detachHostListeners]);

    return (
        <View
            {...rest}
            ref={setHostRef}
        />
    );
}
