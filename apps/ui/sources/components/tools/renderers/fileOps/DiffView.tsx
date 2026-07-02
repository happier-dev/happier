import * as React from 'react';
import type { ToolViewProps } from '../core/_registry';
import { buildDiffBlocks, buildDiffFileEntries, type DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { ToolFileDiffListView } from './ToolFileDiffListView';

export const DiffView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId: sessionIdProp }) => {
    const { input } = tool;

    const blocks = React.useMemo(() => buildDiffBlocks(input), [input]);
    const files: DiffFileEntry[] = React.useMemo(() => buildDiffFileEntries(blocks), [blocks]);

    if (files.length === 0) {
        return null;
    }

    return <ToolFileDiffListView files={files} detailLevel={detailLevel} sessionId={sessionIdProp} />;
});
