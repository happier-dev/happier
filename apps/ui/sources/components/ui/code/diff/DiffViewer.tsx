import * as React from 'react';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { useEffectiveDiffWrapLines } from './diffPresentationStyle';

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const wrapLines = useEffectiveDiffWrapLines(props.wrapLines);
    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} wrapLines={wrapLines} />;
    }
    return <HappierTextDiffViewer {...props} wrapLines={wrapLines} />;
});
