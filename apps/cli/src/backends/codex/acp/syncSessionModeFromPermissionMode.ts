import type { AcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { Metadata, PermissionMode } from '@/api/types';

type SessionMode = {
  id: string;
  name: string;
  description?: string;
};

function pickModeIdByPreferredTokens(modes: SessionMode[], tokens: string[]): string | null {
  const normalizedTokens = tokens.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (normalizedTokens.length === 0) return null;

  for (const token of normalizedTokens) {
    const byId = modes.find((m) => m.id.trim().toLowerCase() === token);
    if (byId) return byId.id;
  }

  for (const token of normalizedTokens) {
    const byName = modes.find((m) => m.name.trim().toLowerCase() === token);
    if (byName) return byName.id;
  }

  for (const token of normalizedTokens) {
    const byNameContains = modes.find((m) => m.name.trim().toLowerCase().includes(token));
    if (byNameContains) return byNameContains.id;
  }

  return null;
}

export async function syncCodexAcpSessionModeFromPermissionMode(_params: {
  runtime: AcpRuntime;
  permissionMode: PermissionMode;
  metadata: Metadata | null;
}): Promise<void> {
  const metadata = _params.metadata;
  const sessionModes = (metadata as any)?.acpSessionModesV1 as
    | {
        currentModeId: string;
        availableModes: SessionMode[];
      }
    | undefined;

  const modes = Array.isArray(sessionModes?.availableModes) ? sessionModes!.availableModes : [];
  if (!sessionModes || modes.length === 0) return;

  const desiredModeId = (() => {
    switch (_params.permissionMode) {
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
        // Codex ACP session modes are provider-defined (Codex ACP uses them as approval presets).
        // We do not treat "plan" as a permission concept here.
        return null;
      default:
        return null;
    }
  })();

  if (!desiredModeId) return;
  if (desiredModeId === sessionModes.currentModeId) return;

  await _params.runtime.setSessionMode(desiredModeId);
}
