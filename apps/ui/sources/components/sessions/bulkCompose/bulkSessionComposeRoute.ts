import type { BulkSessionComposerSeed } from '@/components/sessions/authoring/bulk/bulkSessionComposerHandoff';
import { storeBulkSessionComposerSeed } from '@/components/sessions/authoring/bulk/bulkSessionComposerHandoff';

/** The bulk composer's route. Its seed (targets, prefill) travels through the temp handoff, never the URL. */
export const BULK_SESSION_COMPOSE_PATHNAME = '/session/compose';

export function buildBulkSessionComposeHref(dataId: string) {
    return { pathname: BULK_SESSION_COMPOSE_PATHNAME, params: { dataId } } as const;
}

export function openBulkSessionComposer(router: Readonly<{ push: (href: never) => void }>, seed: BulkSessionComposerSeed): void {
    if (seed.targets.length === 0) return;
    router.push(buildBulkSessionComposeHref(storeBulkSessionComposerSeed(seed)) as never);
}
