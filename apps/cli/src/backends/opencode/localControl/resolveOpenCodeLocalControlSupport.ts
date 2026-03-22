export type OpenCodeLocalControlSupport =
  | { ok: true }
  | { ok: false; reason: 'tty_unavailable' | 'backend_mode_unsupported' };

export function resolveOpenCodeLocalControlSupport(params: Readonly<{
  backendMode: 'server' | 'acp';
  hasTTY: boolean;
}>): OpenCodeLocalControlSupport {
  if (params.backendMode !== 'server') {
    return { ok: false, reason: 'backend_mode_unsupported' };
  }
  if (params.hasTTY !== true) {
    return { ok: false, reason: 'tty_unavailable' };
  }
  return { ok: true };
}
