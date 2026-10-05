import { extractShellCommand, stripShellCommandPreludeForDisplay } from '@happier-dev/protocol';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from "@happier-dev/session-core/messages";
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { CommandView } from '@/components/sessions/transcript/CommandView';
import { maybeParseJson } from '@happier-dev/protocol';
import { extractStdStreams, tailTextWithEllipsis } from "@happier-dev/session-core/tools";
import { CodeView } from '@/components/ui/media/CodeView';
import { t } from '@/text';
import type { ToolViewProps } from '../core/_registry';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';

function getBashDisplay(tool: ToolCall, full: boolean) {
    const { input, result, state } = tool;
    const rawCommand = extractShellCommand(input) ?? '';
    const rawCommandTrimmed = typeof rawCommand === 'string' ? rawCommand.trim() : String(rawCommand ?? '');
    const command = stripShellCommandPreludeForDisplay(rawCommandTrimmed);
    const didStripPrelude = rawCommandTrimmed.length > 0 && command !== rawCommandTrimmed;

    const parsedStreams = extractStdStreams(result);
    let unparsedOutput: string | null = null;
    let error: string | null = null;
    
    if (result && state === 'completed') {
        const parsedMaybe = maybeParseJson(result);
        if (typeof parsedMaybe === 'string') {
            unparsedOutput = parsedMaybe;
        } else if (!parsedStreams) {
            // When providers return a structured "bash result" envelope with empty stdout/stderr,
            // don't dump the entire object into the transcript.
            const obj = parsedMaybe && typeof parsedMaybe === 'object' && !Array.isArray(parsedMaybe) ? (parsedMaybe as Record<string, unknown>) : null;
            const hasStdEnvelope =
                !!obj &&
                ('stdout' in obj || 'stderr' in obj || 'aggregated_output' in obj || 'formatted_output' in obj);
            if (!hasStdEnvelope && full) {
                unparsedOutput = JSON.stringify(parsedMaybe);
            }
        }
    } else if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    const stdout = parsedStreams?.stdout || unparsedOutput;
    const stderr = parsedStreams?.stderr || null;
    return {
        command, rawCommandTrimmed, didStripPrelude,
        stdout: stdout?.trim() ? stdout : null,
        stdoutIsStream: Boolean(parsedStreams?.stdout),
        stderr: stderr?.trim() ? stderr : null,
        error,
    };
}

export const projectBashDisplayText: ToolDisplayTextProjector = (tool) => {
    const display = getBashDisplay(tool, true);
    return [
        ...toolTextBlock('tool-command', display.command),
        ...toolTextBlock('tool-stdout', tool.state === 'running' || tool.state === 'completed' ? display.stdout : null),
        ...toolTextBlock('tool-stderr', tool.state === 'running' || tool.state === 'completed' ? display.stderr : null),
        ...toolTextBlock('tool-error', display.error),
        ...toolTextBlock('tool-command-raw', display.didStripPrelude ? display.rawCommandTrimmed : null),
        ...toolTextBlock('tool-command-raw-title', display.didStripPrelude ? t('tools.bashView.commandDiffTitle') : null),
        ...toolTextBlock('tool-command-raw-hint', display.didStripPrelude ? t('tools.bashView.commandDiffHint') : null),
    ];
};

export const BashView = React.memo<ToolViewProps>((props) => {
    const find = useToolFindState(props.messageId);
    const { state } = props.tool;
    const isFullView = props.detailLevel === 'full' || find.active;
    const display = getBashDisplay(props.tool, isFullView);
    const { command, rawCommandTrimmed, didStripPrelude, error } = display;
    const maxStreamingChars = isFullView ? 8000 : 2000;
    const maxCompletedChars = 6000;
    const streamingStdout = display.stdout ? (find.active ? display.stdout : tailTextWithEllipsis(display.stdout, maxStreamingChars)) : null;
    const streamingStderr = display.stderr ? (find.active ? display.stderr : tailTextWithEllipsis(display.stderr, maxStreamingChars)) : null;
    const completedStdout =
        display.stdout ? (isFullView || !display.stdoutIsStream ? display.stdout : tailTextWithEllipsis(display.stdout, maxCompletedChars)) : null;
    const completedStderr =
        display.stderr ? (isFullView ? display.stderr : tailTextWithEllipsis(display.stderr, maxCompletedChars)) : null;

    return (
        <>
            <ToolSectionView>
                <CommandView 
                    command={command}
                    stdout={state === 'running' ? streamingStdout : (state === 'completed' ? completedStdout : null)}
                    stderr={state === 'running' ? streamingStderr : (state === 'completed' ? completedStderr : null)}
                    error={error}
                    commandFindRanges={find.ranges('tool-command')}
                    stdoutFindRanges={find.ranges('tool-stdout')}
                    stderrFindRanges={find.ranges('tool-stderr')}
                    errorFindRanges={find.ranges('tool-error')}
                    hideEmptyOutput
                    fullWidth={isFullView}
                />
            </ToolSectionView>
            {isFullView && didStripPrelude ? (
                <ToolSectionView title={t('tools.bashView.commandDiffTitle')} titleFindRanges={find.ranges('tool-command-raw-title')} fullWidth>
                    <ToolFindText style={styles.commandDiffHint} numberOfLines={3}
                        text={t('tools.bashView.commandDiffHint')} blockId="tool-command-raw-hint" messageId={props.messageId} />
                    <CodeView code={rawCommandTrimmed} findRanges={find.ranges('tool-command-raw')} />
                </ToolSectionView>
            ) : null}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    commandDiffHint: {
        marginHorizontal: 12,
        marginBottom: 8,
        color: theme.colors.text.secondary,
    },
}));
