import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useAskSessionReveal } from '@/components/ui/code/selection/useAskSessionReveal';
import { AskSelectionControls, type AskSelectionControlsProps } from '@/components/ui/code/selection/AskSelectionControls';
import type { NativeLineRangeSelection } from '@/components/ui/code/selection/nativeLineRangeSelection';
import { readCodeLineFromDomNode, resolveSourceLinesForText, useDomTextSelection } from '@/components/ui/code/selection/useDomTextSelection';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { readDiffLineFromDomNode, resolveDiffSelectionLines } from '@/components/ui/code/diff/diffTextSelection';
import { PIERRE_DIFF_HOST_SELECTOR } from '@/components/ui/code/diff/pierre/pierreDomLine';

/**
 * Ask about a selection in the File page's read bodies (lab AS1): the code view (rows know their file
 * line), the Markdown preview (lines found in its source) and the Changes diff (rows know their old/new
 * lines, either renderer; `text` is then the unified diff). The same controls as the editor's. A touch host
 * has no DOM selection: its code rows publish the long-press and tap range through `lineRange`.
 */
export function FileReadAskControls(props: Readonly<{
    rootRef: React.RefObject<unknown>;
    mode: 'code' | 'markdown' | 'diff';
    scopeId: string;
    scope: WorkspaceScopeBase;
    filePath: string;
    text: string;
    sessionId: string | null;
    active: boolean;
    /** Comment opens the page's inline composer with the selected source lines and diff side. */
    onCommentRange?: AskSelectionControlsProps['onCommentSelection'];
    onPhoneBarShownChange?: AskSelectionControlsProps['onPhoneBarShownChange'];
    lineRange?: NativeLineRangeSelection;
}>): React.ReactElement | null {
    const pane = useAppPaneScope(props.scopeId, () => null);
    const revealSessionColumn = useAskSessionReveal();
    const text = props.text;
    const resolveLines = React.useCallback((range: Parameters<Parameters<typeof useDomTextSelection>[0]['resolveLines']>[0]) => {
        if (props.mode === 'markdown') return resolveSourceLinesForText(text, range.text);
        if (props.mode === 'diff') return resolveDiffSelectionLines(readDiffLineFromDomNode(range.startNode), readDiffLineFromDomNode(range.endNode));
        const start = readCodeLineFromDomNode(range.startNode);
        const end = readCodeLineFromDomNode(range.endNode);
        return start === null || end === null ? null : { startLine: Math.min(start, end), endLine: Math.max(start, end) };
    }, [props.mode, text]);
    const domSource = useDomTextSelection({ rootRef: props.rootRef, active: props.active, resolveLines,
        ...(props.mode === 'diff' ? { shadowHostSelector: PIERRE_DIFF_HOST_SELECTOR } : {}) });
    const source = props.lineRange
        ? { getSelection: props.lineRange.getSelection, subscribeSelection: props.lineRange.subscribe }
        : domSource;
    const diffLines = React.useMemo(() => props.mode === 'diff' ? buildCodeLinesFromUnifiedDiff({ unifiedDiff: text, hideFilePrelude: true }) : undefined,
        [props.mode, text]);
    const getLinesText = React.useCallback(() => text, [text]);
    const sessionTarget = React.useMemo(() => props.sessionId ? { sessionId: props.sessionId, revealSessionColumn } : null,
        [props.sessionId, revealSessionColumn]);
    return (
        <AskSelectionControls
            scopeId={props.scopeId}
            workspaceScope={props.scope}
            filePath={props.filePath}
            source={props.mode === 'code' ? 'file' : props.mode}
            lines={diffLines}
            sourceLinesMapped={props.mode === 'markdown'}
            getSelection={source.getSelection}
            subscribeSelection={source.subscribeSelection}
            getLinesText={getLinesText}
            savedText={text}
            sessionTarget={sessionTarget}
            openDetailsTab={pane.openDetailsTab}
            active={props.active}
            onCommentSelection={props.onCommentRange}
            onPhoneBarShownChange={props.onPhoneBarShownChange}
            testID="file-read-selection-toolbar"
        />
    );
}
