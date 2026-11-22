import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { openReviewArtifactV1, projectReviewRoundQualityV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { ReviewPrRoundQualityV1 } from '@happier-dev/protocol/reviews/reviewQualityPresentationV1';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
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
    const readRoundEvidence = async (value: ReviewDetailData, signal?: AbortSignal) => {
        const { review } = value;
        if (review.subjectKind !== 'pull_request' || (review.state !== 'completed' && review.state !== 'partial')) return undefined;
        try {
            const { sync } = await import('@/sync/sync');
            const artifact = await sync.fetchArtifactWithBody(review.reviewId, {
                expectedScope: input.lifetime.scope, signal, prepareRecipientKeys: false,
            });
            if (!artifact?.isDecrypted || !input.lifetime.isCurrent() || signal?.aborted) return undefined;
            const record = openReviewArtifactV1({ artifactId: artifact.id,
                header: artifact.rawHeader ?? artifact.header ?? {}, body: artifact.body });
            const round = record.rounds.find(candidate => candidate.ordinal === review.currentRoundOrdinal);
            const { settings, settingsScope } = getStorage().getState();
            const aggregation = areServerAccountScopesEqual(settingsScope, input.lifetime.scope)
                ? settings.reviewQualityAggregation : 'lowest';
            const quality = projectReviewRoundQualityV1(round, aggregation);
            const roundOrdinal = review.currentRoundOrdinal;
            const roundQuality: ReviewPrRoundQualityV1 | undefined = quality ? {
                roundOrdinal, aggregation: quality.aggregation, score: quality.score,
                reviewers: quality.reviewers.map(({ displayName, score }) => ({ displayName, score })),
            } : undefined;
            const walkthrough = round?.comparisonCapture
                ? await (await import('@/sync/ops/scmDiffSummary/readCapturedScmWalkthrough'))
                    .readCapturedScmWalkthrough(round.comparisonCapture, input.lifetime, signal).catch(error => {
                        if (!input.lifetime.isCurrent() || signal?.aborted) throw error;
                        return undefined;
                    })
                : undefined;
            const roundWalkthrough = walkthrough?.stops.length ? {
                roundOrdinal, stops: walkthrough.stops.map(({ title, explanationMarkdown }) => ({ title, explanationMarkdown })),
            } : undefined;
            return { roundQuality, roundWalkthrough };
        } catch (error) {
            if (!input.lifetime.isCurrent() || signal?.aborted) throw error;
            // Locked or unavailable Review content leaves metadata and findings available.
            return undefined;
        }
    };
    const store = createPluginUiResourceStore({ accountLifetime: input.lifetime, client: {
        async readResource(resource, options) {
            const value = await readSnapshot(reviewIdFor(resource), options?.signal);
            const evidence = await readRoundEvidence(value, options?.signal);
            const bytes = new TextEncoder().encode(JSON.stringify(evidence ? { ...value, ...evidence } : value));
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
            const unsubscribeSettings = getStorage().subscribe(() => {
                const review = getReviewDetailSnapshot(key).data?.review;
                if (review?.subjectKind === 'pull_request' && review.state === 'completed') listener({ kind: 'invalidated' });
            }, { settings: ['reviewQualityAggregation'], settingsScope: true });
            const dispose = () => {
                unsubscribe(); unsubscribeSettings(); release();
                options?.signal?.removeEventListener('abort', dispose);
            };
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
