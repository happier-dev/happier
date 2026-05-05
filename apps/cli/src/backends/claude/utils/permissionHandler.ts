import { logger } from "@/lib";
import { SDKMessage } from "../sdk";
import { Session } from "../runtime/session/ClaudeSession";
import type { EnhancedMode, PermissionMode } from "../runtime/claudeEnhancedMode";
import type { PermissionResult } from "../sdk/types";

import type { PermissionResponse } from './permissionCore';
import type { PermissionRpcPayload } from './permissionRpc';
import { ClaudePermissionRuntime } from './permissionRuntime';
import { ClaudePermissionToolCallLedger } from './permissionToolCallLedger';

export class PermissionHandler {
    private readonly toolCallLedger = new ClaudePermissionToolCallLedger();
    private readonly runtime: ClaudePermissionRuntime;

    constructor(private readonly session: Session) {
        this.runtime = new ClaudePermissionRuntime(this.session, this.toolCallLedger);
        this.session.getOrCreatePermissionRpcRouter().registerConsumer({
            name: 'claude-remote-permission-handler',
            tryHandlePermissionRpc: (payload: PermissionRpcPayload) => this.runtime.tryHandlePermissionRpc(payload),
        });
    }

    approveToolCall(toolCallId: string, opts?: { answers?: Record<string, string> }): void {
        this.runtime.approveToolCall(toolCallId, opts);
    }
    
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.runtime.setOnPermissionRequest(callback);
    }

    handleModeChange(mode: PermissionMode) {
        this.runtime.handleModeChange(mode);
    }

    handleToolCall = async (
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: {
            signal: AbortSignal;
            /**
             * Optional tool use id supplied by upstream runtimes (e.g. Agent SDK).
             * When provided, we must use it directly instead of trying to infer it
             * from transcript/tool_use events (which may not have been observed yet).
             */
            toolUseId?: string | null;
            agentId?: string | null;
            suggestions?: unknown;
            blockedPath?: string | null;
            decisionReason?: string | null;
        },
    ): Promise<PermissionResult> => {
        return this.runtime.handleToolCall(toolName, input, mode, options);
    }

    onMessage(message: SDKMessage): void {
        this.toolCallLedger.onMessage(message);
    }

    isAborted(toolCallId: string): boolean {
        return this.toolCallLedger.isAborted(toolCallId);
    }

    reset(): void {
        this.toolCallLedger.reset();
        this.runtime.reset();
    }

    async resetAndFlush(): Promise<void> {
        this.reset();
        try {
            await this.session.client.flush?.();
        } catch (error) {
            logger.debug('[Claude] Failed to flush session after permission reset (non-fatal)', error);
        }
    }

    dispose(): void {
        this.runtime.dispose();
    }

    getResponses(): Map<string, PermissionResponse> {
        return this.toolCallLedger.getResponses();
    }
}
