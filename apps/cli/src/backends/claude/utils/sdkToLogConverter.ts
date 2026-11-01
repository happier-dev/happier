/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage
} from '@/backends/claude/sdk'
import type { RawJSONLines } from '@/backends/claude/types'
import type { PermissionMode } from '@/api/types'
import { normalizeClaudeToolUseNamesInSdkMessage } from './normalizeClaudeToolUseNames'
import { providers } from '@happier-dev/agents'
import { buildClaudeSdkResultUsageTelemetry } from './sdkResultUsageTelemetry'
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers'
import { createClaudeTaskNotificationToolResultProjector, isClaudeTaskLifecycleResultEnvelope, readClaudeTaskLifecycleEnvelope } from '../taskNotifications/claudeTaskLifecycleEnvelope'
import { projectClaudePeerMessage } from '../attachments/claudePeerMessageProjection'
import { embedClaudeToolResultMetadata } from './claudeToolResultMetadata'

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    cwd: string
    version?: string
    gitBranch?: string
    parentUuid?: string | null
}

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        }).trim()
        return branch || undefined
    } catch {
        return undefined
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

function readAssistantContextUsedTokens(message: SDKAssistantMessage['message']): number | null {
    const usage = asRecord(asRecord(message)?.usage)
    if (!usage) return null

    const inputTokens = readNonNegativeInteger(usage.input_tokens)
    const cacheCreationInputTokens = readNonNegativeInteger(usage.cache_creation_input_tokens)
    const cacheReadInputTokens = readNonNegativeInteger(usage.cache_read_input_tokens)
    if (inputTokens === null && cacheCreationInputTokens === null && cacheReadInputTokens === null) {
        return null
    }

    return (inputTokens ?? 0) + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0)
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastMainUuid: string | null = null
    private latestMainAssistantContextUsedTokens: number | null = null
    private context: ConversionContext
    private responses?: Map<string, { approved: boolean, mode?: PermissionMode, reason?: string }>
    private sidechainLastUUID = new Map<string, string>();
    private taskNotificationProjector = createClaudeTaskNotificationToolResultProjector();

    constructor(
        context: Omit<ConversionContext, 'parentUuid'>,
        responses?: Map<string, { approved: boolean, mode?: PermissionMode, reason?: string }>
    ) {
        this.context = {
            ...context,
            gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
        this.responses = responses
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastMainUuid = null
        this.latestMainAssistantContextUsedTokens = null
        this.context.parentUuid = null
        this.sidechainLastUUID.clear()
        this.taskNotificationProjector.clear()
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        const fact = readClaudeTaskLifecycleEnvelope(sdkMessage);
        const rawType = (sdkMessage as any)?.type;
        if (providers.claude.isClaudeInternalEventType(rawType) && rawType !== 'attachment'
            && !isClaudeTaskLifecycleResultEnvelope(fact)) {
            return null;
        }

        const sdkUuid = readNonBlankOpaqueIdentifier((sdkMessage as any)?.uuid);
        const uuid = sdkUuid ?? randomUUID()
        const timestamp = new Date().toISOString()
        let parentUuid = this.lastMainUuid;
        let isSidechain = false;
        let sidechainId: string | undefined;
        if (sdkMessage.parent_tool_use_id) {
            isSidechain = true;
            sidechainId = (sdkMessage as any).parent_tool_use_id;
            parentUuid = this.sidechainLastUUID.get((sdkMessage as any).parent_tool_use_id) ?? null;
            this.sidechainLastUUID.set((sdkMessage as any).parent_tool_use_id!, uuid);
        }
        const baseFields = {
            parentUuid: parentUuid,
            isSidechain: isSidechain,
            ...(sidechainId ? { sidechainId } : {}),
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp
        }

        const peerMessage = projectClaudePeerMessage({ ...sdkMessage, ...baseFields });
        if (peerMessage) {
            if (!isSidechain) this.lastMainUuid = uuid;
            // A linked subagent hand-back becomes its launching tool's result.
            const projection = this.taskNotificationProjector.project(peerMessage, sidechainId ? { sidechainId } : undefined);
            return projection ? projection.message : peerMessage;
        }
        const taskResult = this.taskNotificationProjector.project({ ...sdkMessage, ...baseFields }, sidechainId ? { sidechainId } : undefined);
        if (taskResult) return taskResult.message;
        if (providers.claude.isClaudeInternalEventType(rawType)) return null;

        let logMessage: RawJSONLines | null = null
        let shouldUpdateLastMainUuid = true

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                const toolUseResult = (sdkMessage as any)?.tool_use_result as unknown;
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message,
                    ...(userMsg.origin ? { origin: userMsg.origin } : {}),
                }

                if (toolUseResult !== undefined && Array.isArray(userMsg.message.content)) {
                    const nextContent = embedClaudeToolResultMetadata(userMsg.message.content, toolUseResult);
                    (logMessage as any).message = { ...userMsg.message, content: nextContent };
                }

                // Check if this is a tool result and add mode if available
                if (Array.isArray(userMsg.message.content)) {
                    for (const content of userMsg.message.content) {
                        if (content.type === 'tool_result' && content.tool_use_id && this.responses?.has(content.tool_use_id)) {
                            const response = this.responses.get(content.tool_use_id)
                            if (response?.mode) {
                                (logMessage as any).mode = response.mode
                            }
                        }
                    }
                } else if (typeof userMsg.message.content === 'string') {
                    // Simple string content, no tool result
                }
                break
            }

            case 'assistant': {
                const assistantMsg = normalizeClaudeToolUseNamesInSdkMessage(sdkMessage) as SDKAssistantMessage
                const contextUsedTokens = !isSidechain ? readAssistantContextUsedTokens(assistantMsg.message) : null
                if (contextUsedTokens !== null) {
                    this.latestMainAssistantContextUsedTokens = contextUsedTokens
                }
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: assistantMsg.message,
                    // Assistant messages often have additional fields
                    requestId: (assistantMsg as any).requestId
                }
                // if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                //     for (const content of assistantMsg.message.content) {
                //         if (content.type === 'tool_use' && content.id) {
                //             this.sidechainLastUUID.set(content.id, uuid);
                //         }
                //     }
                // }
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage

                // System messages with subtype 'init' might update session ID
                if (systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                }

                // System messages are typically not sent to logs
                // but we can convert them if needed
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    subtype: systemMsg.subtype,
                    model: systemMsg.model,
                    tools: systemMsg.tools,
                    // Include all other fields
                    ...(systemMsg as any)
                }
                break
            }

            case 'result': {
                const resultUsageTelemetry = buildClaudeSdkResultUsageTelemetry(sdkMessage as SDKResultMessage, {
                    contextUsedTokens: this.latestMainAssistantContextUsedTokens ?? 0,
                })
                if (resultUsageTelemetry) {
                    logMessage = {
                        ...baseFields,
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: resultUsageTelemetry.modelId,
                            content: [],
                            usage: resultUsageTelemetry.usage,
                        },
                    }
                    shouldUpdateLastMainUuid = false
                }
                break
            }

            // Handle tool use results (often comes as user messages)
            case 'tool_result': {
                const toolMsg = sdkMessage as any
                const baseLogMessage: any = {
                    ...baseFields,
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolMsg.tool_use_id,
                            content: toolMsg.content
                        }]
                    },
                    toolUseResult: toolMsg.content
                }

                // Add mode if available from responses
                if (toolMsg.tool_use_id && this.responses?.has(toolMsg.tool_use_id)) {
                    const response = this.responses.get(toolMsg.tool_use_id)
                    if (response?.mode) {
                        baseLogMessage.mode = response.mode
                    }
                }

                logMessage = baseLogMessage
                break
            }

            default:
                // Unknown message type - pass through with all fields
                logMessage = {
                    ...baseFields,
                    ...sdkMessage,
                    type: (sdkMessage as any).type // Override type last to ensure it's set
                } as any
        }

        // Update last UUID for parent tracking
        if (logMessage && shouldUpdateLastMainUuid && logMessage.type !== 'summary' && !isSidechain) {
            this.lastMainUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }

    /**
     * Convert a simple string content to a sidechain user message
     * Used for Task tool sub-agent prompts
     */
    convertSidechainUserMessage(toolUseId: string, content: string): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.sidechainLastUUID.set(toolUseId, uuid);
        return {
            parentUuid: null,
            isSidechain: true,
            sidechainId: toolUseId,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            type: 'user',
            message: {
                role: 'user',
                content: content
            },
            uuid,
            timestamp
        }
    }

    /**
     * Generate an interrupted tool result message
     * Used when a tool call is interrupted by the user
     * @param toolUseId - The ID of the tool that was interrupted
     * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
     */
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"
        
        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastMainUuid
        
        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }
        
        const logMessage: RawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        } as any
        
        // Update last UUID for tracking
        if (!isSidechain) {
            this.lastMainUuid = uuid
        }
        
        return logMessage
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage,
    context: Omit<ConversionContext, 'parentUuid'>,
    responses?: Map<string, { approved: boolean, mode?: PermissionMode, reason?: string }>
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context, responses)
    return converter.convert(sdkMessage)
}
