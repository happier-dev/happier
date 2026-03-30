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
    const [hostElement, setHostElement] = React.useState<HTMLElement | null>(null);
    const setHostRef = React.useCallback((node: unknown) => {
        const next = (node as HTMLElement | null) ?? null;
        setHostElement((prev) => (prev === next ? prev : next));
    }, []);

    handlersRef.current = {
        onDragEnter,
        onDragLeave,
        onDragOver,
        onDrop,
    };

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
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

        return () => {
            for (const [type, listener] of listeners) {
                hostElement.removeEventListener(type, listener);
            }
        };
    }, [hostElement]);

    return (
        <View
            {...rest}
            ref={setHostRef}
        />
    );
}
