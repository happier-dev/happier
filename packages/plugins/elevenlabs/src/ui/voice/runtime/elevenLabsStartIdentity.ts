export function resolveElevenLabsStartIdentity(value: string, globalSessionId: string): Readonly<{
  controlSessionId: string;
  requestedTargetSessionId: string | null;
}> {
  const normalized = String(value ?? '').trim();
  const controlSessionId = normalized || globalSessionId;
  return {
    controlSessionId,
    requestedTargetSessionId: controlSessionId === globalSessionId
      ? null
      : controlSessionId,
  };
}
