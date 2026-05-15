import * as React from 'react';

import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';

import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';

export function useSessionCanvasSelection(params: Readonly<{
    selectable: boolean;
    pathname: string;
}>): string | null {
    const focusedSessionId = useFocusedSessionId();

    return React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: params.selectable,
        pathname: params.pathname,
        focusedSessionId,
    }), [focusedSessionId, params.pathname, params.selectable]);
}
