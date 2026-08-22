import { assertClaudeMcpConfigArgsSafeForDirectSpawn } from '../../mcp/materializeConfigArgs.js';

export type ClaudeTerminalSpawnOptionOverrides = Readonly<{
    model?: string | null;
    fallbackModel?: string | null;
    customSystemPrompt?: string | null;
    appendSystemPrompt?: string | null;
}>;

export type ClaudeTerminalUserArgPartition = Readonly<{
    flagArgs: string[];
    positionalArgs: string[];
    trailingPermissionFlagArgs: string[];
}>;

export const CLAUDE_TERMINAL_YOLO_ALLOW_FLAG = '--allow-dangerously-skip-permissions';

const FLAGS_WITH_REQUIRED_VALUE = new Set<string>([
    '--model',
    '--effort',
    '--permission-mode',
    '--settings',
    '--mcp-config',
    '--max-turns',
    '-p',
    '--allowedTools',
    '--disallowedTools',
    '--output-format',
    '--input-format',
    '--print',
    '--system-prompt',
    '--append-system-prompt',
    '--fallback-model',
    '--setting-sources',
    '--session-id',
]);

const FLAGS_WITH_OPTIONAL_VALUE = new Set<string>(['--resume', '-r']);

function normalizeNonEmptyString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readInlineFlagValue(arg: string, flag: string): string | undefined {
    const prefix = `${flag}=`;
    return arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined;
}

function readNextFlagValue(args: readonly string[], index: number): string | undefined {
    const next = index + 1 < args.length ? args[index + 1] : undefined;
    if (typeof next !== 'string') return undefined;
    if (next.startsWith('-')) return undefined;
    return next;
}

export function parseClaudeTerminalRawSpawnOptionOverrides(
    args: readonly string[] | undefined,
): Required<ClaudeTerminalSpawnOptionOverrides> {
    const input = args ?? [];
    let model: string | null = null;
    let fallbackModel: string | null = null;
    let customSystemPrompt: string | null = null;
    let appendSystemPrompt: string | null = null;

    for (let index = 0; index < input.length; index += 1) {
        const arg = input[index];
        if (typeof arg !== 'string') continue;

        const inlineModel = readInlineFlagValue(arg, '--model');
        if (inlineModel !== undefined) {
            model = normalizeNonEmptyString(inlineModel) || null;
            continue;
        }
        if (arg === '--model') {
            const value = readNextFlagValue(input, index);
            if (value !== undefined) {
                model = normalizeNonEmptyString(value) || null;
                index += 1;
            }
            continue;
        }

        const inlineFallbackModel = readInlineFlagValue(arg, '--fallback-model');
        if (inlineFallbackModel !== undefined) {
            fallbackModel = normalizeNonEmptyString(inlineFallbackModel) || null;
            continue;
        }
        if (arg === '--fallback-model') {
            const value = readNextFlagValue(input, index);
            if (value !== undefined) {
                fallbackModel = normalizeNonEmptyString(value) || null;
                index += 1;
            }
            continue;
        }

        const inlineCustomSystemPrompt = readInlineFlagValue(arg, '--system-prompt');
        if (inlineCustomSystemPrompt !== undefined) {
            customSystemPrompt = normalizeNonEmptyString(inlineCustomSystemPrompt) || null;
            continue;
        }
        if (arg === '--system-prompt') {
            const value = readNextFlagValue(input, index);
            if (value !== undefined) {
                customSystemPrompt = normalizeNonEmptyString(value) || null;
                index += 1;
            }
            continue;
        }

        const inlineAppendSystemPrompt = readInlineFlagValue(arg, '--append-system-prompt');
        if (inlineAppendSystemPrompt !== undefined) {
            appendSystemPrompt = normalizeNonEmptyString(inlineAppendSystemPrompt) || null;
            continue;
        }
        if (arg === '--append-system-prompt') {
            const value = readNextFlagValue(input, index);
            if (value !== undefined) {
                appendSystemPrompt = normalizeNonEmptyString(value) || null;
                index += 1;
            }
        }
    }

    return { model, fallbackModel, customSystemPrompt, appendSystemPrompt };
}

export function isClaudeTerminalManagedSpawnOptionFlag(arg: string): boolean {
    return (
        arg === '--model' ||
        arg === '--fallback-model' ||
        arg === '--system-prompt' ||
        arg === '--append-system-prompt'
    );
}

export function isClaudeTerminalInlineManagedSpawnOptionFlag(arg: string): boolean {
    return (
        readInlineFlagValue(arg, '--model') !== undefined ||
        readInlineFlagValue(arg, '--fallback-model') !== undefined ||
        readInlineFlagValue(arg, '--system-prompt') !== undefined ||
        readInlineFlagValue(arg, '--append-system-prompt') !== undefined
    );
}

export function partitionClaudeTerminalUserArgs(args: readonly string[] | undefined): ClaudeTerminalUserArgPartition {
    const flagArgs: string[] = [];
    const positionalArgs: string[] = [];
    let trailingPermissionFlagArgs: string[] = [];

    if (!args) {
        return { flagArgs, positionalArgs, trailingPermissionFlagArgs };
    }
    assertClaudeMcpConfigArgsSafeForDirectSpawn(args);

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === CLAUDE_TERMINAL_YOLO_ALLOW_FLAG) {
            continue;
        }
        if (arg === '--dangerously-skip-permissions') {
            trailingPermissionFlagArgs = ['--permission-mode', 'bypassPermissions'];
            continue;
        }
        if (arg === '--permission-mode') {
            const nextArg = index + 1 < args.length ? args[index + 1] : undefined;
            if (typeof nextArg === 'string' && !nextArg.startsWith('-')) {
                trailingPermissionFlagArgs = ['--permission-mode', nextArg];
                index += 1;
                continue;
            }
        }
        if (arg.startsWith('--permission-mode=')) {
            const normalizedValue = arg.slice('--permission-mode='.length).trim();
            if (normalizedValue) {
                trailingPermissionFlagArgs = ['--permission-mode', normalizedValue];
                continue;
            }
        }
        if (isClaudeTerminalInlineManagedSpawnOptionFlag(arg)) {
            continue;
        }
        if (isClaudeTerminalManagedSpawnOptionFlag(arg)) {
            const nextArg = index + 1 < args.length ? args[index + 1] : undefined;
            if (typeof nextArg === 'string' && !nextArg.startsWith('-')) {
                index += 1;
            }
            continue;
        }
        if (arg.startsWith('-')) {
            flagArgs.push(arg);
            const nextArg = index + 1 < args.length ? args[index + 1] : undefined;
            const consumesNextArg = FLAGS_WITH_REQUIRED_VALUE.has(arg)
                || (FLAGS_WITH_OPTIONAL_VALUE.has(arg) && readNextFlagValue(args, index) !== undefined);
            if (consumesNextArg && nextArg !== undefined) {
                flagArgs.push(nextArg);
                index += 1;
            }
            continue;
        }
        positionalArgs.push(arg);
    }

    return { flagArgs, positionalArgs, trailingPermissionFlagArgs };
}
