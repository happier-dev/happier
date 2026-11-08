import type { SessionModeState } from '@/agent/acp/sessionSettings/sessionSettingsState';

/** Fixed ids retain their existing contract; candidates require Session advertisement. */
export function resolvePermissionMode(
  selection: string | readonly string[] | null | undefined,
  modes: SessionModeState | null,
): string | null | undefined {
  if (selection === null || selection === undefined || typeof selection === 'string') {
    return selection;
  }
  return selection.find(candidate => modes?.availableModes.some(mode => mode.id === candidate));
}
