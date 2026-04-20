import type { Metadata, PermissionMode } from '@/api/types';
import type { Session } from '../runtime/session/ClaudeSession';
import { resolveSessionModeOverrideFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from './permissionMode';
import { inferPermissionIntentFromClaudeArgs } from './inferPermissionIntentFromArgs';
import { resolveClaudeCodeExperimentalEnvOverlay } from '../spawn/resolveClaudeCodeExperimentalEnvOverlay';

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
    getMetadataSnapshot: () => Metadata | null | undefined;
}>): Promise<Readonly<{
    claudeArgs: string[] | undefined;
    happierMcpConfigJson: string;
    envOverlay: Record<string, string>;
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
    };
}
