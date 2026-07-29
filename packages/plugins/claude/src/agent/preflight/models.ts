import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';
import { AGENT_MODEL_CONFIG, type AgentModelDescriptor } from '@happier-dev/plugin-sdk/experimental/agents';

export type ClaudePreflightModel = Readonly<{
    id: string;
    name: string;
    description?: string;
    contextWindowTokens?: number;
    modelOptions?: AgentModelDescriptor['modelOptions'] | undefined;
}>;

const CLAUDE_CLI_HELP_COMMAND_ARGS = ['--help'] as const;
const MIN_PREFLIGHT_MODELS_TIMEOUT_MS = 250;
const PREFLIGHT_OUTPUT_MAX_BYTES = 256 * 1024;

function buildClaudePreflightEnv(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === 'string') output[key] = value;
    }
    output.CI = '1';
    return output;
}

export async function probeClaudePreflightModels(params: Readonly<{
    cwd: string;
    timeoutMs: number;
    probeHelpText: (params: Readonly<{ cwd: string; timeoutMs: number }>) => Promise<string | null>;
}>): Promise<ClaudePreflightModel[] | null> {
    const helpText = await params.probeHelpText({ cwd: params.cwd, timeoutMs: params.timeoutMs });
    if (!helpText) return null;

    const supportsEffort = /\B--effort\b/i.test(helpText);
    if (!supportsEffort) return null;

    const models = AGENT_MODEL_CONFIG.claude.staticModels ?? [];
    return models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(Array.isArray(model.modelOptions) && model.modelOptions.length > 0
            ? { modelOptions: model.modelOptions }
            : { modelOptions: undefined }),
    }));
}

export async function probeClaudePreflightModelsRaw(params: Readonly<{
    exec: PluginExecService;
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
}>): Promise<ClaudePreflightModel[] | null> {
    const resolved = await params.exec.systemTools.resolve({
        toolId: 'claude-cli',
        purpose: 'Probe Claude models',
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
    if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) return null;
    const decoder = new TextDecoder();
    const stdout = decoder.decode(result.stdout);
    const helpText = stdout.trim() ? stdout : decoder.decode(result.stderr);
    return await probeClaudePreflightModels({
        cwd: params.cwd,
        timeoutMs: params.timeoutMs,
        probeHelpText: async () => helpText,
    });
}
