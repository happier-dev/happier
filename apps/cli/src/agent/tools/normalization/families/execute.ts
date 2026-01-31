type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        out.push(item);
    }
    return out;
}

function stripShellWrapper(argv: string[]): string | null {
    if (argv.length >= 3 && argv[1] === '-lc') {
        const shell = argv[0];
        if (shell.includes('bash') || shell.includes('zsh') || shell.includes('sh')) {
            const cmd = argv[2];
            return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd.trim() : null;
        }
    }
    return null;
}

function extractTaggedReturnCodeOutput(value: string): { stdout?: string; exit_code?: number } | null {
    const returnCodeMatch = value.match(/<return-code>\s*([0-9]+)\s*<\/return-code>/i);
    const outputMatch = value.match(/<output>\s*([\s\S]*?)\s*<\/output>/i);

    const exitCode =
        returnCodeMatch && returnCodeMatch[1]
            ? Number.parseInt(returnCodeMatch[1], 10)
            : null;
    const stdout =
        outputMatch && typeof outputMatch[1] === 'string'
            ? outputMatch[1]
            : null;

    if (exitCode == null && stdout == null) return null;
    return {
        stdout: stdout != null ? stdout.replace(/^(?:\r?\n)+/, '') : undefined,
        exit_code: Number.isFinite(exitCode as number) ? (exitCode as number) : undefined,
    };
}

export function normalizeBashInput(rawInput: unknown): { command?: string; timeout?: number } & UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const commandRaw = record.command ?? record.cmd ?? record.argv ?? record.items;
    const fromString = typeof commandRaw === 'string' && commandRaw.trim().length > 0 ? commandRaw.trim() : null;
    const fromArray = asStringArray(commandRaw);
    const stripped = fromArray ? stripShellWrapper(fromArray) : null;

    if (stripped) {
        out.command = stripped;
    } else if (fromString) {
        out.command = fromString;
    } else if (fromArray && fromArray.length > 0) {
        out.command = fromArray.join(' ');
    }

    const timeout = record.timeout;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
        out.timeout = timeout;
    }

    return out as any;
}

export function normalizeBashResult(rawOutput: unknown): UnknownRecord {
    if (rawOutput == null) return {};

    if (typeof rawOutput === 'string') {
        const extracted = extractTaggedReturnCodeOutput(rawOutput);
        if (extracted) return { ...extracted };
        return { stdout: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (!record) {
        return { stdout: String(rawOutput) };
    }

    const out: UnknownRecord = { ...record };

    if (typeof out.stdout !== 'string') {
        const candidate =
            typeof out.formatted_output === 'string'
                ? out.formatted_output
                : typeof out.aggregated_output === 'string'
                    ? out.aggregated_output
                    : null;
        if (candidate != null) out.stdout = candidate;
    }

    if (typeof out.stdout === 'string') {
        const extracted = extractTaggedReturnCodeOutput(out.stdout);
        if (extracted) {
            if (typeof extracted.stdout === 'string') out.stdout = extracted.stdout;
            if (typeof extracted.exit_code === 'number' && typeof out.exit_code !== 'number') out.exit_code = extracted.exit_code;
        }
    }

    if (typeof out.stderr !== 'string') {
        if (typeof out.error === 'string' && out.error.trim().length > 0) {
            out.stderr = out.error;
        }
    }

    const exitCode =
        typeof out.exit_code === 'number'
            ? out.exit_code
            : typeof out.exitCode === 'number'
                ? out.exitCode
                : null;
    if (exitCode != null) out.exit_code = exitCode;

    return out;
}
