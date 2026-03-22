import {
  parseHappierToolsShellBridgeCommand,
  type HappierToolsShellBridgeCommand,
} from '@happier-dev/protocol';
import { isChangeTitleToolNameAlias } from '@happier-dev/protocol/tools/v2';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function isBridgeCommand(value: unknown): value is HappierToolsShellBridgeCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as UnknownRecord;
  return (record.kind === 'call' || record.kind === 'list') && typeof record.rawCommand === 'string';
}

function canonicalizeBridgeCommand(command: HappierToolsShellBridgeCommand): string | null {
  if (command.kind !== 'call') return null;

  if (command.source === 'happier') {
    if (command.tool.includes('/')) return null;
    if (isChangeTitleToolNameAlias(command.tool)) return 'change_title';
    return command.tool;
  }

  if (command.source === 'custom' && command.tool.includes('/')) {
    const [serverId, ...toolParts] = command.tool.split('/').filter(Boolean);
    if (!serverId || toolParts.length === 0) return null;
    return `mcp__${serverId}__${toolParts.join('__')}`;
  }

  return `mcp__${command.source}__${command.tool.replaceAll('/', '__')}`;
}

export function extractHappierToolsShellBridgeToolNameHint(input: Record<string, unknown>): string | null {
  const record = asRecord(input);
  if (!record) return null;

  const embedded = isBridgeCommand(record.happierToolsShellBridge)
    ? record.happierToolsShellBridge
    : null;

  const rawCommand =
    typeof record.command === 'string'
      ? record.command
      : typeof record.cmd === 'string'
        ? record.cmd
        : null;

  const parsed = embedded ?? (rawCommand ? parseHappierToolsShellBridgeCommand(rawCommand) : null);
  if (!parsed) return null;

  return canonicalizeBridgeCommand(parsed);
}
