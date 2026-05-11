import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import { Text } from '@/components/ui/text/Text';


export function ToolError(props: { message: string }) {
    const { theme } = useUnistyles();
    const { isToolUseError, errorMessage } = parseToolUseError(props.message);
    const displayMessage = isToolUseError && errorMessage ? errorMessage : props.message;
    
    return (
        <View style={[styles.errorContainer, isToolUseError && styles.toolUseErrorContainer]}>
            {isToolUseError && (
                <Ionicons name="warning" size={16} color={theme.colors.state.warning.foreground} />
            )}
            <Text style={[styles.errorText, isToolUseError && styles.toolUseErrorText]}>
                {displayMessage}
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