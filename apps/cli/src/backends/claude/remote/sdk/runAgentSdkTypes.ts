import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { JsRuntime } from '@/backends/claude/runtime/claudeSessionRuntimeOptions';
import type { EnhancedMode } from '@/backends/claude/runtime/claudeEnhancedMode';
import type { SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { PermissionResult } from '@/backends/claude/sdk/types';
import type { SessionHookData } from '@happier-dev/plugins-claude/agent/hooks/protocol';
import type { ClaudeCompletionEvent } from '@/backends/claude/contextCompactionEvents';
import type { NormalizedClaudeUsageLimitDetails } from '@happier-dev/plugins-claude/agent/auth/services/runtime';

import type { Query as AgentSdkQueryType } from '@anthropic-ai/claude-agent-sdk';

export type AgentSdkQueryFactory = (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Record<string, unknown>;
}) => AgentSdkQueryType;

export type RunClaudeRemoteAgentSdkCanCallToolOptions = {
    signal: AbortSignal;
    toolUseId?: string | null;
    agentId?: string | null;
    suggestions?: unknown;
    blockedPath?: string | null;
    decisionReason?: string | null;
};

export type RunClaudeRemoteAgentSdkOptions = {
    sessionId: string | null;
    transcriptPath: string | null;
    path: string;
    claudeArgs?: string[];
    claudeExecutablePath?: string;
    resumeSessionAt?: string | null;
    happierMcpServers?: Record<string, unknown>;
    signal?: AbortSignal;
    canCallTool: (
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: RunClaudeRemoteAgentSdkCanCallToolOptions,
    ) => Promise<PermissionResult>;
    jsRuntime?: JsRuntime;
    nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>;
    onReady: () => void | Promise<void>;
    onSubagentFlush?: () => void | Promise<void>;
    isAborted: (toolCallId: string) => boolean;
    onSessionFound: (id: string, data?: SessionHookData) => void;
    onThinkingChange?: (thinking: boolean) => void;
    onMessage: (message: SDKMessage) => void;
    streamedTranscriptWriter?: StreamedTranscriptWriter | null;
    onCompletionEvent?: (message: ClaudeCompletionEvent) => void;
    onSessionReset?: () => void;
    setUserMessageSender?: (sender: ((message: SDKUserMessage) => void) | null) => void;
    setTurnInterrupt?: ((handler: (() => Promise<void>) | null) => void) | null;
    onCheckpointCaptured?: (checkpointId: string) => void;
    onRateLimitEvent?: (details: NormalizedClaudeUsageLimitDetails) => void | Promise<void>;
    onRuntimeAuthFailureEvent?: (error: unknown) => boolean | void | Promise<boolean | void>;
    onCapabilities?: (caps: {
        slashCommands?: string[];
        slashCommandDetails?: Array<{ command: string; description?: string }>;
        models?: unknown[];
    }) => void;
    createQuery?: AgentSdkQueryFactory;
};
