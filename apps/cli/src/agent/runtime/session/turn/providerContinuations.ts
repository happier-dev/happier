/** Retains only contexts captured by the host from admitted tool calls. */
export function createProviderContinuationContexts<TContext extends object>(
    captureContext: (turnId: string) => TContext | null,
) {
    const tools = new Map<string, Map<string, TContext>>();
    const continuations = new Map<string, {
        parentTurnId: string;
        context: TContext | null;
    }>();
    return {
        captureTool(turnId: string, toolCallId: string): void {
            if (tools.get(turnId)?.has(toolCallId)) return;
            const context = captureContext(turnId);
            if (!context) return;
            let turn = tools.get(turnId);
            if (!turn) { turn = new Map(); tools.set(turnId, turn); }
            turn.set(toolCallId, context);
        },
        register(continuationId: string, parentTurnId: string, parentToolCallId: string): boolean {
            const context = tools.get(parentTurnId)?.get(parentToolCallId);
            if (!context || continuations.has(continuationId)) return false;
            continuations.set(continuationId, { parentTurnId, context });
            return true;
        },
        consume(continuationId: string, parentTurnId: string | undefined): TContext | null {
            const continuation = continuations.get(continuationId);
            if (!continuation || continuation.parentTurnId !== parentTurnId || !continuation.context) return null;
            const context = continuation.context;
            continuation.context = null;
            return context;
        },
        release(continuationId: string): void {
            continuations.delete(continuationId);
        },
        releaseTools(parentTurnId: string, toolCallIds: readonly string[]): void {
            const turn = tools.get(parentTurnId);
            if (!turn) return;
            for (const id of toolCallIds) turn.delete(id);
            if (turn.size === 0) tools.delete(parentTurnId);
        },
        clear(): void {
            tools.clear();
            continuations.clear();
        },
    };
}
