import type { AccountSettings } from '@happier-dev/protocol';

export type EffectiveSessionTmuxResolution = Readonly<{
  useTmux: boolean;
  source: 'machine-override' | 'global' | 'default';
}>;

function readGlobalUseTmux(settings: AccountSettings | null | undefined): boolean | null {
  const value = (settings as { sessionUseTmux?: unknown } | null | undefined)?.sessionUseTmux;
  return typeof value === 'boolean' ? value : null;
}

function readMachineUseTmux(
  settings: AccountSettings | null | undefined,
  machineId: string | null | undefined,
): boolean | null {
  const id = String(machineId ?? '').trim();
  if (!id) return null;
  const map = (settings as { sessionTmuxByMachineId?: unknown } | null | undefined)?.sessionTmuxByMachineId;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry = (map as Record<string, unknown>)[id];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const useTmux = (entry as { useTmux?: unknown }).useTmux;
  return typeof useTmux === 'boolean' ? useTmux : null;
}

export function resolveEffectiveSessionTmuxFromAccountSettings(params: Readonly<{
  accountSettings: AccountSettings | null | undefined;
  currentMachineId: string | null | undefined;
}>): EffectiveSessionTmuxResolution {
  const machineOverride = readMachineUseTmux(params.accountSettings, params.currentMachineId);
  if (machineOverride !== null) {
    return { useTmux: machineOverride, source: 'machine-override' };
  }
  const global = readGlobalUseTmux(params.accountSettings);
  if (global !== null) {
    return { useTmux: global, source: 'global' };
  }
  return { useTmux: false, source: 'default' };
}
