import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useInitialPresentationReadiness } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { useEffectiveDiffWrapLines } from './diffPresentationStyle';
import { getLoadedPierreRenderer, loadPierreRenderer } from './pierre/pierreRendererLoader.web';
import { ProseDiffViewer } from './prose/ProseDiffViewer';
import { useDiffHunkSlots } from './hunks/useDiffHunkSlots';
import { renderDiffHunkRow } from './hunks/DiffHunkRow';
import { usePierreAllowed } from './inlineDiffScrollOwner.web';

const PierreDiffViewer = retryableLazy(async () => ({ default: (await loadPierreRenderer()).PierreDiffViewer }));

const boundedLazyMountStyle: React.CSSProperties = { height: '100%', minHeight: 0, position: 'relative' };

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const pierreAllowed = usePierreAllowed(Boolean(props.renderLeadingLane));
    // A body that mounts once the renderer has loaded draws it directly; one mounted earlier keeps its
    // lazy boundary for its lifetime, so the renderer never remounts under it.
    const [loadedPierreViewer] = React.useState(() => getLoadedPierreRenderer()?.PierreDiffViewer ?? null);
    const initialPresentationReadiness = useInitialPresentationReadiness();
    const wrapLines = useEffectiveDiffWrapLines(props.wrapLines);
    const { renderAfterLine, reviewedLineIds } = useDiffHunkSlots(props, renderDiffHunkRow);

    // Prose is its own face on every renderer: a reading layout, not a code diff.
    if (props.mode === 'text' && props.face === 'prose') return <ProseDiffViewer {...props} />;

    // A leading lane (the File page's blame column) is a per-line cell of the canonical line renderer.
    // Pierre has no per-line gutter slot (only hover utilities and after-line annotations), so a caller
    // that asks for one is served by the renderer that draws it: the same column View shows.
    if (pierreAllowed) {
        // An inline diff (a hunk card, a tool result) shows its code at once with the canonical line
        // renderer while the Pierre chunk and its worker load, so the reserved body is never an empty
        // card. A virtualized list diff can be very large, so it keeps the pane's loading state.
        const loading = props.virtualized === true
            ? props.leadingContent
                ? <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>{props.leadingContent}<PaneLoadingFallback testID="pierre-diff-loading" /></div>
                : <PaneLoadingFallback testID="pierre-diff-loading" />
            : props.mode === 'unified'
                ? <HappierUnifiedDiffViewer {...props} renderAfterLine={renderAfterLine} reviewedLineIds={reviewedLineIds} wrapLines={wrapLines} />
                : <HappierTextDiffViewer {...props} renderAfterLine={renderAfterLine} reviewedLineIds={reviewedLineIds} wrapLines={wrapLines} />;
        const viewer = loadedPierreViewer
            ? React.createElement(loadedPierreViewer, { ...props, renderAfterLine, reviewedLineIds, wrapLines })
            : (
                <React.Suspense fallback={loading}>
                    <PierreDiffViewer {...props} renderAfterLine={renderAfterLine} reviewedLineIds={reviewedLineIds} wrapLines={wrapLines} />
                </React.Suspense>
            );
        return props.virtualized === true ? (
            <LazyMountOnScreen
                initiallyVisible={initialPresentationReadiness?.presentationPending === true}
                style={boundedLazyMountStyle}
            >
                {viewer}
            </LazyMountOnScreen>
        ) : viewer;
    }

    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} renderAfterLine={renderAfterLine} reviewedLineIds={reviewedLineIds} wrapLines={wrapLines} />;
    }
    return <HappierTextDiffViewer {...props} renderAfterLine={renderAfterLine} reviewedLineIds={reviewedLineIds} wrapLines={wrapLines} />;
});
