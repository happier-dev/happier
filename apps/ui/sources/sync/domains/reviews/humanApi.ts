import { createReviewHumanActionExecutorV1, type ReviewHumanResourceV1 } from '@happier-dev/protocol/reviews/reviewHumanTransportV1';
import type { ReviewHumanActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** The admitted Artifact codec owns mode/key handling for every Review human reader and writer. */
export async function readReviewHumanResource(account: Pick<LazyActionAccountContext, 'readArtifactContent'>,
    reviewId: string, signal?: AbortSignal): Promise<ReviewHumanResourceV1> {
    const artifact = await account.readArtifactContent(reviewId, { includeAssociatedContentOpener: true, signal });
    if (!artifact?.openAssociatedContent || !artifact.sealAssociatedContent) {
        throw Object.assign(new Error('review_verdict_content_unavailable'), { code: 'review_verdict_content_unavailable' });
    }
    return { mode: artifact.storageMode, open: artifact.openAssociatedContent, seal: artifact.sealAssociatedContent };
}

/** Uses the captured answering Account's HTTP authority and existing Artifact content codec. */
export function createReviewHumanHttpActionExecutor(account: Pick<LazyActionAccountContext,
    'accountId' | 'request' | 'readArtifactContent' | 'assertCurrent'>) {
    return async (args: Readonly<{ actionId: ReviewHumanActionIdV1; input: unknown; signal?: AbortSignal }>) => {
        account.assertCurrent();
        const execute = createReviewHumanActionExecutorV1({ accountId: account.accountId,
            request: async (method, path, body) => {
                const response = await account.request(path, { method, signal: args.signal,
                    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
                const payload: unknown = await response.json();
                if (!response.ok) {
                    const code = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
                        ? payload.error : 'action_failed';
                    throw Object.assign(new Error(code), { code });
                }
                return payload;
            },
            resolveResource: reviewId => readReviewHumanResource(account, reviewId, args.signal),
        });
        return execute(args.actionId, args.input);
    };
}
