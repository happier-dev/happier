import * as React from 'react';
import { attachWebDragDropHandlers, createExternalFileDropBinding, type ExternalFileDropTarget } from '@/components/ui/treeDragDrop/externalFileDropAdapter';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export function useWebFileDropZone(params: ExternalFileDropTarget & Readonly<{ hostRef?: React.RefObject<HTMLElement | null> }>) {
    const presentationActive = useLayoutPresentationActive();
    const enabled = params.enabled && presentationActive;
    const current = React.useRef(params);
    current.current = { ...params, enabled };
    const binding = React.useMemo(() => createExternalFileDropBinding(() => current.current), []);
    React.useEffect(() => params.present === false ? undefined : binding.mount(), [binding, params.present]);
    React.useEffect(() => {
        const host = params.hostRef?.current;
        if (host && params.present !== false) return attachWebDragDropHandlers(host, () => binding.handlers);
    }, [binding, params.hostRef, params.present]);
    React.useEffect(() => binding.refresh(), [binding, enabled, params.present]);
    return binding.handlers;
}
