import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import { PluginError } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { readTaskOriginReview, setTaskOriginReview } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import type {
    TriageTaskOriginReviewV1, TriageSetTaskOriginReviewInputV1Schema, TriageSetTaskOriginReviewResultV1Schema,
    TriageReadTaskOriginReviewInputV1Schema, TriageReadTaskOriginReviewResultV1Schema,
} from './taskReviewProtocol.js';

/** The canonical Review read owns authorization; no Triage grant evaluator. */
export async function admitTaskReviewSelection(origin: TriageTaskOriginReviewV1, context: TriageDataActionContext): Promise<void> {
    const selection = { reviewId: origin.reviewId, commentIds: [...origin.findingIds], includeHistory: true, allPages: true as const };
    const result = await context.services.actions.execute('reviews.comments.list', selection, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) throw new PluginError({ code: 'approval_required', retryable: false });
    const found = new Set(result.items.map(comment => comment.id));
    if (origin.findingIds.some(id => !found.has(id))) {
        throw new PluginError({ code: 'review_comment_not_found', retryable: false });
    }
}

export function createTriageSetTaskOriginReviewActionHandler(): TriageDataActionHandler<
    ReturnType<typeof TriageSetTaskOriginReviewInputV1Schema.parse>, ReturnType<typeof TriageSetTaskOriginReviewResultV1Schema.parse>
> {
    return async (input, context) => {
        if (input.originReview !== null) await admitTaskReviewSelection(input.originReview, context);
        return { v: 1, ...await setTaskOriginReview({
            ...input, collections: bindCorpusCollections(requireTriageAccountStorage(context)),
            nowMs: context.invokedAtMs, signal: context.signal,
        }) };
    };
}

export function createTriageReadTaskOriginReviewActionHandler(): TriageDataActionHandler<
    ReturnType<typeof TriageReadTaskOriginReviewInputV1Schema.parse>, ReturnType<typeof TriageReadTaskOriginReviewResultV1Schema.parse>
> {
    return async (input, context) => ({ v: 1, originReview: await readTaskOriginReview({
        entryRef: input.entryRef, collections: bindCorpusCollections(requireTriageAccountStorage(context)), signal: context.signal,
    }) });
}
