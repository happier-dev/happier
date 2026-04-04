import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type ScmReviewUnifiedDiffFetchResult =
    | Readonly<{ success: true; diff: string }>
    | Readonly<{ success: false; error: string }>;

export type ScmReviewUnifiedDiffFetcher = (input: Readonly<{
    path: string;
    diffArea: ScmDiffArea;
    file: ScmFileStatus | null;
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}>) => Promise<ScmReviewUnifiedDiffFetchResult>;
