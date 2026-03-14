export type ActivityNotificationEvent =
  | Readonly<{
    topic: 'ready';
    sessionId: string;
    sessionTitle?: string | null;
    waitingForCommandLabel: string;
    assistantPreviewText?: string | null;
  }>
  | Readonly<{
    topic: 'permission_request' | 'user_action_request';
    sessionId: string;
    sessionTitle?: string | null;
    requestId: string;
    toolName: string;
    toolInput?: unknown;
    toolDetails?: string | null;
  }>;
