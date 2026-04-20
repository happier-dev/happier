import * as React from 'react';
import { Platform } from 'react-native';

import { SESSION_SPLIT_CANVAS_DRAG_STATE_EVENT, type SessionSplitCanvasDragStateDetail } from './sessionSplitCanvasDragState';

export function useSessionSplitCanvasDragState(): boolean {
    const [active, setActive] = React.useState(false);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') {
            return;
        }

        const handleDragState = (event: Event) => {
            const detail = (event as CustomEvent<SessionSplitCanvasDragStateDetail>).detail;
            setActive(detail?.active === true);
        };

        const handleWindowDragEnd = () => {
            setActive(false);
        };

        window.addEventListener(SESSION_SPLIT_CANVAS_DRAG_STATE_EVENT, handleDragState as EventListener);
        window.addEventListener('dragend', handleWindowDragEnd);
        window.addEventListener('drop', handleWindowDragEnd);

        return () => {
            window.removeEventListener(SESSION_SPLIT_CANVAS_DRAG_STATE_EVENT, handleDragState as EventListener);
            window.removeEventListener('dragend', handleWindowDragEnd);
            window.removeEventListener('drop', handleWindowDragEnd);
        };
    }, []);

    return active;
}
