import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { resolveCodeMonoFontFamily } from '@/components/ui/code/codeTypography';
import type { TranscriptFindSourceRange } from './find/transcriptFindRowStore';


interface CommandViewProps {
    command: string;
    prompt?: string;
    stdout?: string | null;
    stderr?: string | null;
    error?: string | null;
    // Legacy prop for backward compatibility
    output?: string | null;
    maxHeight?: number;
    fullWidth?: boolean;
    hideEmptyOutput?: boolean;
    commandFindRanges?: readonly TranscriptFindSourceRange[];
    stdoutFindRanges?: readonly TranscriptFindSourceRange[];
    stderrFindRanges?: readonly TranscriptFindSourceRange[];
    errorFindRanges?: readonly TranscriptFindSourceRange[];
}

/** Web keeps an unbroken token inside the line box; native Text already breaks it by character. */
const LONG_TOKEN_WRAP = Platform.OS === 'web' ? { wordBreak: 'break-word' as const } : {};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        // Tool cards already provide a container; keep this view visually lightweight so it
        // matches other tool outputs in light mode.
        backgroundColor: 'transparent',
        borderRadius: 0,
        overflow: 'visible',
        padding: 0,
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
    },
    line: {
        alignItems: 'baseline',
        flexDirection: 'row',
        flexWrap: 'wrap',
        // The line spans its container so a long command wraps inside it instead of running off a phone's edge.
        alignSelf: 'stretch',
        minWidth: 0,
    },
    promptText: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.state.success.textForeground ?? theme.colors.text.primary,
        fontWeight: '600',
    },
    commandText: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 14,
        color: theme.colors.text.primary,
        lineHeight: 20,
        flex: 1,
        minWidth: 0,
        // An unbroken token (JSON, a URL, a long path) breaks where it must rather than overflowing.
        ...LONG_TOKEN_WRAP,
    },
    stdout: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 13,
        color: theme.colors.text.primary,
        lineHeight: 18,
        marginTop: theme.space.s8,
        ...LONG_TOKEN_WRAP,
    },
    stderr: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 13,
        color: theme.colors.state.neutral.textForeground ?? theme.colors.text.secondary,
        lineHeight: 18,
        marginTop: theme.space.s8,
        ...LONG_TOKEN_WRAP,
    },
    error: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 13,
        color: theme.colors.state.danger.textForeground ?? theme.colors.state.danger.textForeground ?? theme.colors.text.primary,
        lineHeight: 18,
        marginTop: theme.space.s8,
        ...LONG_TOKEN_WRAP,
    },
    emptyOutput: {
        fontFamily: resolveCodeMonoFontFamily(),
        fontSize: 13,
        color: theme.colors.text.secondary,
        lineHeight: 18,
        marginTop: theme.space.s8,
        fontStyle: 'italic',
    },
}));

export const CommandView = React.memo<CommandViewProps>(({
    command,
    prompt = '$',
    stdout,
    stderr,
    error,
    output,
    maxHeight,
    fullWidth,
    hideEmptyOutput,
    commandFindRanges,
    stdoutFindRanges,
    stderrFindRanges,
    errorFindRanges,
}) => {
    // Use legacy output if new props aren't provided
    const hasNewProps = stdout !== undefined || stderr !== undefined || error !== undefined;

    const styles = stylesheet;

    return (
        <View style={[
            styles.container, 
            maxHeight ? { maxHeight } : undefined,
            fullWidth ? { width: '100%' } : undefined
        ]}>
            {/* Command Line */}
            <View style={styles.line}>
                <Text selectable style={styles.promptText}>{prompt} </Text>
                <Text selectable style={styles.commandText}><FindHighlightedText text={command} ranges={commandFindRanges} /></Text>
            </View>

            {hasNewProps ? (
                <>
                    {/* Standard Output */}
                    {stdout && stdout.trim() && (
                        <Text selectable style={styles.stdout}><FindHighlightedText text={stdout} ranges={stdoutFindRanges} /></Text>
                    )}

                    {/* Standard Error */}
                    {stderr && stderr.trim() && (
                        <Text selectable style={styles.stderr}><FindHighlightedText text={stderr} ranges={stderrFindRanges} /></Text>
                    )}

                    {/* Error Message */}
                    {error && (
                        <Text selectable style={styles.error}><FindHighlightedText text={error} ranges={errorFindRanges} /></Text>
                    )}

                    {/* Empty output indicator */}
                    {!stdout && !stderr && !error && !hideEmptyOutput && (
                        <Text selectable style={styles.emptyOutput}>{t('commandView.completedWithNoOutput')}</Text>
                    )}
                </>
            ) : (
                /* Legacy output format */
                output && (
                    <Text selectable style={styles.commandText}>{'\n---\n' + output}</Text>
                )
            )}
        </View>
    );
});
