import { MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES } from '@happier-dev/channels-protocol';

export type ConversationCommandClassification =
  | Readonly<{ kind: 'pair'; token: string }>
  | Readonly<{
    kind: 'approve';
    requestId: string;
    decision: 'allow' | 'deny';
    scope: 'request' | 'session';
  }>
  | Readonly<{
    /**
     * The chat syntax transports all indexed answers in one atomic payload.
     * Session remains the owner of question membership, choice resolution,
     * completion, and currentness.
     */
    kind: 'userActionAnswer';
    requestId: string;
    answers: readonly Readonly<{
      questionIndex: number;
      values: readonly string[];
    }>[];
  }>
  | Readonly<{ kind: 'newSession'; initialPrompt?: string }>
  | Readonly<{ kind: 'ordinaryText' }>
  | Readonly<{ kind: 'malformedCommand'; command: 'pair' | 'approve' | 'answer' | 'newSession' }>;

const NORMALIZED_CROCKFORD_TOKEN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/u;

const UTF8_ENCODER = new TextEncoder();

/**
 * Ingress text is bounded far above one request identifier, so an admitted
 * `/allow`/`/deny` could otherwise freeze an identifier the ingress obligation
 * cannot persist and the canonical Permission mediation contract cannot
 * accept. An oversized identifier is a mistyped command, not a settleable
 * mediation, so it refuses here at the one command classifier.
 */
function isPersistableApprovalRequestId(requestId: string): boolean {
  return UTF8_ENCODER.encode(requestId).byteLength
    <= MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES;
}

function normalizeConversationCommandText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function parseConversationUserActionAnswer(text: string): Extract<
  ConversationCommandClassification,
  Readonly<{ kind: 'userActionAnswer' }>
> | null {
  const match = /^\/answer\s+(\S+)\s+([\s\S]+)$/u.exec(text.trim());
  if (match === null) return null;
  const requestId = match[1] ?? '';
  const serializedAnswers = match[2] ?? '';
  if (!isPersistableApprovalRequestId(requestId)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedAnswers);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const answers: Array<Readonly<{ questionIndex: number; values: readonly string[] }>> = [];
  for (const answer of parsed) {
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return null;
    const record = answer as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2
      || !Object.prototype.hasOwnProperty.call(record, 'questionIndex')
      || !Object.prototype.hasOwnProperty.call(record, 'values')
      || typeof record.questionIndex !== 'number'
      || !Number.isSafeInteger(record.questionIndex)
      || !Array.isArray(record.values)
      || record.values.length === 0
      || !record.values.every((value) => typeof value === 'string')
    ) {
      return null;
    }
    answers.push({
      questionIndex: record.questionIndex,
      values: record.values,
    });
  }
  return { kind: 'userActionAnswer', requestId, answers };
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
  // Unlike the established whitespace-insensitive commands, `/answer` carries
  // JSON free text. Inspect it before normalizing whitespace so a legitimate
  // custom response reaches the canonical Session owner unchanged.
  const rawTrimmed = text.trim();
  if (rawTrimmed === '/answer' || /^\/answer\s/u.test(rawTrimmed)) {
    return parseConversationUserActionAnswer(rawTrimmed)
      ?? { kind: 'malformedCommand', command: 'answer' };
  }

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
    if (
      requestId === undefined
      || arguments_.length > 2
      || (scope !== undefined && scope !== 'request' && scope !== 'session')
      || !isPersistableApprovalRequestId(requestId)
    ) {
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
    if (
      requestId === undefined
      || arguments_.length !== 1
      || !isPersistableApprovalRequestId(requestId)
    ) {
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
