import { ScmPullRequestSummaryProtocolSchema as canonicalSummary } from '@happier-dev/protocol/scm/pullRequests';

import type { ScmHostingProviderRef } from './hostingRepositoryIdentity.js';

export type ScmPullRequestState = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';
export type ScmPullRequestChecksState = 'pending' | 'success' | 'failure' | 'unknown';

export type ScmPullRequestSummary = {
    [key: string]: unknown;
    provider: ScmHostingProviderRef;
    number?: number | null;
    providerNativeId?: string;
    title: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    headRepositoryNameWithOwner?: string;
    isCrossRepository?: boolean;
    headSha?: string | null;
    baseSha?: string | null;
    state: ScmPullRequestState;
    createdAtMs?: number;
    closedAtMs?: number;
    mergedAtMs?: number;
    isDraft?: boolean;
    author?: {
        [key: string]: unknown;
        login?: string;
        displayName?: string;
        url?: string;
    };
    checks?: {
        [key: string]: unknown;
        state: ScmPullRequestChecksState;
        description?: string;
    };
};


import type { ProtocolComposableSchema } from './protocolFacade.js';

/** Branch discovery only; explicit Session relationships remain their owner's facts. */
export const ScmPullRequestSummaryProtocolSchema: ProtocolComposableSchema<ScmPullRequestSummary> = canonicalSummary;
