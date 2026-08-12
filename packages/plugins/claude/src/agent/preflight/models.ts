import type { ExecService } from '@happier-dev/plugin-sdk/exec';
const CLAUDE_CLI_HELP_COMMAND_ARGS = ['--help'] as const;
const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 250;
const PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;

function claudeHelpSupportsEffort(helpText: string | null): boolean {
    return typeof helpText === 'string' && /\B--effort\b/i.test(helpText);
}

function buildClaudePreflightEnv(
    env: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === 'string') output[key] = value;
    }
    output.CI = '1';
    return output;
}

export async function probeClaudeSupportsEffortRaw(params: Readonly<{
    exec: ExecService;
    cwd: string;
    timeoutMs: number;
    env?: Readonly<Record<string, string | undefined>>;
}>): Promise<boolean> {
    try {
        const resolved = await params.exec.systemTools.resolve({
            toolId: 'claude-cli',
            purpose: 'Probe Claude effort support',
            cwd: params.cwd,
        });
        const result = await params.exec.run({
            executable: resolved.executable,
            args: CLAUDE_CLI_HELP_COMMAND_ARGS,
            cwd: { root: 'workspace', relativePath: '' },
            env: buildClaudePreflightEnv(params.env),
            maxStderrBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
            maxStdoutBytes: PREFLIGHT_OUTPUT_MAX_BYTES,
            timeoutMs: Math.max(MIN_PREFLIGHT_MODELS_TIMEOUT_MS, params.timeoutMs),
        });
        if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) return false;
        const decoder = new TextDecoder();
        const stdout = decoder.decode(result.stdout);
        const helpText = stdout.trim() ? stdout : decoder.decode(result.stderr);
        return claudeHelpSupportsEffort(helpText);
    } catch {
        return false;
    }
}
