const FALLBACK_CODE = 'agent_runtime_bridge_failed';
const MAX_CODE_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 4_096;

export function inspectOwnErrorCodeDataProperty(
  error: unknown,
): Readonly<
  | { kind: 'absent' }
  | { kind: 'string'; value: string }
  | { kind: 'unsupported' }
> {
  if (
    (typeof error !== 'object' || error === null)
    && typeof error !== 'function'
  ) {
    return Object.freeze({ kind: 'absent' });
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor) return Object.freeze({ kind: 'absent' });
    if (!('value' in descriptor)) {
      return Object.freeze({ kind: 'unsupported' });
    }
    if (descriptor.value === undefined) {
      return Object.freeze({ kind: 'absent' });
    }
    return typeof descriptor.value === 'string'
      ? Object.freeze({ kind: 'string', value: descriptor.value })
      : Object.freeze({ kind: 'unsupported' });
  } catch {
    return Object.freeze({ kind: 'unsupported' });
  }
}

export function normalizeAgentRuntimeBridgeError(
  error: unknown,
  fallbackCode: string = FALLBACK_CODE,
): Readonly<{ code: string; message: string }> {
  const codeProperty = inspectOwnErrorCodeDataProperty(error);
  const rawCode = codeProperty.kind === 'string'
    ? codeProperty.value.trim()
    : '';
  const normalizedFallback = fallbackCode.trim().slice(0, MAX_CODE_LENGTH)
    || FALLBACK_CODE;
  const code = rawCode
    ? rawCode.slice(0, MAX_CODE_LENGTH)
    : normalizedFallback;
  const rawMessage = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    code,
    message: rawMessage.slice(0, MAX_MESSAGE_LENGTH),
  });
}
