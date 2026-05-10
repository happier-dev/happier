import type {
    RuntimeFacetCtx,
    SessionStateApplyReason,
    SessionStateFacet,
    SessionStateProviderFieldHandler,
} from '@happier-dev/agents';
import type {
    SessionStateCapabilitiesV1,
    SessionStateFieldId,
    SessionStateFieldValue,
} from '@happier-dev/protocol';

import { createCodexRolloutDisplayTitleHandler } from './rollout/displayTitle';

export const CODEX_SESSION_STATE_CAPABILITIES = {
    display: {
        title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
            providerToHappier: { supported: true, source: 'snapshot' },
        },
    },
} as const satisfies SessionStateCapabilitiesV1;

const displayTitleHandlersBySessionId = new Map<
    string,
    SessionStateProviderFieldHandler<'display.title'>
>();

function createUnsupportedFieldError(field: SessionStateFieldId): Error & { code: 'unsupported' } {
    return Object.assign(new Error(`Codex session-state field is unsupported: ${field}`), {
        code: 'unsupported' as const,
    });
}

function readDisplayTitleHandler(
    ctx: RuntimeFacetCtx,
): SessionStateProviderFieldHandler<'display.title'> | null {
    return displayTitleHandlersBySessionId.get(ctx.sessionId) ?? null;
}

function readRolloutFilePath(ctx: RuntimeFacetCtx): string | null {
    const value = ctx.rolloutFilePath;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || null;
}

export function registerCodexDisplayTitleSessionStateHandler(params: Readonly<{
    sessionId: string;
    handler: SessionStateProviderFieldHandler<'display.title'>;
}>): () => void {
    const previous = displayTitleHandlersBySessionId.get(params.sessionId);
    displayTitleHandlersBySessionId.set(params.sessionId, params.handler);
    return () => {
        if (displayTitleHandlersBySessionId.get(params.sessionId) !== params.handler) return;
        if (previous) {
            displayTitleHandlersBySessionId.set(params.sessionId, previous);
            return;
        }
        displayTitleHandlersBySessionId.delete(params.sessionId);
    };
}

export const codexSessionStateFacet: SessionStateFacet = {
    capabilities: CODEX_SESSION_STATE_CAPABILITIES,
    applyHappierField: async <F extends SessionStateFieldId>(
        ctx: RuntimeFacetCtx,
        field: F,
        value: SessionStateFieldValue<F>,
        opts: Readonly<{ reason: SessionStateApplyReason }>,
    ) => {
        if (field !== 'display.title') {
            throw createUnsupportedFieldError(field);
        }
        const handler = readDisplayTitleHandler(ctx);
        if (!handler?.applyHappierField) {
            throw createUnsupportedFieldError(field);
        }
        await handler.applyHappierField(
            ctx,
            value as SessionStateFieldValue<'display.title'>,
            opts,
        );
    },
    readField: async <F extends SessionStateFieldId>(
        ctx: RuntimeFacetCtx,
        field: F,
    ): Promise<SessionStateFieldValue<F> | null> => {
        if (field !== 'display.title') {
            throw createUnsupportedFieldError(field);
        }
        const handler = readDisplayTitleHandler(ctx);
        if (handler?.readField) {
            return await handler.readField(ctx) as SessionStateFieldValue<F> | null;
        }
        const rolloutFilePath = readRolloutFilePath(ctx);
        if (!rolloutFilePath) return null;
        const rolloutHandler = createCodexRolloutDisplayTitleHandler({ rolloutFilePath });
        return await rolloutHandler.readField?.(ctx) as SessionStateFieldValue<F> | null;
    },
};
