import { parseTrustedHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { resolveCanonicalToolNameFromHappierToolsShellBridge } from '@/agent/tools/normalization/happierToolsShellBridgeCanonicalization';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

export function extractHappierToolsShellBridgeToolNameHint(input: Record<string, unknown>): string | null {
  const record = asRecord(input);
  if (!record) return null;

  const rawCommand =
    typeof record.command === 'string'
      ? record.command
      : typeof record.cmd === 'string'
        ? record.cmd
        : null;

  const parsed = rawCommand ? parseTrustedHappierToolsShellBridgeCommand(rawCommand) : null;
  if (!parsed) return null;

  return resolveCanonicalToolNameFromHappierToolsShellBridge({ happierToolsShellBridge: parsed });
}
