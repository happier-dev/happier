import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { HappierReviewFindingWindow } from '@happier-dev/plugin-ui';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { projectReviewFindingRoots } from '@/components/reviews/finding/reviewFindingRoots';
import { observeReviewCommentChanges } from '@/sync/domains/reviews/comments/commentChanges';
import {
    ensureReviewRunComments, loadReviewRunComments, markReviewRunCommentsFailed,
    readReviewRunComments, subscribeReviewRunComments,
} from '@/sync/domains/reviews/comments/reviewRunComments';

/** Admitted Resources borrow the same finite window and pushed revisions as native Reviews. */
export function createPluginReviewFindingsHostReadStore(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
}>): PluginUiResourceStore {
    const targetFor = (resource: Parameters<PluginUiResourceStore['getEntry']>[0]) => {
        if (typeof resource === 'string' || !('hostRead' in resource) || resource.hostRead !== 'reviews.comments.list') {
            throw Object.assign(new Error('Unsupported Review finding read'), { code: 'unsupported_method', retryable: false });
        }
        return { scope: input.lifetime.scope, reviewId: resource.input.reviewId };
    };
    const store = createPluginUiResourceStore({ accountLifetime: input.lifetime, client: {
        async readResource(resource) {
            const target = targetFor(resource);
            await ensureReviewRunComments(target);
            const snapshot = readReviewRunComments(target);
            const window = { ...snapshot,
                ...projectReviewFindingRoots(target.reviewId, snapshot.comments) } satisfies HappierReviewFindingWindow;
            const bytes = new TextEncoder().encode(JSON.stringify(window));
            return { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
        },
        async watchResource(resource, listener, options) {
            if (options?.signal?.aborted) return { dispose() {} };
            const target = targetFor(resource);
            const unsubscribe = subscribeReviewRunComments(target, () => listener({ kind: 'invalidated' }));
            const release = observeReviewCommentChanges({ ...target,
                readComments: () => readReviewRunComments(target).comments,
                reload: () => loadReviewRunComments(target),
                onReadFailed: () => markReviewRunCommentsFailed(target),
            });
            const dispose = () => {
                release(); unsubscribe(); options?.signal?.removeEventListener('abort', dispose);
            };
            options?.signal?.addEventListener('abort', dispose, { once: true });
            if (options?.signal?.aborted) dispose();
            return { dispose };
        },
    } });
    return {
        getEntry(resource) {
            const entry = store.getEntry(resource);
            const refresh = async () => {
                await loadReviewRunComments(targetFor(resource));
                return entry.refresh();
            };
            return { ...entry, refresh, select(projection, selector) {
                return { ...entry.select(projection, selector), refresh: async () => { await refresh(); } };
            } };
        },
        dispose: store.dispose,
    } satisfies PluginUiResourceStore;
}
