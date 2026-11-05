import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type ScmReviewUnifiedDiffFetchResult =
    | Readonly<{ success: true; diff: string }>
    | Readonly<{ success: false; error: string; errorCode?: string }>;

export type ScmReviewUnifiedDiffFetcher = (input: Readonly<{
    snapshotSignature?: string | null;
    diffCache?: ScmDiffCache | null;
    path: string;
    diffArea: ScmDiffArea;
    file: ScmFileStatus | null;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
    signal?: AbortSignal;
}>) => Promise<ScmReviewUnifiedDiffFetchResult>;
