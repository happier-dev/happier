import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { PierreDiffViewer } from './pierre/PierreDiffViewer.web';
import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierre/pierreRuntimeSupport.web';
import { useInitialPresentationReadiness } from '@/components/ui/presentation/InitialPresentationReadinessContext';

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const rendererMode = useSetting('filesDiffRendererMode');
    const initialPresentationReadiness = useInitialPresentationReadiness();

    const wantsPierre = rendererMode === 'pierre';
    const rangeInteractionRequired = typeof props.onPressLineRange === 'function'
        && (props.interactionMode ?? 'read') !== 'read';
    const pierreAllowed = wantsPierre
        && !rangeInteractionRequired
        && isPierreDiffKillSwitchEnabled()
        && supportsPierreRuntime();

    if (pierreAllowed) {
        const viewer = <PierreDiffViewer {...props} />;
        return props.virtualized === true ? (
            <LazyMountOnScreen
                initiallyVisible={initialPresentationReadiness?.presentationPending === true}
            >
                {viewer}
            </LazyMountOnScreen>
        ) : viewer;
    }

    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} />;
    }
    return <HappierTextDiffViewer {...props} />;
});
