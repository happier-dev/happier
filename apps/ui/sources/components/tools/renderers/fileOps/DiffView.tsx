import * as React from 'react';
import type { ToolViewProps } from '../core/_registry';
import { buildDiffBlocks, buildDiffFileEntries, type DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { ToolFileDiffListView } from './ToolFileDiffListView';
import { projectToolFileDiffDisplayText } from './toolDiffDisplayText';
import type { ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';

export const projectDiffDisplayText: ToolDisplayTextProjector = (tool) => projectToolFileDiffDisplayText(buildDiffFileEntries(buildDiffBlocks(tool.input)), 'tool-diff');

export const DiffView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId: sessionIdProp, serverId, messageId }) => {
    const { input } = tool;

    const blocks = React.useMemo(() => buildDiffBlocks(input), [input]);
    const files: DiffFileEntry[] = React.useMemo(() => buildDiffFileEntries(blocks), [blocks]);

    if (files.length === 0) {
        return null;
    }

    return <ToolFileDiffListView files={files} detailLevel={detailLevel} sessionId={sessionIdProp} serverId={serverId} messageId={messageId} findBlockPrefix="tool-diff" />;
});
