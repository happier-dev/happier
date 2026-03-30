import {
    parseHappierToolsShellBridgeCommand,
    type HappierToolsShellBridgeCommand,
} from '@happier-dev/protocol';

import { extractShellCommand } from './shellCommand';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function isShellBridgeCommand(value: unknown): value is HappierToolsShellBridgeCommand {
    const record = asRecord(value);
    if (!record) return false;
    if (record.kind !== 'list' && record.kind !== 'call') return false;
    return typeof record.rawCommand === 'string';
}

export function extractHappierToolsShellBridgeCommand(input: unknown): HappierToolsShellBridgeCommand | null {
    const record = asRecord(input);
    const embedded = record?.happierToolsShellBridge;
    if (isShellBridgeCommand(embedded)) return embedded;

    const command = extractShellCommand(input);
    if (!command) return null;
    return parseHappierToolsShellBridgeCommand(command);
}
