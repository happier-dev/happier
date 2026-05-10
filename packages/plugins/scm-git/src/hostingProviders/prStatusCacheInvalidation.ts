import type { ScmBackendContext } from '../types.js';

import { defaultPrStatusCache, type PrStatusCache } from './prStatusCache.js';

export function invalidatePrStatusCacheAfterSuccessfulScmMutation(input: Readonly<{
    cache?: Pick<PrStatusCache, 'invalidate'>;
    response: Readonly<{ success: boolean }>;
    context: ScmBackendContext;
    headBranch?: string | null;
}>): void {
    if (!input.response.success) return;
    const repoRootPath = input.context.detection.rootPath;
    if (!repoRootPath) return;
    (input.cache ?? defaultPrStatusCache).invalidate({
        repoRootPath,
        ...(input.headBranch ? { headBranch: input.headBranch } : {}),
    });
}
