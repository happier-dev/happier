import * as React from 'react';

import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { getOwnDetailsWorkspaceRecordEntry } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { DiscussionSecondOpinionPane } from './DiscussionSecondOpinionSheet';
import {
  readDiscussionSecondOpinionPaneRequest,
  releaseDiscussionSecondOpinionPaneRequest,
} from './useOpenDiscussionSecondOpinion';

/**
 * One Second opinion Details tab. Its in-memory request (answer text, retained draft) lives exactly as long
 * as the tab: switching tabs keeps it, and closing the tab by any route — its own Close, the strip's ×,
 * closing the pane's group — releases it.
 */
export function DiscussionSecondOpinionPaneTab(
  props: Readonly<{
    requestId: string;
    active?: boolean;
    paneScopeId: string;
    tabKey: string;
    onCloseTab: () => void;
    onOpenDiscussion: (
      discussionId: string,
      title: string,
      messageId: string,
    ) => void;
  }>,
) {
  const panes = React.useContext(AppPaneContext);
  const { requestId, paneScopeId, tabKey } = props;
  React.useEffect(() => {
    if (!panes) return;
    const releaseIfClosed = () => {
      const details = panes.getSnapshot().state.scopes[paneScopeId]?.details;
      if (
        !details?.isOpen ||
        !getOwnDetailsWorkspaceRecordEntry(details.tabsByKey, tabKey)
      )
        releaseDiscussionSecondOpinionPaneRequest(requestId);
    };
    const unsubscribe = panes.subscribe(releaseIfClosed);
    // An unmount that is not a close (another tab came to the front) keeps the request.
    return () => {
      unsubscribe();
      releaseIfClosed();
    };
  }, [paneScopeId, panes, requestId, tabKey]);
  const request = readDiscussionSecondOpinionPaneRequest(requestId);
  if (!request) {
    return (
      <SurfaceStateCard
        size="line"
        kind="unavailable"
        testID="second-opinion.closed"
        title={t('session.collaboration.discussion.secondOpinion.paneClosed')}
        action={{ label: t('common.close'), onPress: props.onCloseTab }}
      />
    );
  }
  return (
    <DiscussionSecondOpinionPane
      active={props.active}
      source={request.source}
      intent={request.intent}
      sourceText={request.sourceText}
      onNavigate={request.onNavigate}
      sourcePaneScopeId={request.paneScopeId}
      retained={request.retained}
      onClose={props.onCloseTab}
      onOpenDiscussion={props.onOpenDiscussion}
    />
  );
}
