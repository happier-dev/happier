import * as React from 'react';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} />;
    }
    return <HappierTextDiffViewer {...props} />;
});
