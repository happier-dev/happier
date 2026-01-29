import * as React from 'react';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { Metadata } from '@/sync/storageTypes';
import { extractShellCommand } from '../utils/shellCommand';
import { maybeParseJson } from '../utils/parseJson';
import { extractStdStreams, tailTextWithEllipsis } from '../utils/stdStreams';

export const BashView = React.memo((props: { tool: ToolCall; metadata: Metadata | null; detailLevel?: 'title' | 'summary' | 'full' }) => {
    const { input, result, state } = props.tool;
    const command = extractShellCommand(input) ?? (typeof (input as any)?.command === 'string' ? (input as any).command : '');
    const isFullView = props.detailLevel === 'full';

    const parsedStreams = extractStdStreams(result);
    let unparsedOutput: string | null = null;
    let error: string | null = null;
    
    if (result && state === 'completed') {
        const parsedMaybe = maybeParseJson(result);
        if (typeof parsedMaybe === 'string') {
            unparsedOutput = parsedMaybe;
        } else if (!parsedStreams) {
            unparsedOutput = JSON.stringify(parsedMaybe);
        }
    } else if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    const maxStreamingChars = isFullView ? 8000 : 2000;
    const maxCompletedChars = 6000;
    const streamingStdout = parsedStreams?.stdout ? tailTextWithEllipsis(parsedStreams.stdout, maxStreamingChars) : null;
    const streamingStderr = parsedStreams?.stderr ? tailTextWithEllipsis(parsedStreams.stderr, maxStreamingChars) : null;
    const completedStdout =
        parsedStreams?.stdout
            ? (isFullView ? parsedStreams.stdout : tailTextWithEllipsis(parsedStreams.stdout, maxCompletedChars))
            : unparsedOutput;
    const completedStderr =
        parsedStreams?.stderr
            ? (isFullView ? parsedStreams.stderr : tailTextWithEllipsis(parsedStreams.stderr, maxCompletedChars))
            : null;

    return (
        <>
            <ToolSectionView>
                <CommandView 
                    command={command}
                    stdout={state === 'running' ? streamingStdout : (state === 'completed' ? completedStdout : null)}
                    stderr={state === 'running' ? streamingStderr : (state === 'completed' ? completedStderr : null)}
                    error={error}
                    hideEmptyOutput
                    fullWidth={isFullView}
                />
            </ToolSectionView>
        </>
    );
});
