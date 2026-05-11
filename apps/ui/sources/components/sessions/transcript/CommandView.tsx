import * as React from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';


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
}

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
    },
    promptText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.state.success.foreground ?? theme.colors.text.primary,
        fontWeight: '600',
    },
    commandText: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 14,
        color: theme.colors.text.primary,
        lineHeight: 20,
        flex: 1,
    },
    stdout: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: theme.colors.text.primary,
        lineHeight: 18,
        marginTop: 8,
    },
    stderr: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: theme.colors.state.neutral.foreground ?? theme.colors.text.secondary,
        lineHeight: 18,
        marginTop: 8,
    },
    error: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: theme.colors.state.danger.foreground ?? theme.colors.state.danger.foreground ?? theme.colors.text.primary,
        lineHeight: 18,
        marginTop: 8,
    },
    emptyOutput: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        fontSize: 13,
        color: theme.colors.text.secondary,
        lineHeight: 18,
        marginTop: 8,
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
                <Text selectable style={styles.commandText}>{command}</Text>
            </View>

            {hasNewProps ? (
                <>
                    {/* Standard Output */}
                    {stdout && stdout.trim() && (
                        <Text selectable style={styles.stdout}>{stdout}</Text>
                    )}

                    {/* Standard Error */}
                    {stderr && stderr.trim() && (
                        <Text selectable style={styles.stderr}>{stderr}</Text>
                    )}

                    {/* Error Message */}
                    {error && (
                        <Text selectable style={styles.error}>{error}</Text>
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
