import type { ActionExecuteResult } from '@happier-dev/protocol';

export type NormalizedCliActionExecuteResult =
  | Readonly<{
    ok: true;
    data: unknown;
  }>
  | Readonly<{
    ok: false;
    errorCode: string;
    errorMessage?: string;
    candidates?: readonly string[];
    details?: unknown;
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeErrorCode(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw : null;
}

function normalizeErrorMessage(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw : null;
}

export function normalizeActionExecuteResult(result: ActionExecuteResult): NormalizedCliActionExecuteResult {
  if (!result.ok) {
    return {
      ok: false,
      errorCode: result.errorCode,
      ...(result.error ? { errorMessage: result.error } : {}),
      ...(result.details !== undefined ? { details: result.details } : {}),
    };
  }

  const data = result.result;
  const dataObj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (dataObj && dataObj.ok === false) {
    const errorCode = normalizeErrorCode(dataObj.errorCode) ?? normalizeErrorCode(dataObj.code) ?? 'action_failed';
    const errorMessage = normalizeErrorMessage(dataObj.error)
      ?? normalizeErrorMessage(dataObj.errorMessage)
      ?? normalizeErrorMessage(dataObj.message)
      ?? undefined;
    const candidates = Array.isArray(dataObj.candidates) ? (dataObj.candidates.map((v) => String(v)) as string[]) : undefined;
    const details = dataObj.details;
    return {
      ok: false,
      errorCode,
      ...(errorMessage ? { errorMessage } : {}),
      ...(candidates && candidates.length > 0 ? { candidates } : {}),
      ...(details !== undefined ? { details } : {}),
    };
  }

  return { ok: true, data };
}

export function unwrapCliActionSuccessPayload(data: unknown): unknown {
  if (!isRecord(data) || data.ok !== true) {
    return data;
  }

  if (Object.hasOwn(data, 'data')) {
    return data.data;
  }

  const { ok: _ok, ...payload } = data;
  return payload;
}
