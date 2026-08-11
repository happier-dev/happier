import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { ToolViewProps } from '../core/_registry';
import { maybeParseJson } from '../../normalization/parse/parseJson';
import { tailTextWithEllipsis } from '../../normalization/parse/stdStreams';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';

const MAX_OUTPUT_CHARS = 4000;

/**
 * `TaskOutput` reads the output of a *background task* — a detached `Bash` command or a backgrounded
 * agent. It is a real Claude Agent SDK tool (`TaskOutputInput`), not a subagent launch, so it must
 * not borrow the subagent card.
 *
 * Its transcript payload is deliberately thin: the Claude launcher blanks `TaskOutput` tool-result
 * content because the raw payload is a whole JSONL transcript
 * (`apps/cli/src/backends/claude/claudeRemoteLauncher.ts`), and the SDK publishes no
 * `TaskOutputOutput` shape at all. So this card renders only what is attested — that the model is
 * waiting on the task, and the output when a path actually retained it — and nothing else.
 */
export const TaskOutputView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;

    const isBlocking = readBoolean(maybeParseJson(tool.input), 'block');
    const output = readOutputText(tool.result);

    if (tool.state === 'running' && isBlocking) {
        return (
            <ToolSectionView>
                <Text style={styles.notice}>{t('tools.taskOutputView.waitingForTask')}</Text>
            </ToolSectionView>
        );
    }

    if (!output) return null;

    return (
        <ToolSectionView fullWidth={detailLevel === 'full'}>
            <CodeView code={detailLevel === 'full' ? output : tailTextWithEllipsis(output, MAX_OUTPUT_CHARS)} />
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
