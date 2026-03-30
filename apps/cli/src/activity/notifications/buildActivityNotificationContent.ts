import { buildReadyNotificationContent } from '@happier-dev/protocol';

import type { ActivityNotificationEvent } from './activityNotificationEvent';
import {
  buildAgentRequestNotificationContent,
  summarizeToolInputForNotification,
} from './buildAgentRequestNotificationContent';

export function buildActivityNotificationContent(
  event: ActivityNotificationEvent,
  options: Readonly<{
    readyIncludeMessageText: boolean;
  }>,
): Readonly<{
  title: string;
  body: string;
  data: Record<string, unknown>;
  toolDetails?: string | null;
}> {
  if (event.topic === 'ready') {
    const content = buildReadyNotificationContent({
      sessionTitle: event.sessionTitle,
      defaultTitle: event.waitingForCommandLabel,
      waitingForCommandLabel: event.waitingForCommandLabel,
      fallbackBody: `${event.waitingForCommandLabel} is waiting for your command`,
      includeMessageText: options.readyIncludeMessageText,
      messageText: event.assistantPreviewText,
    });
    return {
      title: content.title,
      body: content.body,
      data: {
        sessionId: event.sessionId,
      },
    };
  }

  const kind = event.topic === 'user_action_request' ? 'user_action' : 'permission';
  const toolDetails = typeof event.toolDetails === 'string' && event.toolDetails.trim()
    ? event.toolDetails.trim()
    : summarizeToolInputForNotification(event.toolName, event.toolInput);
  const built = buildAgentRequestNotificationContent({
    kind,
    sessionId: event.sessionId,
    requestId: event.requestId,
    toolName: event.toolName,
    toolDetails,
  });
  return {
    title: built.title,
    body: built.body,
    data: built.data,
    toolDetails,
  };
}
