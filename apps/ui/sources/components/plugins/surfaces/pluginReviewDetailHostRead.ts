import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { getReviewDetailSnapshot, reviewDetailKey, subscribeReviewDetail, type ReviewDetailData } from '@/sync/store/domains/reviews/detail';

/** Resource demand borrows the Review detail owner's reads and AccountChange observation. */
export function createPluginReviewDetailHostReadStore(input: Readonly<{
    lifetime: ServerAccountScopeLifetime;
}>): PluginUiResourceStore {
    // The Action reader reaches plugin composition, so acquire it after composition loads.
    const owner = () => import('@/sync/engine/reviews/detail');
    const reviewIdFor = (resource: Parameters<PluginUiResourceStore['getEntry']>[0]): string => {
        if (typeof resource === 'string' || !('hostRead' in resource) || resource.hostRead !== 'review.get') {
            throw Object.assign(new Error('Unsupported Review host read'), { code: 'unsupported_method', retryable: false });
        }
        return resource.input.reviewId;
    };
    const readSnapshot = async (reviewId: string, signal?: AbortSignal): Promise<ReviewDetailData> => {
        const engine = await owner();
        const key = reviewDetailKey(input.lifetime.scope, reviewId);
        let release = () => {};
        let unsubscribe = () => {};
        let abort = () => {};
        try {
            return await new Promise<ReviewDetailData>((resolve, reject) => {
                abort = () => reject(Object.assign(new Error('Review read cancelled'), { code: 'plugin_resource_aborted', retryable: false }));
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) { abort(); return; }
                const settle = () => {
                    const snapshot = getReviewDetailSnapshot(key);
                    if (snapshot.error) {
                        reject(Object.assign(new Error(snapshot.error.code ?? snapshot.error.kind), {
                            code: isAuthoritativeScopedSnapshotRefusalKind(snapshot.error.kind) ? 'permission_denied' : snapshot.error.code ?? snapshot.error.kind,
                            retryable: snapshot.error.retryable,
                        }));
                    } else if (snapshot.status === 'ready' && !snapshot.stale && snapshot.data) resolve(snapshot.data);
                };
                unsubscribe = subscribeReviewDetail(key, settle);
                // Invalidations consume a settled refusal instead of issuing another request.
                // Explicit recovery below is the canonical owner's refresh operation.
                if (!getReviewDetailSnapshot(key).error) release = engine.observeReviewDetail(input.lifetime.scope, reviewId);
                settle();
            });
        } finally { signal?.removeEventListener('abort', abort); unsubscribe(); release(); }
    };
    const store = createPluginUiResourceStore({ accountLifetime: input.lifetime, client: {
        async readResource(resource, options) {
            const value = await readSnapshot(reviewIdFor(resource), options?.signal);
            const bytes = new TextEncoder().encode(JSON.stringify(value));
            return { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
        },
        async watchResource(resource, listener, options) {
            const reviewId = reviewIdFor(resource);
            const engine = await owner();
            if (options?.signal?.aborted) return { dispose() {} };
            const key = reviewDetailKey(input.lifetime.scope, reviewId);
            const release = engine.observeReviewDetail(input.lifetime.scope, reviewId);
            const unsubscribe = subscribeReviewDetail(key, () => {
                const snapshot = getReviewDetailSnapshot(key);
                if (snapshot.error || snapshot.status === 'ready' && !snapshot.stale) listener({ kind: 'invalidated' });
            });
            const dispose = () => { unsubscribe(); release(); options?.signal?.removeEventListener('abort', dispose); };
            options?.signal?.addEventListener('abort', dispose, { once: true });
            if (options?.signal?.aborted) dispose();
            return { dispose };
        },
    } });
    return Object.freeze({
        getEntry(resource) {
            const entry = store.getEntry(resource);
            const refresh = async () => {
                const reviewId = reviewIdFor(resource);
                await (await owner()).refreshReviewDetail(input.lifetime.scope, reviewId);
                return await entry.refresh();
            };
            return Object.freeze({ ...entry, refresh,
                select(projection, selector) {
                    const selected = entry.select(projection, selector);
                    return Object.freeze({ ...selected, refresh: async () => { await refresh(); } });
                },
            });
        },
        dispose: store.dispose,
    } satisfies PluginUiResourceStore);
}
