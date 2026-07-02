import { resolveClaudeConfigDirOverride } from '../surfaces/sessions/handoff/path.js';

type ClaudeDaemonResolvedTool =
    | Readonly<{
        ok: true;
        command: string;
        args: readonly string[];
    }>
    | Readonly<{
        ok: false;
        errorMessage: string;
    }>;

type ClaudeDaemonSpawnToolResolutionContext = Readonly<{
    resolveManagedInstallable(input: Readonly<{
        installableId: string;
        sourcePreference?: 'system-first' | 'managed-first';
        reason: string;
    }>): Promise<ClaudeDaemonResolvedTool>;
}>;

type ClaudeDaemonSpawnHookContext = Readonly<{
    tools?: ClaudeDaemonSpawnToolResolutionContext;
}>;

type ClaudeDaemonSpawnPrerequisiteResult = Readonly<{
    allowed: boolean;
    reasonCode?: string;
    errorMessage?: string;
}>;

type ClaudeDaemonHookEvent = Readonly<{
    payload?: unknown;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readEnvFromEvent(event: ClaudeDaemonHookEvent): NodeJS.ProcessEnv {
    const env = readRecord(readRecord(event.payload)?.env);
    if (!env) return process.env;
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') {
            out[key] = value;
        }
    }
    return out;
}

function denyClaudeCliUnavailable(errorMessage: string): ClaudeDaemonSpawnPrerequisiteResult {
    return {
        allowed: false,
        reasonCode: 'claude_cli_unavailable',
        errorMessage,
    };
}

export async function resolveClaudeDaemonSpawnPrerequisites(
    _event: ClaudeDaemonHookEvent,
    context?: ClaudeDaemonSpawnHookContext,
): Promise<ClaudeDaemonSpawnPrerequisiteResult> {
    const tools = context?.tools;
    if (!tools) {
        return denyClaudeCliUnavailable('Claude daemon spawn requires the daemon tool-resolution context.');
    }

    const resolvedTool = await tools.resolveManagedInstallable({
        installableId: 'claude',
        sourcePreference: 'system-first',
        reason: 'Claude daemon spawn requires the Claude Code CLI command.',
    });

    if (resolvedTool.ok) {
        return { allowed: true };
    }

    return denyClaudeCliUnavailable(resolvedTool.errorMessage);
}

export function augmentClaudeDaemonSpawnEnv(event: ClaudeDaemonHookEvent): Record<string, string> {
    const claudeConfigDir = resolveClaudeConfigDirOverride(readEnvFromEvent(event));
    if (!claudeConfigDir) {
        return {};
    }

    return {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
    };
}
