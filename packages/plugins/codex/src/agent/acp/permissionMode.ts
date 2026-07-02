export type CodexAcpSessionMode = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

export type CodexAcpSessionModesState = Readonly<{
  currentModeId: string;
  availableModes: readonly CodexAcpSessionMode[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readCodexAcpSessionMode(value: unknown): CodexAcpSessionMode | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const name = readString(value.name);
  if (!id || !name) return null;
  const description = readString(value.description);
  return {
    id,
    name,
    ...(description ? { description } : {}),
  };
}

function readCodexAcpSessionModesState(value: unknown): CodexAcpSessionModesState | null {
  if (!isRecord(value)) return null;
  const currentModeId = readString(value.currentModeId);
  if (!currentModeId || !Array.isArray(value.availableModes)) return null;
  const availableModes = value.availableModes
    .map(readCodexAcpSessionMode)
    .filter((mode): mode is CodexAcpSessionMode => mode !== null);
  return {
    currentModeId,
    availableModes,
  };
}

function readCodexAcpSessionModesStateFromMetadata(metadata: unknown): CodexAcpSessionModesState | null {
  if (!isRecord(metadata)) return null;
  return readCodexAcpSessionModesState(metadata.sessionModesV1)
    ?? readCodexAcpSessionModesState(metadata.acpSessionModesV1);
}

function pickModeIdByPreferredTokens(
  modes: readonly CodexAcpSessionMode[],
  tokens: readonly string[],
): string | null {
  const normalizedTokens = tokens.map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (normalizedTokens.length === 0) return null;

  for (const token of normalizedTokens) {
    const byId = modes.find((mode) => mode.id.trim().toLowerCase() === token);
    if (byId) return byId.id;
  }

  for (const token of normalizedTokens) {
    const byName = modes.find((mode) => mode.name.trim().toLowerCase() === token);
    if (byName) return byName.id;
  }

  for (const token of normalizedTokens) {
    const byNameContains = modes.find((mode) => mode.name.trim().toLowerCase().includes(token));
    if (byNameContains) return byNameContains.id;
  }

  return null;
}

export function resolveCodexAcpSessionModeForPermissionMode(params: Readonly<{
  permissionMode: string;
  sessionModes: CodexAcpSessionModesState | null;
}>): string | null {
  const modes = Array.isArray(params.sessionModes?.availableModes)
    ? params.sessionModes.availableModes
    : [];
  if (!params.sessionModes || modes.length === 0) return null;

  switch (params.permissionMode) {
    case 'read-only':
      return pickModeIdByPreferredTokens(modes, ['read-only', 'readonly', 'ro']);
    case 'safe-yolo':
      return pickModeIdByPreferredTokens(modes, ['workspace-write', 'safe-yolo', 'untrusted']);
    case 'yolo':
    case 'bypassPermissions':
      return pickModeIdByPreferredTokens(modes, ['danger-full-access', 'yolo', 'never', 'bypass']);
    case 'default':
      return pickModeIdByPreferredTokens(modes, ['default', 'ask', 'on-request', 'prompt']);
    case 'plan':
    default:
      return null;
  }
}

export function resolveCodexAcpSessionModeSyncTarget(params: Readonly<{
  permissionMode: string;
  metadata: unknown;
}>): string | null {
  const sessionModes = readCodexAcpSessionModesStateFromMetadata(params.metadata);
  const desiredModeId = resolveCodexAcpSessionModeForPermissionMode({
    permissionMode: params.permissionMode,
    sessionModes,
  });
  if (!desiredModeId || desiredModeId === sessionModes?.currentModeId) return null;
  return desiredModeId;
}
