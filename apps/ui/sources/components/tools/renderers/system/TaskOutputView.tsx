import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { CodeView } from '@/components/ui/media/CodeView';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { t } from '@/text';

import type { ToolViewProps } from '../core/_registry';
import { maybeParseJson } from '@happier-dev/protocol';
import { tailTextWithEllipsis } from "@happier-dev/session-core/tools";
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

const MAX_OUTPUT_CHARS = 4000;

export const projectTaskOutputDisplayText: ToolDisplayTextProjector = (tool) => {
    if (tool.state === 'running' && readBoolean(maybeParseJson(tool.input), 'block')) {
        return toolTextBlock('tool-task-output-waiting', t('tools.taskOutputView.waitingForTask'));
    }
    return toolTextBlock('tool-task-output-body', readOutputText(tool.result));
};

/**
 * `TaskOutput` reads the output of a *background task* — a detached `Bash` command or a backgrounded
 * agent. It is a real Claude Agent SDK tool (`TaskOutputInput`), not a subagent launch, so it must
 * not borrow the subagent card.
 *
 * Its transcript payload is deliberately thin: the SDK publishes no `TaskOutputOutput` shape at all,
 * and a launcher that blanks `TaskOutput` tool-result content (the raw payload can be a whole JSONL
 * transcript) leaves nothing to render. So this card shows only what is attested — that the model is
 * waiting on the task, and the output when a path actually retained it — and nothing else.
 */
export const TaskOutputView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (detailLevel === 'title') return null;

    const blocks = projectTaskOutputDisplayText(tool);
    const waiting = blocks.find((block) => block.id === 'tool-task-output-waiting')?.text;
    const output = blocks.find((block) => block.id === 'tool-task-output-body')?.text;

    if (waiting) {
        return (
            <ToolSectionView>
                <ToolFindText text={waiting} blockId="tool-task-output-waiting" messageId={messageId} style={styles.notice} />
            </ToolSectionView>
        );
    }

    if (!output) return null;

    return (
        <ToolSectionView fullWidth={detailLevel === 'full'}>
            <CodeView code={detailLevel === 'full' || find.active ? output : tailTextWithEllipsis(output, MAX_OUTPUT_CHARS)} findRanges={find.ranges('tool-task-output-body')} />
        </ToolSectionView>
    );
});

function readOutputText(result: unknown): string | null {
    const parsed = maybeParseJson(result);
    if (typeof parsed === 'string') {
        const trimmed = parsed.trim();
        return trimmed.length > 0 ? parsed : null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ['output', 'stdout', 'content', 'text'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return null;
}

function readBoolean(value: unknown, key: string): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (value as Record<string, unknown>)[key] === true;
}

const styles = StyleSheet.create((theme) => ({
    notice: {
        marginHorizontal: 12,
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));
