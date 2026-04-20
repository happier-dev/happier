import type { CodexAppServerStreamUpdate } from '@/backends/codex/appServer/streamEventBridge';

type AssistantReasoningBridge = Readonly<{
    appendAssistantDelta: (args: Readonly<{
        deltaText: string;
        streamKey: string;
        sidechainId: string | null;
    }>) => void;
    appendThinkingDelta: (args: Readonly<{
        deltaText: string;
        streamKey: string;
        sidechainId: string | null;
    }>) => void;
    overrideAssistantText: (args: Readonly<{
        text: string;
        streamKey: string;
        sidechainId: string | null;
    }>) => void;
    overrideThinkingText: (args: Readonly<{
        text: string;
        streamKey: string;
        sidechainId: string | null;
    }>) => void;
    flushAll: (args: Readonly<{
        reason: 'turn-end' | 'abort';
        interruptedReason?: string;
    }>) => Promise<void>;
}>;

export type CodexAppServerAssistantReasoningProjectionContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

type PendingRawAssistantFinal = Readonly<{
    text: string;
    sidechainId: string | null;
}>;

export function createCodexAppServerAssistantReasoningProjector(params: Readonly<{
    bridge: AssistantReasoningBridge;
}>) {
    const assistantTextByItemId = new Map<string, string>();
    const reasoningTextByItemId = new Map<string, string>();
    const latestAssistantItemIdByStreamScope = new Map<string, string>();
    const normalizedAssistantFinalSeenByStreamScope = new Set<string>();
    const rawAssistantFinalByStreamScope = new Map<string, PendingRawAssistantFinal>();

    const buildItemStateKey = (scopeId: string, itemId: string): string => `${scopeId}:${itemId}`;
    const buildItemStreamKey = (scopeId: string, kind: 'assistant' | 'reasoning', itemId: string): string =>
        `${scopeId}:${kind}:${itemId}`;

    const appendStreamDelta = (
        itemKey: string,
        text: string,
        values: Map<string, string>,
        append: (deltaText: string) => void,
    ): void => {
        if (!text) return;
        append(text);
        values.set(itemKey, `${values.get(itemKey) ?? ''}${text}`);
    };

    const appendStreamFinal = (
        itemKey: string,
        text: string,
        values: Map<string, string>,
        append: (deltaText: string) => void,
        override: (finalText: string) => void,
    ): void => {
        const accumulated = values.get(itemKey) ?? '';
        values.delete(itemKey);
        if (!text) return;
        if (!accumulated) {
            append(text);
            return;
        }
        if (text.startsWith(accumulated)) {
            const suffix = text.slice(accumulated.length);
            if (suffix) append(suffix);
            return;
        }
        override(text);
    };

    const commitRawAssistantFinal = (streamScopeId: string, pending: PendingRawAssistantFinal): void => {
        const itemId = latestAssistantItemIdByStreamScope.get(streamScopeId) ?? 'raw-response-item';
        appendStreamFinal(
            buildItemStateKey(streamScopeId, itemId),
            pending.text,
            assistantTextByItemId,
            (deltaText) => {
                params.bridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(streamScopeId, 'assistant', itemId),
                    sidechainId: pending.sidechainId,
                });
            },
            (finalText) => {
                params.bridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildItemStreamKey(streamScopeId, 'assistant', itemId),
                    sidechainId: pending.sidechainId,
                });
            },
        );
    };

    const commitPendingRawAssistantFinals = (): void => {
        for (const [streamScopeId, pendingRaw] of rawAssistantFinalByStreamScope.entries()) {
            if (!normalizedAssistantFinalSeenByStreamScope.has(streamScopeId)) {
                commitRawAssistantFinal(streamScopeId, pendingRaw);
            }
            rawAssistantFinalByStreamScope.delete(streamScopeId);
        }
    };

    const clearState = (): void => {
        assistantTextByItemId.clear();
        reasoningTextByItemId.clear();
        latestAssistantItemIdByStreamScope.clear();
        normalizedAssistantFinalSeenByStreamScope.clear();
        rawAssistantFinalByStreamScope.clear();
    };

    return {
        observeStreamUpdate(update: CodexAppServerStreamUpdate, context: CodexAppServerAssistantReasoningProjectionContext): boolean {
            if (update.type === 'assistant-text-delta') {
                latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
                appendStreamDelta(buildItemStateKey(context.streamScopeId, update.itemId), update.text, assistantTextByItemId, (deltaText) => {
                    params.bridge.appendAssistantDelta({
                        deltaText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'assistant', update.itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            if (update.type === 'assistant-text-final') {
                latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
                normalizedAssistantFinalSeenByStreamScope.add(context.streamScopeId);
                rawAssistantFinalByStreamScope.delete(context.streamScopeId);
                appendStreamFinal(buildItemStateKey(context.streamScopeId, update.itemId), update.text, assistantTextByItemId, (deltaText) => {
                    params.bridge.appendAssistantDelta({
                        deltaText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'assistant', update.itemId),
                        sidechainId: context.sidechainId,
                    });
                }, (finalText) => {
                    params.bridge.overrideAssistantText({
                        text: finalText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'assistant', update.itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            if (update.type === 'assistant-raw-final') {
                if (normalizedAssistantFinalSeenByStreamScope.has(context.streamScopeId)) {
                    return true;
                }
                rawAssistantFinalByStreamScope.set(context.streamScopeId, {
                    text: update.text,
                    sidechainId: context.sidechainId,
                });
                return true;
            }

            if (update.type === 'reasoning-delta') {
                appendStreamDelta(buildItemStateKey(context.streamScopeId, update.itemId), update.text, reasoningTextByItemId, (deltaText) => {
                    params.bridge.appendThinkingDelta({
                        deltaText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            if (update.type === 'reasoning-final') {
                appendStreamFinal(buildItemStateKey(context.streamScopeId, update.itemId), update.text, reasoningTextByItemId, (deltaText) => {
                    params.bridge.appendThinkingDelta({
                        deltaText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                        sidechainId: context.sidechainId,
                    });
                }, (finalText) => {
                    params.bridge.overrideThinkingText({
                        text: finalText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            return false;
        },

        async flush(reason: 'turn-end' | 'abort'): Promise<void> {
            if (reason === 'turn-end') {
                commitPendingRawAssistantFinals();
            }
            clearState();
            await params.bridge.flushAll({
                reason,
                ...(reason === 'abort' ? { interruptedReason: 'app-server-turn-interrupted' } : {}),
            });
        },
    };
}
