import type { SDKMessage } from '@/backends/claude/sdk';
import { normalizeClaudeToolUseNamesInSdkMessage } from '@happier-dev/plugins-claude/agent/transcripts';

export function createClaudeAgentSdkMessageEmitter(params: {
    onMessage: (message: SDKMessage) => void;
    resolvePreferredModelId: () => string | null;
}) {
    let syntheticUuidCounter = 0;
    const createSyntheticUuid = () => `happier_synth_${process.pid}_${++syntheticUuidCounter}`;

    const normalizeSdkMessageForUiCompatibility = (message: SDKMessage, hints?: { defaultUuid?: string | null }) => {
        const preferredModelId = params.resolvePreferredModelId();

        const existingUuid = (message as any)?.uuid;
        const nextUuid =
            typeof existingUuid === 'string' && existingUuid.trim().length > 0
                ? existingUuid
                : typeof hints?.defaultUuid === 'string' && hints.defaultUuid.trim().length > 0
                  ? hints.defaultUuid
                  : createSyntheticUuid();

        const needsUuidPatch = nextUuid !== existingUuid;
        const needsModelPatch =
            message?.type === 'assistant' &&
            preferredModelId &&
            message &&
            typeof message === 'object' &&
            (message as any).message &&
            typeof (message as any).message === 'object' &&
            typeof (message as any).message.model !== 'string';

        if (!needsUuidPatch && !needsModelPatch) return message;

        return {
            ...(message as any),
            ...(needsUuidPatch ? { uuid: nextUuid } : null),
            ...(needsModelPatch
                ? {
                      message: {
                          ...(message as any).message,
                          model: preferredModelId,
                      },
                  }
                : null),
        } as SDKMessage;
    };

    const emitMessage = (message: SDKMessage, hints?: { defaultUuid?: string | null }) => {
        const normalized = normalizeClaudeToolUseNamesInSdkMessage(message);
        params.onMessage(normalizeSdkMessageForUiCompatibility(normalized, hints));
    };

    const emitAssistantTextMessage = (message: {
        sessionId: string;
        parentToolUseId: string | null;
        assistantText: string;
        thinkingText?: string;
        defaultUuid?: string | null;
    }) => {
        const assistantText = message.assistantText.trim();
        const thinkingText = (message.thinkingText ?? '').trim();
        if (assistantText.length === 0 && thinkingText.length === 0) return;

        emitMessage(
            {
                type: 'assistant',
                session_id: message.sessionId,
                parent_tool_use_id: message.parentToolUseId,
                ...(message.defaultUuid ? { uuid: message.defaultUuid } : null),
                message: {
                    role: 'assistant',
                    content: [
                        ...(thinkingText.length > 0
                            ? [{ type: 'thinking' as const, thinking: message.thinkingText ?? '' }]
                            : []),
                        ...(assistantText.length > 0 ? [{ type: 'text' as const, text: message.assistantText }] : []),
                    ],
                },
            } as any,
            message.defaultUuid ? { defaultUuid: message.defaultUuid } : undefined,
        );
    };

    return {
        emitMessage,
        emitAssistantTextMessage,
    };
}
