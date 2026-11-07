import * as React from 'react';

import { useOptionalPinnedDetailsTabCommand } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionSecondOpinionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { randomUUID } from '@/platform/randomUUID';
import type { DiscussionSecondOpinionRequest } from './DiscussionSecondOpinionSheet';

/**
 * Open requests live in memory with their pane: the answer text and the retained draft never enter the
 * persisted pane state, which carries only the request id. A pane restored after a reload has no request
 * and says so.
 */
const paneRequests = new Map<string, DiscussionSecondOpinionPaneRequest>();

export type DiscussionSecondOpinionPaneRequest =
  DiscussionSecondOpinionRequest &
    Readonly<{
      paneScopeId: string;
      /** The form's controller, kept while the tab is open so switching tabs keeps the draft and an Ask in flight. */
      retained: { controller?: unknown };
    }>;

export function readDiscussionSecondOpinionPaneRequest(
  requestId: string,
): DiscussionSecondOpinionPaneRequest | null {
  return paneRequests.get(requestId) ?? null;
}

export function releaseDiscussionSecondOpinionPaneRequest(
  requestId: string,
): void {
  paneRequests.delete(requestId);
}

/**
 * L7 entry (lab T3): beside the transcript, Second opinion and Discuss… open in the Session's Details pane so
 * the answer stays visible; a phone, or a host without that pane, presents the same form as the phone sheet.
 */
export function useOpenDiscussionSecondOpinion(paneScopeId: string): (request: DiscussionSecondOpinionRequest) => void {
    // Every transcript row holds this: it reads the pane and the window only when pressed, never per render.
    const openPinnedDetailsTab = useOptionalPinnedDetailsTabCommand(paneScopeId);
    return React.useCallback((request: DiscussionSecondOpinionRequest) => {
        const requestId = randomUUID();
        const tab = createSessionSecondOpinionDetailsTab({ address: request.source.message.session, requestId, intent: request.intent });
        paneRequests.set(requestId, { ...request, paneScopeId, retained: {} });
        openPinnedDetailsTab(tab, { start: true });
    }, [openPinnedDetailsTab, paneScopeId]);
}
