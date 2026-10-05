import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { attachWebDragDropHandlers, type WebDragDropHandlers } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { writeRepositoryFileDropTarget, type RepositoryFileDropTarget } from './repositoryFileDropTarget';

export type WebDropTargetViewProps = ViewProps & WebDragDropHandlers & Readonly<{ repositoryFileDropTarget?: RepositoryFileDropTarget }>;

export const WebDropTargetView = React.forwardRef<View, WebDropTargetViewProps>(function WebDropTargetView(props, forwardedRef): React.ReactElement {
    const { onDragEnter, onDragLeave, onDragOver, onDrop, repositoryFileDropTarget, ...rest } = props;
    const destinationRef = React.useRef(repositoryFileDropTarget);
    destinationRef.current = repositoryFileDropTarget;
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
        // RN Web delivers a DOM host for the public View ref at this platform boundary.
        const view = node as View | null;
        if (typeof forwardedRef === 'function') forwardedRef(view);
        else if (forwardedRef) forwardedRef.current = view;
        if (Platform.OS !== 'web') return;

        const hostElement = (node as HTMLElement | null) ?? null;
        if (hostElement === attachedHostRef.current) return;

        detachHostListeners();
        if (!hostElement) return;

        if (typeof hostElement.setAttribute === 'function') writeRepositoryFileDropTarget(hostElement, destinationRef.current);

        attachedHostRef.current = hostElement;
        detachHostListenersRef.current = attachWebDragDropHandlers(hostElement, () => handlersRef.current);
    }, [detachHostListeners, forwardedRef]);

    React.useEffect(() => detachHostListeners, [detachHostListeners]);
    React.useLayoutEffect(() => {
        const host = attachedHostRef.current;
        if (host && typeof host.setAttribute === 'function') writeRepositoryFileDropTarget(host, repositoryFileDropTarget);
    }, [repositoryFileDropTarget?.destinationDir, repositoryFileDropTarget?.hoverPath, repositoryFileDropTarget?.autoExpandDirectoryPath]);

    return (
        <View
            {...rest}
            ref={setHostRef}
        />
    );
});
