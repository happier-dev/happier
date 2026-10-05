import { readSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import type { PaneDropScene } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { t } from '@/text';

import { activeSessionForLeaf, findSessionCanvasTab, findSessionLeafById, type SessionSplitCanvasState } from './sessionSplitCanvasState';

function tabTitle(address: Readonly<{ serverId: string; sessionId: string }>): string {
    return readSessionDisplayTitle(address) ?? t('common.unavailable');
}

/** What a Session canvas pane drop is worded against: the pane's open Session and where Sessions are. */
export function createSessionCanvasDropScene(state: SessionSplitCanvasState, input: Readonly<{
    paneId: string;
    beforeTabId?: string | null;
    declinedSplit?: boolean;
}>): PaneDropScene {
    const active = activeSessionForLeaf(findSessionLeafById(state, input.paneId));
    return {
        paneId: input.paneId,
        paneTitle: active ? tabTitle(active.address) : null,
        sessionsOnly: true,
        ...(input.beforeTabId === undefined ? {} : { beforeTabId: input.beforeTabId }),
        ...(input.declinedSplit ? { declinedSplit: true } : {}),
        locateTab: tabId => {
            const found = findSessionCanvasTab(state, tabId);
            return found ? { paneId: found.leaf.id, title: tabTitle(found.tab.address) } : null;
        },
    };
}

/** The pane's open Session, named for a chooser entry. */
export function readSessionCanvasPaneTitle(state: SessionSplitCanvasState, paneId: string): string | null {
    const active = activeSessionForLeaf(findSessionLeafById(state, paneId));
    return active ? tabTitle(active.address) : null;
}
