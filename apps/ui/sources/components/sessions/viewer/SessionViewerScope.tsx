import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createComputerScreenDetailsTab } from '@/components/computer/computerScreenDetailsTab';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * Mounts the Session's one viewer presentation owner around its panes and main column. Both
 * sources live on the Session's own machine (the Watch opener's rule); desktop dock presents the
 * same retained body in its pane (Computer in Details, Browser in the right pane).
 */
export function SessionViewerScope(
  props: React.PropsWithChildren<
    Readonly<{
      sessionId: string;
      serverId: string | null;
    }>
  >,
): React.ReactElement {
  const phone = useDeviceType() === 'phone';
  const serverId = usePreferredServerIdForSession({ sessionId: props.sessionId, serverId: props.serverId });
  const machineId =
    useSessionMachineTarget(props.sessionId, serverId)?.machineId ?? null;
  const scopeId = useDestinationPaneScopeId(
    createSessionPaneScopeId(props.sessionId, serverId ?? undefined),
  );
  const pane = useAppPaneScope(scopeId);
  const paneRef = React.useRef(pane);
  paneRef.current = pane;
  const canPresentSource = React.useCallback(
    (_source: SessionViewerSource) => machineId !== null,
    [machineId],
  );
  const openDocked = React.useCallback(
    (source: SessionViewerSource) => {
      if (!machineId) return;
      if (source === 'computer') {
        paneRef.current.openDetailsTab(
          createComputerScreenDetailsTab({
            machineId,
            title: t('computerUse.viewer.tabFallback'),
          }),
          { intent: 'default' },
        );
        return;
      }
      paneRef.current.openRight({ tabId: 'browser' });
      paneRef.current.setRightTab('browser');
    },
    [machineId],
  );
  return (
    <SessionViewerControllerProvider
      key={serverId ? sessionAddressKey({ sessionId: props.sessionId, serverId }) : props.sessionId}
      sessionId={props.sessionId}
      serverId={serverId}
      phone={phone}
      canPresentSource={canPresentSource}
      openDocked={openDocked}
    >
      {props.children}
    </SessionViewerControllerProvider>
  );
}
