import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { createHappierCollectionVisitMemory, resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { embedDetailPath } from '@/components/settings/embeds/embedsCollection';

export const API_TOKENS_COLLECTION_ROOT = SETTINGS_ROUTES.apiTokens;

/** Settings → Embeds' detail for an embed-backed token (plan 04 §4.10): the one place it is managed. */
export const apiTokenEmbedDetailPath = embedDetailPath;

export function apiTokenDetailPath(tokenId: string): `${typeof API_TOKENS_COLLECTION_ROOT}/${string}` {
    return `${API_TOKENS_COLLECTION_ROOT}/${encodeURIComponent(tokenId)}`;
}

/** Where a token's row leads: its detail here, or its embed when an embed owns it. */
export function apiTokenRowHref(token: Pick<AccountApiTokenSummaryV1, 'tokenId' | 'embedConfig'>): ReturnType<typeof apiTokenDetailPath> | ReturnType<typeof apiTokenEmbedDetailPath> {
    return token.embedConfig !== null ? apiTokenEmbedDetailPath(token.tokenId) : apiTokenDetailPath(token.tokenId);
}

/** The token a collection pathname is about (`/settings/account/api-tokens/<tokenId>`), else null. */
export function resolveSelectedApiTokenId(pathname: string): string | null {
    const prefix = `${API_TOKENS_COLLECTION_ROOT}/`;
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    if (!rest || rest.includes('/')) return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return null;
    }
}

/** The token last opened during this app session; a wide collection lands on it. Session memory only. */
const tokenVisits = createHappierCollectionVisitMemory<string>();
export const recordApiTokenCollectionVisit = tokenVisits.record;
export const readLastVisitedApiToken = tokenVisits.read;

/**
 * Where a wide collection lands when its route names no token: the one opened last while it is still
 * listed, else the first. Embed-backed tokens are managed in Embeds, so the collection never lands on
 * one.
 */
export function resolveApiTokenCollectionLanding(
    tokens: readonly Pick<AccountApiTokenSummaryV1, 'tokenId' | 'embedConfig'>[],
    lastVisited: string | null,
): string | null {
    return resolveHappierCollectionInitialKey({
        keys: tokens.filter((token) => token.embedConfig === null).map((token) => token.tokenId),
        lastVisited,
    }) as string | null;
}
