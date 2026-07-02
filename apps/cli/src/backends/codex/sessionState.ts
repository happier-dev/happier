import type {
    RuntimeFacetCtx,
    SessionStateApplyReason,
    SessionStateFacet,
} from '@happier-dev/agents';
import type {
    SessionStateCapabilitiesV1,
    SessionStateFieldId,
    SessionStateFieldValue,
} from '@happier-dev/protocol';

import { createCodexRolloutDisplayTitleHandler } from '@happier-dev/plugins-codex/agent/state/displayTitle';
import { readCodexSessionTitleFromRollout } from './rollout/readCodexSessionTitleFromRollout';

export const CODEX_SESSION_STATE_CAPABILITIES = {
    display: {
        title: {
            supported: true,
            happierToProvider: { supported: false },
            providerToHappier: { supported: true, source: 'snapshot' },
        },
    },
} as const satisfies SessionStateCapabilitiesV1;

function createUnsupportedFieldError(field: SessionStateFieldId): Error & { code: 'unsupported' } {
    return Object.assign(new Error(`Codex session-state field is unsupported: ${field}`), {
        code: 'unsupported' as const,
    });
}

function readRolloutFilePath(ctx: RuntimeFacetCtx): string | null {
    const value = ctx.rolloutFilePath;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || null;
}

export const codexSessionStateFacet: SessionStateFacet = {
    capabilities: CODEX_SESSION_STATE_CAPABILITIES,
    applyHappierField: async <F extends SessionStateFieldId>(
        _ctx: RuntimeFacetCtx,
        field: F,
        _value: SessionStateFieldValue<F>,
        _opts: Readonly<{ reason: SessionStateApplyReason }>,
    ) => {
        if (field !== 'display.title') {
            throw createUnsupportedFieldError(field);
        }
        throw createUnsupportedFieldError(field);
    },
    readField: async <F extends SessionStateFieldId>(
        ctx: RuntimeFacetCtx,
        field: F,
    ): Promise<SessionStateFieldValue<F> | null> => {
        if (field !== 'display.title') {
            throw createUnsupportedFieldError(field);
        }
        const rolloutFilePath = readRolloutFilePath(ctx);
        if (!rolloutFilePath) return null;
        const rolloutHandler = createCodexRolloutDisplayTitleHandler({
            readTitle: () => readCodexSessionTitleFromRollout(rolloutFilePath),
        });
        return await rolloutHandler.readField?.(ctx) as SessionStateFieldValue<F> | null;
    },
};
