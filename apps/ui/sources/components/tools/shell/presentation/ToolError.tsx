import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as React from 'react';
import { resolveToolErrorDisplay } from './resolveToolInlineErrorDisplay';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { useTranscriptFindRow } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';


export function ToolError(props: { message: string; messageId?: string; blockId?: string }) {
    const { theme } = useUnistyles();
    const { isToolUseError, text: displayMessage } = resolveToolErrorDisplay(props.message);
    const find = useTranscriptFindRow(props.messageId);
    const ranges = find?.blocks.find((block) => block.id === props.blockId)?.sourceRanges;
    const reveal = find?.reveal;
    const revealId = reveal && reveal.blockId === props.blockId ? reveal.requestId : undefined;
    const [expanded, setExpanded] = React.useState(false);
    const mutateLayout = useTranscriptRowLayoutMutation();
    React.useEffect(() => {
        if (revealId === undefined) return;
        mutateLayout({ reason: 'expand', sourceId: `tool-error:${props.messageId}:${props.blockId}` });
        setExpanded(true);
    }, [mutateLayout, props.blockId, props.messageId, revealId]);
    
    return (
        <View testID="tool-error-body" style={[styles.errorContainer, isToolUseError && styles.toolUseErrorContainer, expanded && { maxHeight: undefined, overflow: 'visible' }]}>
            {isToolUseError && (
                <Icon name="warning" size={16} color={theme.colors.state.warning.foreground} />
            )}
            <Text style={[styles.errorText, isToolUseError && styles.toolUseErrorText]}>
                {ranges?.length ? <FindHighlightedText text={displayMessage} ranges={ranges} /> : displayMessage}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create((theme) => ({
    errorContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        backgroundColor: theme.colors.state.danger.background,
        borderRadius: 6,
        padding: 12,
        borderWidth: 1,
        borderColor: theme.colors.state.danger.border,
        marginBottom: 12,
        maxHeight: 115,
        overflow: 'hidden',
    },
    toolUseErrorContainer: {
        backgroundColor: theme.colors.state.danger.background,
        borderColor: theme.colors.state.danger.border,
    },
    errorText: {
        fontSize: 13,
        color: theme.colors.state.danger.foreground,
        flex: 1,
    },
    toolUseErrorText: {
        color: theme.colors.state.danger.foreground,
    },
}));
