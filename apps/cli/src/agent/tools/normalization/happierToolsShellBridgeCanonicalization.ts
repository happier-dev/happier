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

function isHappierToolsShellBridgeCommand(value: unknown): value is HappierToolsShellBridgeCommand {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.kind !== 'call' && record.kind !== 'list') return false;
    return typeof record.rawCommand === 'string';
}

export function extractHappierToolsShellBridgeCall(rawInput: unknown): Extract<HappierToolsShellBridgeCommand, { kind: 'call' }> | null {
    const record = asRecord(rawInput);
    const embedded = record?.happierToolsShellBridge;
    const rawCommand =
        typeof record?.command === 'string'
            ? record.command
            : typeof record?.cmd === 'string'
                ? record.cmd
                : null;
    const command =
        isHappierToolsShellBridgeCommand(embedded)
            ? embedded
            : rawCommand
                ? parseHappierToolsShellBridgeCommand(rawCommand)
                : null;
    if (!command || command.kind !== 'call') return null;
    return command;
}

export function resolveCanonicalToolNameFromHappierToolsShellBridge(rawInput: unknown): string | null {
    const command = extractHappierToolsShellBridgeCall(rawInput);
    if (!command) return null;

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

export function extractCanonicalInputFromHappierToolsShellBridge(rawInput: unknown): unknown | null {
    const command = extractHappierToolsShellBridgeCall(rawInput);
    if (!command) return null;
    const args =
        command.args && typeof command.args === 'object' && !Array.isArray(command.args)
            ? { ...(command.args as Record<string, unknown>) }
            : command.args != null
                ? { value: command.args }
                : {};
    return {
        ...args,
        happierToolsShellBridge: command,
    };
}
