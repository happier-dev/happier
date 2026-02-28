import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { PierreDiffViewer } from './pierre/PierreDiffViewer.web';
import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierre/pierreRuntimeSupport.web';

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const rendererMode = useSetting('filesDiffRendererMode');

    const wantsPierre = rendererMode === 'pierre';
    const pierreAllowed = wantsPierre && isPierreDiffKillSwitchEnabled() && supportsPierreRuntime();

    if (pierreAllowed) {
        const viewer = <PierreDiffViewer {...props} />;
        return props.virtualized === true ? (
            <LazyMountOnScreen>
                {viewer}
            </LazyMountOnScreen>
        ) : viewer;
    }

    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} />;
    }
    return <HappierTextDiffViewer {...props} />;
});
