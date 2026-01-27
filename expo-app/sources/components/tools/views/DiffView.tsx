import * as React from 'react';
import type { ToolViewProps } from './_registry';
import { CodexDiffView } from './CodexDiffView';

export const DiffView = React.memo<ToolViewProps>(({ tool, metadata }) => {
    return <CodexDiffView tool={tool as any} metadata={metadata} />;
});

