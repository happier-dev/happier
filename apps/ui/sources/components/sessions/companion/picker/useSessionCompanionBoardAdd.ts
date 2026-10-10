import * as React from 'react';

import type { MountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';

import type { SessionCompanionAddBinding } from './SessionCompanionAddControl';

/**
 * The Board half of Add to Companion, read from the ONE mounted Board controller: the Session's
 * plugin projection (for each Board item's provenance) and its current plugin runtime (which
 * admits compact plugin glances). The Companion adds references only; it never creates Board
 * content.
 */
export function useSessionCompanionBoardAdd(
    mountedBoard: MountedSessionBoardController | null,
): Omit<SessionCompanionAddBinding, 'refs' | 'snapshot' | 'addItem'> {
    const pluginRuntime = mountedBoard?.pluginRuntime ?? null;
    const pluginProjection = pluginRuntime?.pluginUiProjection ?? null;
    const acquireBoardContent = mountedBoard?.acquireContent;
    return React.useMemo(() => ({ pluginProjection, pluginRuntime,
        ...(acquireBoardContent ? { acquireBoardContent } : {}),
    }), [acquireBoardContent, pluginProjection, pluginRuntime]);
}
