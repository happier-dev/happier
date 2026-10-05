import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { PierreDiffViewer } from './pierre/PierreDiffViewer.web';
import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierre/pierreRuntimeSupport.web';
import { useInitialPresentationReadiness } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { useEffectiveDiffWrapLines } from './diffPresentationStyle';

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const rendererMode = useSetting('filesDiffRendererMode');
    const initialPresentationReadiness = useInitialPresentationReadiness();
    const wrapLines = useEffectiveDiffWrapLines(props.wrapLines);

    const wantsPierre = rendererMode === 'pierre';
    const rangeInteractionRequired = typeof props.onPressLineRange === 'function'
        && (props.interactionMode ?? 'read') !== 'read';
    const pierreAllowed = wantsPierre
        && !rangeInteractionRequired
        // Find uses the canonical CodeLine range renderer and line virtualizer target.
        // @pierre/diffs 1.1.0-beta.13 exposes neither a FileDiff line-target handle nor
        // a Virtualizer offscreen line-reveal API. Its DOM-only reveal misses unmounted rows.
        // Keep the saved renderer preference untouched; closing Find restores Pierre.
        && props.findActive !== true
        && isPierreDiffKillSwitchEnabled()
        && supportsPierreRuntime();

    if (pierreAllowed) {
        const viewer = <PierreDiffViewer {...props} wrapLines={wrapLines} />;
        return props.virtualized === true ? (
            <LazyMountOnScreen
                initiallyVisible={initialPresentationReadiness?.presentationPending === true}
            >
                {viewer}
            </LazyMountOnScreen>
        ) : viewer;
    }

    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} wrapLines={wrapLines} />;
    }
    return <HappierTextDiffViewer {...props} wrapLines={wrapLines} />;
});
