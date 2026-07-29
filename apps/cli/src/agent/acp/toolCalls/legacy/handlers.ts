import type { HandlerContext, HandlerResult, SessionUpdate } from '../../updates/types';

export function markToolCallWaitingForPermission(toolCallId: string, ctx: HandlerContext): void {
    ctx.toolCalls.markWaitingForPermission(toolCallId);
}

export function markToolCallRunningAfterPermission(toolCallId: string, ctx: HandlerContext): void {
    ctx.toolCalls.markRunningAfterPermission(toolCallId);
}

export function handleToolCallUpdate(update: SessionUpdate, ctx: HandlerContext): HandlerResult {
    const known = typeof update.toolCallId === 'string' ? ctx.toolCalls.readCall(update.toolCallId) : null;
    ctx.toolCalls.handleRawUpdate(update);
    return {
        handled: true,
        toolCallCountSincePrompt: ctx.toolCallCountSincePrompt + (known ? 0 : 1),
    };
}

export function handleToolCall(update: SessionUpdate, ctx: HandlerContext): HandlerResult {
    const known = typeof update.toolCallId === 'string' ? ctx.toolCalls.readCall(update.toolCallId) : null;
    ctx.toolCalls.handleRawUpdate(update);
    return {
        handled: true,
        toolCallCountSincePrompt: ctx.toolCallCountSincePrompt + (known ? 0 : 1),
    };
}
