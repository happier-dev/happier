import type { Metadata, PermissionMode } from '@/api/types';
import type { Session } from '../runtime/session/ClaudeSession';
import type { EnhancedMode } from '../runtime/claudeEnhancedMode';
import { resolveSessionModeOverrideFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from './permissionMode';
import { resolveClaudeCodeExperimentalEnvOverlay } from '@happier-dev/plugins-claude/agent/runtime/remote/sdk';
import { inferPermissionIntentFromClaudeArgs } from '@happier-dev/plugins-claude/agent/runtime/permissionMode';

function normalizeOptionalString(value: unknown): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function upsertClaudePermissionModeArgs(
    args: string[] | undefined,
    mode: { permissionMode: PermissionMode; agentModeId?: string | null },
): string[] | undefined {
    const filtered: string[] = [];
    const input = args ?? [];
    const inferredPermissionIntent = inferPermissionIntentFromClaudeArgs(input);

    for (let i = 0; i < input.length; i++) {
        const arg = input[i];
        if (arg === '--permission-mode') {
            if (i + 1 < input.length) {
                i++;
            }
            continue;
        }
        if (arg.startsWith('--permission-mode=')) {
            continue;
        }
        if (arg === '--dangerously-skip-permissions') {
            continue;
        }
        filtered.push(arg);
    }

    const claudeMode = resolveClaudeSdkPermissionModeFromEnhancedMode(
        mode.permissionMode === 'default' && typeof inferredPermissionIntent === 'string'
            ? { ...mode, permissionMode: inferredPermissionIntent }
            : mode,
    );
    if (claudeMode !== 'default') {
        filtered.push('--permission-mode', claudeMode);
    }

    return filtered.length > 0 ? filtered : undefined;
}

export async function resolveClaudeLocalLaunchRequest(params: Readonly<{
    session: Session;
    mode?: EnhancedMode;
    getMetadataSnapshot: () => Metadata | null | undefined;
}>): Promise<Readonly<{
    claudeArgs: string[] | undefined;
    happierMcpConfigJson: string;
    envOverlay: Record<string, string>;
    model: string | undefined;
    fallbackModel: string | undefined;
    customSystemPrompt: string | undefined;
    appendSystemPrompt: string | undefined;
}>> {
    const metadataSnapshot = params.getMetadataSnapshot();
    const resolvedAgentMode = resolveSessionModeOverrideFromMetadataSnapshot({
        metadata: metadataSnapshot,
    });

    const claudeArgs = upsertClaudePermissionModeArgs(params.session.claudeArgs, {
        permissionMode: params.session.lastPermissionMode,
        agentModeId: resolvedAgentMode ? resolvedAgentMode.modeId : null,
    });

    const { mcpConfigJson: happierMcpConfigJson } = await params.session.getOrCreateHappierMcpBridge();

    return {
        claudeArgs,
        happierMcpConfigJson,
        envOverlay: resolveClaudeCodeExperimentalEnvOverlay({
            claudeCodeExperimentalAgentTeamsEnabled: params.session.claudeCodeExperimentalAgentTeamsEnabled,
        }),
        model: normalizeOptionalString(params.mode?.model),
        fallbackModel: normalizeOptionalString(params.mode?.fallbackModel),
        customSystemPrompt: normalizeOptionalString(params.mode?.customSystemPrompt),
        appendSystemPrompt: normalizeOptionalString(params.mode?.appendSystemPrompt),
    };
}
