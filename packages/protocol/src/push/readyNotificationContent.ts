type ReadyNotificationContent = Readonly<{
  title: string;
  body: string;
}>;

function normalizeNotificationText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

export function buildReadyNotificationContent(params: Readonly<{
  sessionTitle?: string | null;
  defaultTitle: string;
  waitingForCommandLabel: string;
  fallbackBody: string;
  includeMessageText?: boolean;
  messageText?: string | null;
}>): ReadyNotificationContent {
  const title =
    normalizeNotificationText(params.sessionTitle) ??
    normalizeNotificationText(params.defaultTitle) ??
    normalizeNotificationText(params.waitingForCommandLabel) ??
    'Session';

  const previewText = params.includeMessageText === false ? null : normalizeNotificationText(params.messageText);
  const fallbackBody =
    normalizeNotificationText(params.fallbackBody) ??
    `${normalizeNotificationText(params.waitingForCommandLabel) ?? 'Session'} is waiting for your command`;

  return {
    title,
    body: previewText ?? fallbackBody,
  };
}
