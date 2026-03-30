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
  }>;

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
    };
  }

  const data = (result as any).result;
  const dataObj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (dataObj && dataObj.ok === false) {
    const errorCode = normalizeErrorCode(dataObj.errorCode) ?? normalizeErrorCode(dataObj.code) ?? 'action_failed';
    const errorMessage = normalizeErrorMessage(dataObj.error)
      ?? normalizeErrorMessage(dataObj.errorMessage)
      ?? normalizeErrorMessage(dataObj.message)
      ?? undefined;
    const candidates = Array.isArray(dataObj.candidates) ? (dataObj.candidates.map((v) => String(v)) as string[]) : undefined;
    return {
      ok: false,
      errorCode,
      ...(errorMessage ? { errorMessage } : {}),
      ...(candidates && candidates.length > 0 ? { candidates } : {}),
    };
  }

  return { ok: true, data };
}
