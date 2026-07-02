import type {
  AcpCustomTransportHandlerDecisionV1,
  AcpCustomTransportHandlerSpecV1,
} from '@happier-dev/plugin-sdk';

const OLD_FILE_HEADER = /^-{2,3} (?:\/dev\/null|[ab]\/[^\n]*|\/[^\n]*)(?:\n|$)/;
const NEW_FILE_HEADER = /^\+{2,3} (?:\/dev\/null|[ab]\/[^\n]*|\/[^\n]*)(?:\n|$)/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripUnifiedDiffHeaderLine(text: string, headerRe: RegExp): string {
  const match = headerRe.exec(text);
  const stripped = match ? text.slice(match[0].length) : text;
  return stripped.trim() === '/dev/null' ? '' : stripped;
}

export function sanitizeCursorDiffContent<T extends { content?: unknown }>(update: T): T {
  const content = update.content;
  if (!Array.isArray(content)) {
    return update;
  }

  let changed = false;
  const nextContent = content.map((entry) => {
    if (!isRecord(entry) || entry.type !== 'diff') {
      return entry;
    }
    const oldText = typeof entry.oldText === 'string'
      ? stripUnifiedDiffHeaderLine(entry.oldText, OLD_FILE_HEADER)
      : entry.oldText;
    const newText = typeof entry.newText === 'string'
      ? stripUnifiedDiffHeaderLine(entry.newText, NEW_FILE_HEADER)
      : entry.newText;
    if (oldText === entry.oldText && newText === entry.newText) {
      return entry;
    }
    changed = true;
    return { ...entry, oldText, newText };
  });

  return changed ? { ...update, content: nextContent } : update;
}

function handleCursorSessionUpdateMessage(message: unknown): AcpCustomTransportHandlerDecisionV1 {
  if (!isRecord(message) || message.method !== 'session/update' || !isRecord(message.params)) {
    return 'pass';
  }
  const update = message.params.update;
  if (!isRecord(update)) {
    return 'pass';
  }
  if (update.sessionUpdate === 'plan') {
    return 'suppress';
  }

  const sanitized = sanitizeCursorDiffContent(update);
  if (sanitized === update) {
    return 'pass';
  }

  return Object.freeze({
    kind: 'replace',
    message: Object.freeze({
      ...message,
      params: Object.freeze({
        ...message.params,
        update: sanitized,
      }),
    }),
  });
}

export function createCursorAcpTransportCustomHandler(): AcpCustomTransportHandlerSpecV1 {
  return Object.freeze({
    onMessage: (message, context) => context.phase === 'incoming'
      ? handleCursorSessionUpdateMessage(message)
      : 'pass',
  });
}
