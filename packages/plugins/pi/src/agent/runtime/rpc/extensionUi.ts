export type PiBlockingExtensionUiRequest = Readonly<{
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  options: readonly string[];
  message: string | null;
  placeholder: string | null;
  prefill: string | null;
}>;

export type PiExtensionUiResponse = Readonly<{
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function parsePiBlockingExtensionUiRequest(value: unknown): PiBlockingExtensionUiRequest | null {
  if (!isRecord(value) || value.type !== 'extension_ui_request') return null;
  const id = readString(value.id);
  const title = readString(value.title);
  const method = value.method;
  if (
    !id
    || !title
    || (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor')
  ) return null;
  const options: string[] = [];
  if (method === 'select') {
    if (!Array.isArray(value.options)) return null;
    for (const option of value.options) {
      const normalized = readString(option);
      if (!normalized) return null;
      options.push(normalized);
    }
    if (options.length === 0) return null;
  }
  return {
    id,
    method,
    title,
    options,
    message: readString(value.message),
    placeholder: readString(value.placeholder),
    prefill: readString(value.prefill),
  };
}

export function buildPiExtensionUiQuestionRequest(request: PiBlockingExtensionUiRequest) {
  if (request.method === 'select') {
    const [first, ...rest] = request.options;
    if (!first) throw new Error('Pi select dialog requires at least one option');
    return {
      kind: 'questions' as const,
      title: 'Pi question',
      questions: [{
        id: request.id,
        prompt: request.title,
        type: 'singleChoice' as const,
        required: true,
        choices: [
          { id: 'choice-0', label: first },
          ...rest.map((label, index) => ({ id: `choice-${index + 1}`, label })),
        ],
      }],
    };
  }
  if (request.method === 'confirm') {
    return {
      kind: 'questions' as const,
      title: 'Pi question',
      questions: [{
        id: request.id,
        prompt: request.title,
        ...(request.message ? { description: request.message } : {}),
        type: 'singleChoice' as const,
        required: true,
        choices: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ] as [{ id: string; label: string }, { id: string; label: string }],
      }],
    };
  }
  const description = request.method === 'input'
    ? request.placeholder
    : request.prefill;
  return {
    kind: 'questions' as const,
    title: 'Pi question',
    questions: [{
      id: request.id,
      prompt: request.title,
      ...(description ? { description } : {}),
      type: 'text' as const,
      required: true,
    }],
  };
}

function readQuestionAnswer(result: unknown, questionId: string): Readonly<Record<string, unknown>> | null {
  if (!isRecord(result) || result.status !== 'answered' || !isRecord(result.answers)) return null;
  return isRecord(result.answers[questionId]) ? result.answers[questionId] : null;
}

export function buildPiExtensionUiResponse(
  request: PiBlockingExtensionUiRequest,
  result: unknown,
): PiExtensionUiResponse {
  const answer = readQuestionAnswer(result, request.id);
  if (!answer) return { type: 'extension_ui_response', id: request.id, cancelled: true };
  if (request.method === 'input' || request.method === 'editor') {
    const value = answer.kind === 'text' ? readString(answer.value) : null;
    return value
      ? { type: 'extension_ui_response', id: request.id, value }
      : { type: 'extension_ui_response', id: request.id, cancelled: true };
  }
  const selected = answer.kind === 'singleChoice' && isRecord(answer.answer)
    ? answer.answer
    : null;
  const choiceId = selected?.kind === 'choice' ? readString(selected.choiceId) : null;
  if (request.method === 'confirm') {
    if (choiceId !== 'yes' && choiceId !== 'no') {
      return { type: 'extension_ui_response', id: request.id, cancelled: true };
    }
    return { type: 'extension_ui_response', id: request.id, confirmed: choiceId === 'yes' };
  }
  const choiceIndex = choiceId?.match(/^choice-(\d+)$/)?.[1];
  const value = choiceIndex === undefined ? null : request.options[Number(choiceIndex)] ?? null;
  return value
    ? { type: 'extension_ui_response', id: request.id, value }
    : { type: 'extension_ui_response', id: request.id, cancelled: true };
}
