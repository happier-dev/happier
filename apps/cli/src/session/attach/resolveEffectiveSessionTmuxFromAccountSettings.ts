import type { AccountSettings } from '@happier-dev/protocol';

/**
 * Resolve the *effective* "spawn sessions in tmux" preference for a given
 * machine, mirroring the contract of `resolveTerminalSpawnOptions` in the
 * UI's settings layer (`apps/ui/sources/sync/domains/settings/terminalSettings.ts`).
 *
 * Why we mirror instead of importing: that helper lives under `apps/ui` and
 * is intentionally not part of a shared package. We only need the boolean
 * answer in the CLI, with one extra signal (`source`) so the user-facing
 * footer hint can be precise about *why* the answer is what it is.
 *
 * Contract — must match the UI resolver's intent:
 * - If a per-machine override exists for `currentMachineId`, that wins:
 *   `override.useTmux` becomes the answer, sourced as `'machine-override'`.
 * - Otherwise the global `sessionUseTmux` setting wins, sourced as `'global'`.
 * - When the account settings object doesn't carry the field at all (older
 *   accounts, missing data), `'default'` with `useTmux=false` per the schema
 *   default in `accountCoreSettingDefinitions.ts`.
 *
 * Tested against the same 3-by-2 matrix the UI resolver covers (global
 * on/off × override absent/on/off).
 */
export type EffectiveSessionTmuxResolution = Readonly<{
  useTmux: boolean;
  source: 'machine-override' | 'global' | 'default';
}>;

function readSessionUseTmuxGlobal(settings: AccountSettings | null | undefined): boolean | null {
  if (!settings) return null;
  const raw = (settings as { sessionUseTmux?: unknown }).sessionUseTmux;
  if (typeof raw === 'boolean') return raw;
  return null;
}

function readSessionTmuxByMachineIdEntry(
  settings: AccountSettings | null | undefined,
  machineId: string | null | undefined,
): { useTmux: boolean } | null {
  if (!settings) return null;
  const id = String(machineId ?? '').trim();
  if (!id) return null;
  const map = (settings as { sessionTmuxByMachineId?: unknown }).sessionTmuxByMachineId;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry = (map as Record<string, unknown>)[id];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const useTmux = (entry as { useTmux?: unknown }).useTmux;
  if (typeof useTmux !== 'boolean') return null;
  return { useTmux };
}

export function resolveEffectiveSessionTmuxFromAccountSettings(params: Readonly<{
  accountSettings: AccountSettings | null | undefined;
  currentMachineId: string | null | undefined;
}>): EffectiveSessionTmuxResolution {
  const override = readSessionTmuxByMachineIdEntry(params.accountSettings, params.currentMachineId);
  if (override) {
    return { useTmux: override.useTmux, source: 'machine-override' };
  }

  const global = readSessionUseTmuxGlobal(params.accountSettings);
  if (typeof global === 'boolean') {
    return { useTmux: global, source: 'global' };
  }

  return { useTmux: false, source: 'default' };
}
