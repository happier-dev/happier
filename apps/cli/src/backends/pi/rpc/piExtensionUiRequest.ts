import type { PermissionResult } from '@/agent/permissions/permissionResult';

export type PiBlockingExtensionUiRequest = Readonly<{
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  options?: readonly string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
}>;

export type PiExtensionUiResponse = Readonly<{
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function parsePiBlockingExtensionUiRequest(value: unknown): PiBlockingExtensionUiRequest | null {
  const request = asRecord(value);
  if (request?.type !== 'extension_ui_request') return null;
  const id = readString(request.id);
  const title = readString(request.title);
  const method = request.method;
  if (
    !id
    || !title
    || (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor')
  ) return null;

  if (method === 'select') {
    if (!Array.isArray(request.options)) return null;
    const options = request.options.map(readString);
    if (options.some((option) => option === null) || options.length === 0) return null;
    return { id, method, title, options: options as string[] };
  }
  if (method === 'confirm') {
    return { id, method, title, ...(readString(request.message) ? { message: readString(request.message)! } : {}) };
  }
  if (method === 'input') {
    return { id, method, title, ...(readString(request.placeholder) ? { placeholder: readString(request.placeholder)! } : {}) };
  }
  return { id, method, title, ...(readString(request.prefill) ? { prefill: readString(request.prefill)! } : {}) };
}

export function buildPiExtensionAskUserQuestionInput(request: PiBlockingExtensionUiRequest): unknown {
  if (request.method === 'select') {
    return {
      questions: [{
        id: request.id,
        question: request.title,
        header: 'Pi',
        multiSelect: false,
        options: [...(request.options ?? [])],
      }],
    };
  }
  if (request.method === 'confirm') {
    return {
      questions: [{
        id: request.id,
        question: request.message ? `${request.title}\n\n${request.message}` : request.title,
        header: 'Pi',
        multiSelect: false,
        options: ['Yes', 'No'],
      }],
    };
  }
  return {
    questions: [{
      id: request.id,
      question: request.title,
      header: 'Pi',
      multiSelect: false,
      options: [],
      freeform: {
        ...(request.method === 'input' && request.placeholder ? { placeholder: request.placeholder } : {}),
        ...(request.method === 'editor' && request.prefill ? { initialValue: request.prefill } : {}),
      },
    }],
  };
}

function readSingleAnswer(result: PermissionResult): string | null {
  if (!result.answers) return null;
  for (const answers of Object.values(result.answers)) {
    const answer = answers[0];
    if (typeof answer === 'string' && answer.trim().length > 0) return answer;
  }
  return null;
}

export function buildPiExtensionUiResponse(
  request: PiBlockingExtensionUiRequest,
  result: PermissionResult,
): PiExtensionUiResponse {
  if (!result.decision.startsWith('approved')) {
    return { type: 'extension_ui_response', id: request.id, cancelled: true };
  }
  const answer = readSingleAnswer(result);
  if (!answer) return { type: 'extension_ui_response', id: request.id, cancelled: true };
  if (request.method === 'confirm') {
    return { type: 'extension_ui_response', id: request.id, confirmed: answer.toLowerCase() === 'yes' };
  }
  return { type: 'extension_ui_response', id: request.id, value: answer };
}
