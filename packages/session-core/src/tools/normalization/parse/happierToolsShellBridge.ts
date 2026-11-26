import { parseHappierToolsRunCommand, parseHappierToolsShellBridgeCommand } from '@happier-dev/protocol/tools/happierToolsShellBridge';
import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import type { HappierToolsShellBridgeCommand } from '@happier-dev/protocol';
import type { ScriptToolInputV2, ScriptToolResultV2 } from '@happier-dev/protocol/tools/v2';

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

function projectScriptRunnerReceipt(output: unknown): Pick<ScriptToolResultV2, 'output' | 'error' | 'calls'> {
    const receipt = asRecord(output);
    if (!receipt || typeof receipt.ok !== 'boolean' || !Array.isArray(receipt.calls)) {
        return output === undefined ? {} : { output };
    }
    const failure = receipt.ok ? null : asRecord(receipt.error);
    const calls: NonNullable<ScriptToolResultV2['calls']>[number][] = [];
    for (const value of receipt.calls) {
        const call = asRecord(value);
        if (!call || typeof call.operation !== 'string') continue;
        calls.push({
            tool: typeof call.tool === 'string' ? call.tool : call.operation,
            ...(typeof call.source === 'string' ? { source: call.source } : {}),
            status: call.ok === true ? 'completed' : call.ok === false ? 'error' : 'running',
            ...(call.ok === false && call.errorCode === failure?.code && failure?.failureCause !== undefined
                ? { refusalCause: failure.failureCause } : {}),
        });
    }
    return {
        ...(receipt.ok ? { output: receipt.result } : {}),
        ...(typeof failure?.message === 'string' ? { error: failure.message } : {}),
        calls,
    };
}

export function projectHappierToolsRunForRendering(input: unknown, result: unknown): {
    input: ScriptToolInputV2;
    result: ScriptToolResultV2 | null | undefined;
} | null {
    const command = extractShellCommand(input);
    const script = command ? parseHappierToolsRunCommand(command) : null;
    if (!script) return null;

    const record = asRecord(result);
    const stdout = typeof record?.stdout === 'string' ? record.stdout : typeof result === 'string' ? result : undefined;
    const stderr = typeof record?.stderr === 'string' ? record.stderr : undefined;
    const error = typeof record?.error === 'string' ? record.error
        : typeof record?.errorMessage === 'string' ? record.errorMessage : undefined;
    let output = record?.output;
    const outputText = stdout ?? (typeof output === 'string' ? output : undefined);
    if (outputText !== undefined) {
        try { output = JSON.parse(outputText); } catch { /* Keep raw shell output. */ }
    }
    const receipt = script.raw && output !== undefined ? { output } : projectScriptRunnerReceipt(output);

    return {
        input: { code: script.code, origin: 'cli' },
        result: result == null ? result : {
            ...(stdout === undefined ? {} : { stdout }),
            ...(stderr === undefined ? {} : { stderr }),
            ...(error === undefined ? {} : { error }),
            ...receipt,
        },
    };
}
