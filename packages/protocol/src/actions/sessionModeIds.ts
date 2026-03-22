type SessionModeOptionLike =
  | Readonly<{ id: string }>
  | Readonly<{ value: string }>;

function normalizeModeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function readOptionModeId(option: SessionModeOptionLike): string {
  if ('id' in option) return normalizeModeId(option.id);
  return normalizeModeId(option.value);
}

export function resolveRequestedSessionModeId(
  requestedModeId: string,
  options: readonly SessionModeOptionLike[] | null | undefined,
): string {
  const normalizedRequestedModeId = normalizeModeId(requestedModeId);
  if (normalizedRequestedModeId !== 'default') return normalizedRequestedModeId;
  return Array.isArray(options) && options.some((option) => readOptionModeId(option) === 'default')
    ? 'default'
    : '';
}
