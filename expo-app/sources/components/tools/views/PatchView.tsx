import * as React from 'react';
import type { ToolViewProps } from './_registry';
import { CodexPatchView } from './CodexPatchView';

export const PatchView = React.memo<ToolViewProps>(({ tool, metadata }) => {
    return <CodexPatchView tool={tool} metadata={metadata} />;
});

