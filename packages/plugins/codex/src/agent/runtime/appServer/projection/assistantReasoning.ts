export type CodexAppServerAssistantReasoningStreamUpdate =
    Readonly<{ type: string; itemId?: unknown; text?: unknown }>;

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
    streamScopeId: string;
    itemId: string | null;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function createCodexAppServerAssistantReasoningProjector(params: Readonly<{
    bridge: AssistantReasoningBridge;
}>) {
    const assistantTextByItemId = new Map<string, string>();
    const reasoningTextByItemId = new Map<string, string>();
    const latestAssistantItemIdByStreamScope = new Map<string, string>();
    const normalizedAssistantFinalItemKeys = new Set<string>();
    const rawAssistantFinalByItemKey = new Map<string, PendingRawAssistantFinal>();

    const buildItemStateKey = (scopeId: string, itemId: string): string => `${scopeId}:${itemId}`;
    const buildRawFallbackStateKey = (scopeId: string): string => `${scopeId}:raw-response-item`;
    const buildItemStreamKey = (scopeId: string, kind: 'assistant' | 'reasoning', itemId: string): string =>
        `${scopeId}:${kind}:${itemId}`;
    const buildAssistantItemStreamKey = (scopeId: string, itemId: string): string =>
        buildItemStreamKey(scopeId, 'assistant', itemId);

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

    const hasNormalizedAssistantFinalInScope = (streamScopeId: string): boolean => {
        const keyPrefix = `${streamScopeId}:`;
        for (const itemKey of normalizedAssistantFinalItemKeys) {
            if (itemKey.startsWith(keyPrefix)) return true;
        }
        return false;
    };

    const deletePendingRawAssistantFinalForNormalizedItem = (streamScopeId: string, itemId: string): void => {
        rawAssistantFinalByItemKey.delete(buildItemStateKey(streamScopeId, itemId));
        rawAssistantFinalByItemKey.delete(buildRawFallbackStateKey(streamScopeId));
    };

    const commitRawAssistantFinal = (pending: PendingRawAssistantFinal): void => {
        const itemId = pending.itemId
            ?? latestAssistantItemIdByStreamScope.get(pending.streamScopeId)
            ?? 'raw-response-item';
        appendStreamFinal(
            buildItemStateKey(pending.streamScopeId, itemId),
            pending.text,
            assistantTextByItemId,
            (deltaText) => {
                params.bridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildAssistantItemStreamKey(pending.streamScopeId, itemId),
                    sidechainId: pending.sidechainId,
                });
            },
            (finalText) => {
                params.bridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildAssistantItemStreamKey(pending.streamScopeId, itemId),
                    sidechainId: pending.sidechainId,
                });
            },
        );
    };

    const commitPendingRawAssistantFinals = (options?: Readonly<{ includeFallbackRawFinals?: boolean }>): void => {
        const includeFallbackRawFinals = options?.includeFallbackRawFinals !== false;
        for (const [itemKey, pendingRaw] of rawAssistantFinalByItemKey.entries()) {
            if (pendingRaw.itemId) {
                if (!normalizedAssistantFinalItemKeys.has(itemKey)) {
                    commitRawAssistantFinal(pendingRaw);
                }
                rawAssistantFinalByItemKey.delete(itemKey);
            } else if (includeFallbackRawFinals && !hasNormalizedAssistantFinalInScope(pendingRaw.streamScopeId)) {
                commitRawAssistantFinal(pendingRaw);
                rawAssistantFinalByItemKey.delete(itemKey);
            }
        }
    };

    const clearState = (): void => {
        assistantTextByItemId.clear();
        reasoningTextByItemId.clear();
        latestAssistantItemIdByStreamScope.clear();
        normalizedAssistantFinalItemKeys.clear();
        rawAssistantFinalByItemKey.clear();
    };

    return {
        observeStreamUpdate(
            update: CodexAppServerAssistantReasoningStreamUpdate,
            context: CodexAppServerAssistantReasoningProjectionContext,
        ): boolean {
            if (update.type === 'assistant-text-delta') {
                const itemId = readString(update.itemId);
                const text = readString(update.text);
                if (itemId === null || text === null) return false;
                latestAssistantItemIdByStreamScope.set(context.streamScopeId, itemId);
                appendStreamDelta(buildItemStateKey(context.streamScopeId, itemId), text, assistantTextByItemId, (deltaText) => {
                    params.bridge.appendAssistantDelta({
                        deltaText,
                        streamKey: buildAssistantItemStreamKey(context.streamScopeId, itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            if (update.type === 'assistant-text-final') {
                const itemId = readString(update.itemId);
                const text = readString(update.text);
                if (itemId === null || text === null) return false;
                latestAssistantItemIdByStreamScope.set(context.streamScopeId, itemId);
                const itemKey = buildItemStateKey(context.streamScopeId, itemId);
                normalizedAssistantFinalItemKeys.add(itemKey);
                deletePendingRawAssistantFinalForNormalizedItem(context.streamScopeId, itemId);
                appendStreamFinal(itemKey, text, assistantTextByItemId, (deltaText) => {
                    params.bridge.appendAssistantDelta({
                        deltaText,
                        streamKey: buildAssistantItemStreamKey(context.streamScopeId, itemId),
                        sidechainId: context.sidechainId,
                    });
                }, (finalText) => {
                    params.bridge.overrideAssistantText({
                        text: finalText,
                        streamKey: buildAssistantItemStreamKey(context.streamScopeId, itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            if (update.type === 'assistant-raw-final') {
                const itemId = update.itemId === null ? null : readString(update.itemId);
                const text = readString(update.text);
                if (itemId === null && update.itemId !== null && update.itemId !== undefined) return false;
                if (text === null) return false;
                const itemKey = itemId
                    ? buildItemStateKey(context.streamScopeId, itemId)
                    : buildRawFallbackStateKey(context.streamScopeId);
                if (itemId) {
                    if (normalizedAssistantFinalItemKeys.has(itemKey)) return true;
                } else if (hasNormalizedAssistantFinalInScope(context.streamScopeId)) {
                    return true;
                }
                rawAssistantFinalByItemKey.set(itemKey, {
                    text,
                    sidechainId: context.sidechainId,
                    streamScopeId: context.streamScopeId,
                    itemId,
                });
                return true;
            }

            if (update.type === 'reasoning-delta') {
                const itemId = readString(update.itemId);
                const text = readString(update.text);
                if (itemId === null || text === null) return false;
                appendStreamDelta(buildItemStateKey(context.streamScopeId, itemId), text, reasoningTextByItemId, (deltaText) => {
                    params.bridge.appendThinkingDelta({
                        deltaText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            if (update.type === 'reasoning-final') {
                const itemId = readString(update.itemId);
                const text = readString(update.text);
                if (itemId === null || text === null) return false;
                appendStreamFinal(buildItemStateKey(context.streamScopeId, itemId), text, reasoningTextByItemId, (deltaText) => {
                    params.bridge.appendThinkingDelta({
                        deltaText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', itemId),
                        sidechainId: context.sidechainId,
                    });
                }, (finalText) => {
                    params.bridge.overrideThinkingText({
                        text: finalText,
                        streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', itemId),
                        sidechainId: context.sidechainId,
                    });
                });
                return true;
            }

            return false;
        },

        flushItemScopedRawAssistantFinals(): void {
            commitPendingRawAssistantFinals({ includeFallbackRawFinals: false });
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
