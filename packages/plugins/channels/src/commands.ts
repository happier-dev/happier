export type ConversationCommandClassification =
  | Readonly<{ kind: 'pair'; token: string }>
  | Readonly<{
    kind: 'approve';
    requestId: string;
    decision: 'allow' | 'deny';
    scope: 'request' | 'session';
  }>
  | Readonly<{ kind: 'newSession'; initialPrompt?: string }>
  | Readonly<{ kind: 'ordinaryText' }>
  | Readonly<{ kind: 'malformedCommand'; command: 'pair' | 'approve' | 'newSession' }>;

const NORMALIZED_CROCKFORD_TOKEN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/u;

function normalizeConversationCommandText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

export function normalizeConversationPairingToken(value: string): string | null {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/O/gu, '0')
    .replace(/[IL]/gu, '1');
  return NORMALIZED_CROCKFORD_TOKEN.test(normalized) ? normalized : null;
}

export function classifyConversationCommand(text: string): ConversationCommandClassification {
  const normalized = normalizeConversationCommandText(text);
  const [command, ...arguments_] = normalized.split(' ');

  if (command === '/pair' || command === '/start') {
    const token = arguments_.length === 1 ? normalizeConversationPairingToken(arguments_[0] ?? '') : null;
    return token === null
      ? { kind: 'malformedCommand', command: 'pair' }
      : { kind: 'pair', token };
  }

  if (command === '/allow') {
    const [requestId, scope] = arguments_;
    if (requestId === undefined || arguments_.length > 2 || (scope !== undefined && scope !== 'request' && scope !== 'session')) {
      return { kind: 'malformedCommand', command: 'approve' };
    }
    return {
      kind: 'approve',
      requestId,
      decision: 'allow',
      scope: scope ?? 'request',
    };
  }

  if (command === '/deny') {
    const requestId = arguments_[0];
    if (requestId === undefined || arguments_.length !== 1) {
      return { kind: 'malformedCommand', command: 'approve' };
    }
    return {
      kind: 'approve',
      requestId,
      decision: 'deny',
      scope: 'request',
    };
  }

  if (command === '/new') {
    const initialPrompt = arguments_.join(' ');
    return initialPrompt.length === 0
      ? { kind: 'newSession' }
      : { kind: 'newSession', initialPrompt };
  }

  return { kind: 'ordinaryText' };
}

export function createConversationNewSessionCreationKey(input: Readonly<{
  bindingId: string;
  commandOccurrenceId: string;
}>): string {
  return `channel-new:${input.bindingId}:${input.commandOccurrenceId}`;
}
