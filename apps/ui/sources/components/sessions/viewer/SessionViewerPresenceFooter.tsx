import * as React from 'react';

import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { t } from '@/text';

import { useSessionViewerPresence } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';
import { useSessionViewerMachine } from './useSessionViewerMachine';

/**
 * Who acts on the presented source, below the picture (lab `b-watch` `.fa-vbot`): the one presence
 * capsule the source's owner states, in flow under the frame. The takeover stays with that owner.
 * Under the viewer the Agent's line is the same for both sources, "{agent} is working on {machine}"
 * (plan 63 `sessionViewer.agentControl`): the picture already shows which window or page.
 */
export function SessionViewerPresenceFooter(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    source: SessionViewerSource;
    compact?: boolean;
  }>,
): React.ReactElement | null {
  const presence = useSessionViewerPresence(props.source);
  const machine = useSessionViewerMachine(props.sessionId, props.serverId, props.source);
  if (!presence) return null;
  return (
    <BrowserPresenceCapsule
      {...presence}
      agentTitle={machine.name
        ? t('computerUse.viewer.agentWorkingOn', { agent: presence.agent.name, machine: machine.name })
        : presence.agentTitle}
      placement="inline"
      compact={props.compact}
      testID="session-viewer-presence"
    />
  );
}
