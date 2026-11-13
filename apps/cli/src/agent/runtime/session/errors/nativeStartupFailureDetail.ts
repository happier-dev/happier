import { projectPluginFailureMessage } from '@happier-dev/protocol/plugins/failureProjection';
import { SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

/** Keep the original public line boundary before redaction can trim native context. */
export function projectNativeStartupFailureMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const firstLine = value.split(/[\r\n\u2028\u2029]/u, 1)[0]?.trim();
  if (!firstLine) return undefined;
  const safe = projectPluginFailureMessage(firstLine).trim();
  return safe || undefined;
}

/** Native diagnostic projection only: never read data, stderr, stack or accessors. */
export function readNativeStartupFailureDetail(error: unknown): Readonly<{
  providerErrorCode?: string | number;
  providerErrorMessage?: string;
}> {
  const read = (value: object, key: string): unknown => {
    try { const property = Object.getOwnPropertyDescriptor(value, key); return property && 'value' in property ? property.value : undefined; }
    catch { return undefined; }
  };
  const text = (value: unknown): string | undefined =>
    projectNativeStartupFailureMessage(value)?.slice(0, SESSION_RUNTIME_ISSUE_PREVIEW_MAX_LENGTH);
  const seen = new Set<object>();
  let current = error;
  let detail: { providerErrorCode?: string | number; providerErrorMessage?: string } = {};
  if (typeof current === 'string') return { providerErrorMessage: text(current) };
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = read(current, 'code');
    const message = text(read(current, 'message'));
    const nativeCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : text(code);
    if (message || nativeCode !== undefined) detail = {
      ...(nativeCode === undefined ? {} : { providerErrorCode: nativeCode }),
      ...(message ? { providerErrorMessage: message } : {}),
    };
    current = read(current, 'cause');
    if (typeof current === 'string') {
      const message = text(current);
      if (message) detail = { providerErrorMessage: message };
    }
  }
  return detail;
}
