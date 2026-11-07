import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForgeReleaseActionInputByOperationV1, ForgeReleaseAssetPageV1, ForgeReleaseAssetV1, ForgeReleaseV1 } from '@happier-dev/triage-protocol/releases/v1';
import { triagePagedPanelInitialState, triagePagedPanelReducer, type TriagePagedPanelStateV1, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { hasCompleteReleaseAssetsV1, reconcileReleaseAssetsV1 } from '../../releases/mapping.js';
import type { GithubReleaseReadsV1 } from '../../releases/reads.js';
import { useGithubReleaseQueryV1 } from './hooks.js';

type AssetWalk = TriagePagedPanelStateV1<ForgeReleaseAssetV1, TriageSourceFailureV1, ForgeReleaseAssetPageV1['incomplete']>;
const emptyPage: ForgeReleaseAssetPageV1 = { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };
const rowPolicy = { reconcileRows(previous: readonly ForgeReleaseAssetV1[], incoming: readonly ForgeReleaseAssetV1[], { replacing }: Readonly<{ replacing: boolean }>) {
    const byId = new Map((replacing ? [] : previous).map(row => [row.assetId, row]));
    for (const row of incoming) byId.set(row.assetId, row);
    return reconcileReleaseAssetsV1({ ...emptyPage, rows: previous }, { ...emptyPage, rows: [...byId.values()] }).rows;
} };

/** Exact selected facts and the incumbent page walk, independent of release-list residency. No history crawl. */
export function useReleaseDetailV1(reads: GithubReleaseReadsV1 | null,
    input: ForgeReleaseActionInputByOperationV1['readRelease'] | null, assetsOpen: boolean, rendererSignal?: AbortSignal) {
    const exact = useGithubReleaseQueryV1(reads, 'readRelease', input);
    const release = exact.value?.kind === 'value' ? exact.value.value : null;
    const assetInput = release && assetsOpen && !hasCompleteReleaseAssetsV1(release.assets)
        ? { repository: release.repository, repositoryId: release.repositoryId, releaseId: release.releaseId } : null;
    const assets = useGithubReleaseQueryV1(reads, 'listAssets', assetInput);
    const key = JSON.stringify(assetInput);
    const [held, setHeld] = useState<Readonly<{ reads: typeof reads; key: string; walk: AssetWalk }> | null>(null);
    const token = useRef(0);
    const lifetime = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController(); lifetime.current = controller;
        const retire = () => controller.abort();
        rendererSignal?.addEventListener('abort', retire, { once: true });
        if (rendererSignal?.aborted) retire();
        return () => { rendererSignal?.removeEventListener('abort', retire); retire(); };
    }, [reads, key, rendererSignal]);
    const first = assets.value?.kind === 'value' ? assets.value.value : null;
    useEffect(() => {
        if (!assetInput || !first) return;
        const next = ++token.current;
        setHeld(current => {
            const prior = current?.reads === reads && current.key === key ? current.walk : triagePagedPanelInitialState<ForgeReleaseAssetV1, TriageSourceFailureV1, ForgeReleaseAssetPageV1['incomplete']>();
            const pending = triagePagedPanelReducer(prior, { kind: 'refreshStarted', token: next }, rowPolicy);
            return { reads, key, walk: triagePagedPanelReducer(pending, { kind: 'pageSettled', token: next, page: first }, rowPolicy) };
        });
    }, [reads, key, first]);
    const walk = held?.reads === reads && held.key === key ? held.walk : null;
    const loadMoreAssets = useCallback(async (signal?: AbortSignal) => {
        const controller = lifetime.current;
        if (!reads || !assetInput || !walk?.continuation || walk.pending || !controller || controller.signal.aborted || signal?.aborted) return false;
        const next = ++token.current;
        setHeld(current => current?.reads === reads && current.key === key
            ? { ...current, walk: triagePagedPanelReducer(current.walk, { kind: 'requestStarted', token: next }, rowPolicy) } : current);
        const request = new AbortController();
        const cancel = () => request.abort();
        controller.signal.addEventListener('abort', cancel, { once: true });
        signal?.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted || signal?.aborted) cancel();
        try {
            const result = await reads.read('listAssets', { ...assetInput, cursor: walk.continuation }, request.signal);
            if (request.signal.aborted) {
                // Caller cancellation keeps the current page usable; a retired renderer never publishes.
                if (!controller.signal.aborted) setHeld(current => token.current === next && current?.reads === reads && current.key === key
                    ? { ...current, walk } : current);
                return false;
            }
            setHeld(current => {
                if (current?.reads !== reads || current.key !== key) return current;
                const event = result.kind === 'value' ? { kind: 'pageSettled' as const, token: next, page: result.value }
                    : result.kind === 'unavailable' ? { kind: 'pageFailed' as const, token: next, failure: result.failure } : null;
                return event ? { ...current, walk: triagePagedPanelReducer(current.walk, event, rowPolicy) } : current;
            });
            return result.kind === 'value';
        } finally {
            controller.signal.removeEventListener('abort', cancel);
            signal?.removeEventListener('abort', cancel);
        }
    }, [reads, key, walk?.continuation, walk?.pending]);
    const selected = useMemo<ForgeReleaseV1 | null>(() => release && walk ? { ...release, assets: {
        rows: walk.rows, omittedRowCount: walk.omittedRowCount, projectionTruncated: walk.projectionTruncated,
        continuation: walk.continuation, incomplete: walk.incomplete,
    } } : release, [release, walk?.rows, walk?.omittedRowCount, walk?.projectionTruncated, walk?.continuation, walk?.incomplete]);
    return { release: selected, status: exact.status, refresh: exact.refresh,
        assetsStatus: { pending: assets.status.pending || (walk?.pending ?? false), failure: walk?.failure ?? assets.status.failure },
        loadMoreAssets };
}
