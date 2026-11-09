import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { createHappierCollectionVisitMemory, resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

export const EMBEDS_COLLECTION_ROOT = SETTINGS_ROUTES.embeds;
export const EMBEDS_NEW_PATH = `${EMBEDS_COLLECTION_ROOT}/new`;

/**
 * The narrowest embed detail that fits its two columns, the settings sheet and the sticky live
 * preview (plan 04 §6.2). Narrower, the collection pushes the detail and the preview is a pushed page.
 */
export const EMBED_DETAIL_TWO_COLUMN_MIN_WIDTH_PX = 880;

/** An embed is an API token with an embed configuration (plan 04 §4.2); only those are listed here. */
export function isEmbedToken(token: Pick<AccountApiTokenSummaryV1, 'embedConfig' | 'parentTokenId'>): boolean {
    return token.embedConfig !== null && token.parentTokenId === null;
}

export function embedDetailPath(tokenId: string): string {
    return `${EMBEDS_COLLECTION_ROOT}/${encodeURIComponent(tokenId)}`;
}

/** The embed a collection pathname is about (`/settings/embeds/<tokenId>`), else null. */
export function resolveSelectedEmbedTokenId(pathname: string): string | null {
    const prefix = `${EMBEDS_COLLECTION_ROOT}/`;
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    if (!rest || rest === 'new' || rest.includes('/')) return null;
    try {
        return decodeURIComponent(rest);
    } catch {
        return null;
    }
}

const embedVisits = createHappierCollectionVisitMemory<string>();
export const recordEmbedCollectionVisit = embedVisits.record;
export const readLastVisitedEmbed = embedVisits.read;

/** Where a wide collection lands when its route names no embed: the last opened one still listed, else the first. */
export function resolveEmbedCollectionLanding(
    tokens: readonly Pick<AccountApiTokenSummaryV1, 'tokenId' | 'embedConfig' | 'parentTokenId'>[],
    lastVisited: string | null,
): string | null {
    return resolveHappierCollectionInitialKey({
        keys: tokens.filter(isEmbedToken).map((token) => token.tokenId),
        lastVisited,
    }) as string | null;
}
