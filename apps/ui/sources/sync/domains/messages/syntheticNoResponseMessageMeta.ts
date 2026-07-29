import type { MessageMeta } from './messageMetaTypes';

export const SYNTHETIC_NO_RESPONSE_TEXT = 'No response requested.';

const SYNTHETIC_NO_RESPONSE_META_KEY = 'happierSyntheticNoResponseV1';

export function markSyntheticNoResponseMeta(meta?: MessageMeta): MessageMeta {
    return {
        ...(meta ?? {}),
        [SYNTHETIC_NO_RESPONSE_META_KEY]: true,
    } as MessageMeta;
}

export function hasSyntheticNoResponseMeta(meta: unknown): boolean {
    return Boolean(
        meta
        && typeof meta === 'object'
        && !Array.isArray(meta)
        && (meta as Record<string, unknown>)[SYNTHETIC_NO_RESPONSE_META_KEY] === true,
    );
}
