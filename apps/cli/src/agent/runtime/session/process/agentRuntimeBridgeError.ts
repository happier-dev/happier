const FALLBACK_CODE = 'agent_runtime_bridge_failed';
const MAX_CODE_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 4_096;

export function normalizeAgentRuntimeBridgeError(
  error: unknown,
  fallbackCode: string = FALLBACK_CODE,
): Readonly<{ code: string; message: string }> {
  const rawCode = error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code.trim()
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
