import * as React from 'react';

import type { FileDiffMetadata } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
    useInitialPresentationProducer,
    useInitialPresentationReadiness,
} from '@/components/ui/presentation/InitialPresentationReadinessContext';

type PierreInitialPresentationObservation = Readonly<{
    cacheKey: string;
    forceFallback: boolean;
    terminal: boolean;
}>;

export function buildPierreInitialPresentationCacheKey(params: Readonly<{
    fileName: string;
    language: string | null;
    patch: string;
}>): string {
    const content = `${params.fileName}\0${params.language ?? ''}\0${params.patch}`;
    return `happier-pierre-diff:v1:${bytesToHex(sha256(utf8ToBytes(content)))}`;
}

export function isPierreInitialPresentationDomTerminal(params: Readonly<{
    fileDiff: FileDiffMetadata;
    pool: WorkerPoolManager;
    root: HTMLElement | null;
    virtualized: boolean;
}>): boolean {
    const root = params.root;
    if (!root) return false;
    if (root.querySelector('[data-testid="pierre-diff-fallback"]')) return true;
    const host = root.querySelector('diffs-container') as (HTMLElement & {
        shadowRoot: ShadowRoot | null;
    }) | null;
    const shadowRoot = host?.shadowRoot ?? null;
    if (!shadowRoot) return false;
    if (shadowRoot.querySelector('[data-error-wrapper]')) return true;
    if (params.virtualized && shadowRoot.querySelector('[data-placeholder]')) return true;
    return params.pool.getDiffResultCache(params.fileDiff) !== undefined
        && shadowRoot.querySelector('pre[data-diff]') !== null;
}

export function observePierreInitialPresentationDom(
    root: HTMLElement,
    onMutation: () => void,
): () => void {
    const MutationObserverCtor = globalThis.MutationObserver;
    if (typeof MutationObserverCtor !== 'function') return () => {};
    let observedShadowRoot: ShadowRoot | null = null;
    const observer = new MutationObserverCtor(() => {
        observeCurrentShadowRoot();
        onMutation();
    });
    function observeCurrentShadowRoot(): void {
        const host = root.querySelector('diffs-container') as (HTMLElement & {
            shadowRoot: ShadowRoot | null;
        }) | null;
        const shadowRoot = host?.shadowRoot ?? null;
        if (!shadowRoot || shadowRoot === observedShadowRoot) return;
        observedShadowRoot = shadowRoot;
        observer.observe(shadowRoot, { attributes: true, childList: true, subtree: true });
    }
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    observeCurrentShadowRoot();
    return () => observer.disconnect();
}

export function usePierreInitialPresentation(params: Readonly<{
    cacheKey: string;
    containerRef: React.RefObject<HTMLDivElement | null>;
    fileDiff: FileDiffMetadata;
    parsedPatch: FileDiffMetadata | null;
    pool: WorkerPoolManager | null;
    virtualized: boolean;
}>): boolean {
    const readiness = useInitialPresentationReadiness();
    const presentationPending = readiness?.presentationPending === true;
    const [observation, setObservation] = React.useState<PierreInitialPresentationObservation>(() => ({
        cacheKey: params.cacheKey,
        forceFallback: presentationPending && params.parsedPatch != null && params.pool == null,
        terminal: params.parsedPatch == null,
    }));
    const effectiveObservation = observation.cacheKey === params.cacheKey
        ? observation
        : {
            cacheKey: params.cacheKey,
            forceFallback: presentationPending && params.parsedPatch != null && params.pool == null,
            terminal: params.parsedPatch == null,
        };

    React.useLayoutEffect(() => {
        if (!presentationPending || params.parsedPatch == null) return undefined;
        if (!params.pool) {
            setObservation({
                cacheKey: params.cacheKey,
                forceFallback: true,
                terminal: true,
            });
            return undefined;
        }

        const pool = params.pool;
        let disposed = false;
        let sawPoolWork = false;
        const publish = (next: Pick<PierreInitialPresentationObservation, 'forceFallback' | 'terminal'>) => {
            if (disposed) return;
            setObservation((previous) => {
                if (
                    previous.cacheKey === params.cacheKey
                    && previous.forceFallback === next.forceFallback
                    && previous.terminal === next.terminal
                ) return previous;
                return {
                    cacheKey: params.cacheKey,
                    ...next,
                };
            });
        };
        const evaluateDom = (): boolean => {
            const terminal = isPierreInitialPresentationDomTerminal({
                fileDiff: params.fileDiff,
                pool,
                root: params.containerRef.current,
                virtualized: params.virtualized,
            });
            if (terminal) publish({ forceFallback: false, terminal: true });
            return terminal;
        };
        const unsubscribe = pool.subscribeToStatChanges((stats) => {
            if (stats.workersFailed) {
                publish({ forceFallback: true, terminal: true });
                return;
            }
            if (evaluateDom()) return;
            const hasPoolWork = stats.busyWorkers > 0 || stats.pendingTasks > 0 || stats.queuedTasks > 0;
            if (hasPoolWork) {
                sawPoolWork = true;
                return;
            }
            if (sawPoolWork && stats.managerState === 'initialized') {
                // Pierre's render-error callback is not public. An observed request
                // draining without the exact cache entry is the truthful terminal
                // failure boundary; keep the app fallback for this mounted instance.
                publish({ forceFallback: true, terminal: true });
            }
        });

        const root = params.containerRef.current;
        const stopObservingDom = root
            ? observePierreInitialPresentationDom(root, evaluateDom)
            : () => {};
        evaluateDom();

        return () => {
            disposed = true;
            stopObservingDom();
            unsubscribe();
        };
    }, [
        params.cacheKey,
        params.containerRef,
        params.fileDiff,
        params.parsedPatch,
        params.pool,
        params.virtualized,
        presentationPending,
    ]);

    const terminal =
        params.parsedPatch == null ||
        effectiveObservation.forceFallback ||
        effectiveObservation.terminal;
    useInitialPresentationProducer({
        producerKey: `pierre:${params.cacheKey}`,
        terminal,
    });
    return effectiveObservation.forceFallback;
}
