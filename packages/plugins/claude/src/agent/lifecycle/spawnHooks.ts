import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

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
    resolveSystemTool(input: Readonly<{
        toolId: string;
        lookupNames?: readonly string[];
        sourcePreference?: 'system-first' | 'managed-first';
        reason: string;
    }>): Promise<ClaudeDaemonResolvedTool>;
}>;

type ClaudeDaemonSpawnHookContext = Partial<PluginInvocationContext> & Readonly<{
    tools?: ClaudeDaemonSpawnToolResolutionContext;
}>;

type ClaudeDaemonSpawnPrerequisiteResult =
    | Readonly<{ decision: 'allow' }>
    | Readonly<{ decision: 'deny'; reasonCode: string; errorMessage: string }>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readHookPayload(event: unknown): Readonly<Record<string, unknown>> {
    const record = readRecord(event);
    return readRecord(record?.payload) ?? record ?? {};
}

function readEnvFromEvent(event: unknown): NodeJS.ProcessEnv {
    const env = readRecord(readHookPayload(event).env);
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
        decision: 'deny',
        reasonCode: 'claude_cli_unavailable',
        errorMessage,
    };
}

export async function resolveClaudeDaemonSpawnPrerequisites(
    _event: unknown,
    context?: ClaudeDaemonSpawnHookContext,
): Promise<ClaudeDaemonSpawnPrerequisiteResult> {
    const tools = context?.tools;
    if (!tools) {
        return denyClaudeCliUnavailable('Claude daemon spawn requires the daemon tool-resolution context.');
    }

    const resolvedTool = await tools.resolveSystemTool({
        toolId: 'claude',
        lookupNames: ['claude'],
        sourcePreference: 'system-first',
        reason: 'Claude daemon spawn requires the Claude Code CLI command.',
    });

    if (resolvedTool.ok) {
        return { decision: 'allow' };
    }

    return denyClaudeCliUnavailable(resolvedTool.errorMessage);
}

export function augmentClaudeDaemonSpawnEnv(event: unknown): Record<string, string> {
    const claudeConfigDir = resolveClaudeConfigDirOverride(readEnvFromEvent(event));
    if (!claudeConfigDir) {
        return {};
    }

    return {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
    };
}
