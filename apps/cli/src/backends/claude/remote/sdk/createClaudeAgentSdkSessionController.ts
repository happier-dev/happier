import { join } from 'node:path';

import { logger } from '@/ui/logger';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import { mapToClaudeMode } from '@/backends/claude/utils/permissionMode';
import { getProjectPath } from '@/backends/claude/utils/path';
import type { SessionHookData } from '@happier-dev/plugins-claude/agent/hooks/protocol';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { ClaudeCompletionEvent } from '@/backends/claude/contextCompactionEvents';

import type { RuntimeSettingsSnapshot } from './agentSdk/claudeAgentSdkLaunchConfig';
import type { RunClaudeRemoteAgentSdkCanCallToolOptions } from './runAgentSdkTypes';

type SessionControllerParams = {
    initialMode: EnhancedMode;
    sessionId: string | null;
    transcriptPath: string | null;
    workDir: string;
    getClaudeConfigDir: () => string | null | undefined;
    onSessionFound: (id: string, data?: SessionHookData) => void;
    onCompletionEvent?: ((message: ClaudeCompletionEvent) => void) | undefined;
    canCallTool: (
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: RunClaudeRemoteAgentSdkCanCallToolOptions,
    ) => Promise<PermissionResult>;
    applyPermissionModeTransition: (nextPermissionMode: string) => Promise<void>;
    getLastAppliedRuntimeSettings: () => RuntimeSettingsSnapshot;
    setLastAppliedRuntimeSettings: (next: RuntimeSettingsSnapshot) => void;
};

export function createClaudeAgentSdkSessionController(params: SessionControllerParams) {
    let mode = params.initialMode;
    let latestClaudeSessionId =
        typeof params.sessionId === 'string' && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
    let latestTranscriptPath =
        typeof params.transcriptPath === 'string' && params.transcriptPath.trim().length > 0
            ? params.transcriptPath.trim()
            : null;

    const recordSessionFound = (sessionId: string, data?: SessionHookData) => {
        const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (normalized.length > 0) {
            latestClaudeSessionId = normalized;
            const explicitTranscriptPath = (() => {
                if (!data || typeof data !== 'object') return '';
                const obj: any = data;
                const raw =
                    typeof obj.transcriptPath === 'string'
                        ? obj.transcriptPath
                        : typeof obj.transcript_path === 'string'
                          ? obj.transcript_path
                          : '';
                return typeof raw === 'string' ? raw.trim() : '';
            })();
            if (explicitTranscriptPath.length > 0) {
                latestTranscriptPath = explicitTranscriptPath;
            } else if (!latestTranscriptPath) {
                latestTranscriptPath = join(
                    getProjectPath(params.workDir, params.getClaudeConfigDir() ?? undefined),
                    `${normalized}.jsonl`,
                );
            }
        }
        params.onSessionFound(normalized, data as any);
    };

    const canCallToolWithModeTransitions = async (
        toolName: string,
        input: unknown,
        resolvedMode: EnhancedMode,
        options: RunClaudeRemoteAgentSdkCanCallToolOptions,
    ): Promise<PermissionResult> => {
        const result = await params.canCallTool(toolName, input, resolvedMode, options);

        const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : '';
        const isExitPlanMode = normalizedToolName === 'ExitPlanMode' || normalizedToolName === 'exit_plan_mode';
        if (isExitPlanMode && result.behavior === 'allow') {
            mode = { ...mode, agentModeId: null };

            const nextPermissionMode = (() => {
                const mapped = mapToClaudeMode(mode.permissionMode);
                return mapped === 'plan' ? 'default' : mapped;
            })();

            try {
                await params.applyPermissionModeTransition(nextPermissionMode);
                params.setLastAppliedRuntimeSettings({
                    ...params.getLastAppliedRuntimeSettings(),
                    permissionMode: nextPermissionMode,
                });
            } catch (error) {
                logger.debug(
                    '[claudeRemoteAgentSdk] Failed to transition permission mode after ExitPlanMode (non-fatal)',
                    error,
                );
                params.onCompletionEvent?.(
                    'Failed to transition permission mode after exiting plan mode (non-fatal); continuing.',
                );
            }
        }

        return result;
    };

    return {
        getMode: () => mode,
        setMode: (nextMode: EnhancedMode) => {
            mode = nextMode;
        },
        getSessionId: () => latestClaudeSessionId,
        getTranscriptPath: () => latestTranscriptPath,
        noteLaunchStartFrom: (startFrom: string | null | undefined) => {
            if (!latestClaudeSessionId && typeof startFrom === 'string' && startFrom.trim().length > 0) {
                latestClaudeSessionId = startFrom.trim();
            }
        },
        recordSessionFound,
        canCallToolWithModeTransitions,
    };
}
