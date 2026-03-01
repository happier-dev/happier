import { maybeParseJson } from './parseJson';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function stripLeadingEnvAssignments(input: string): string {
    const parts = input.trim().split(/\s+/);
    let i = 0;
    while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
        i++;
    }
    return parts.slice(i).join(' ');
}

function stripLeadingUnsetPrelude(input: string): string {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith('unset ')) return input;
    // Only strip a simple "unset VAR VAR2; <cmd>" prelude. If there is no semicolon,
    // or if it looks like a real unset invocation (flags/assignments), keep it.
    const match = trimmed.match(/^unset(?:\s+[A-Za-z_][A-Za-z0-9_]*)+\s*;\s*/);
    if (!match) return input;
    return trimmed.slice(match[0].length);
}

/**
 * Strip a UX-noise prelude that some agent runtimes prepend to shell commands.
 *
 * In Claude Code, Bash tool calls are often prefixed with an `unset ...;` segment to scrub
 * auth-related env vars before executing the actual command.
 *
 * This helper is display-oriented: it preserves the *raw* command in tool input (details view),
 * but returns a clearer "effective command" for titles/subtitles and terminal previews.
 */
export function stripShellCommandPreludeForDisplay(command: string): string {
    let out = command.trim();
    for (let i = 0; i < 5; i++) {
        const next = stripLeadingUnsetPrelude(stripLeadingEnvAssignments(out)).trim();
        if (next === out) break;
        out = next;
    }
    return out;
}

function extractCommandArrayLike(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        parts.push(item);
    }
    return parts;
}

export function extractShellCommand(input: unknown): string | null {
    const parsed = maybeParseJson(input);

    // Sometimes we get raw argv arrays directly (e.g. ['echo', 'hi']).
    const rawArgvArray = extractCommandArrayLike(parsed);
    if (rawArgvArray && rawArgvArray.length > 0) {
        // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
        if (
            rawArgvArray.length >= 3
            && (rawArgvArray[0] === 'bash'
                || rawArgvArray[0] === '/bin/bash'
                || rawArgvArray[0] === 'zsh'
                || rawArgvArray[0] === '/bin/zsh')
            && rawArgvArray[1] === '-lc'
            && typeof rawArgvArray[2] === 'string'
        ) {
            return rawArgvArray[2];
        }
        return rawArgvArray.join(' ');
    }

    const obj = asRecord(parsed);
    if (!obj) return null;

    // Common: { command: string }
    const command = obj.command;
    if (typeof command === 'string' && command.trim().length > 0) {
        return command.trim();
    }

    // Common: { command: string[] }
    const cmdArray = extractCommandArrayLike(command);
    if (cmdArray && cmdArray.length > 0) {
        // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
        if (
            cmdArray.length >= 3
            && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh')
            && cmdArray[1] === '-lc'
            && typeof cmdArray[2] === 'string'
        ) {
            return cmdArray[2];
        }
        return cmdArray.join(' ');
    }

    // Common: { cmd: string | string[] }
    const cmd = obj.cmd;
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
        return cmd.trim();
    }
    const cmdArray2 = extractCommandArrayLike(cmd);
    if (cmdArray2 && cmdArray2.length > 0) {
        return extractShellCommand({ command: cmdArray2 });
    }

    // Common: { argv: string[] }
    const argvArray = extractCommandArrayLike(obj.argv);
    if (argvArray && argvArray.length > 0) {
        return extractShellCommand({ command: argvArray });
    }

    // Our ACP parser wraps raw arrays as { items: [...] }
    const itemsArray = extractCommandArrayLike(obj.items);
    if (itemsArray && itemsArray.length > 0) {
        return extractShellCommand({ command: itemsArray });
    }

    // Nested: { toolCall: { rawInput: { command } } }
    const toolCall = asRecord(obj.toolCall);
    const rawInput = toolCall ? asRecord(toolCall.rawInput) : null;
    if (rawInput) {
        return extractShellCommand(rawInput);
    }

    return null;
}
