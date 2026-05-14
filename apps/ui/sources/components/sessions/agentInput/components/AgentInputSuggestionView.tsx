import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';


interface CommandSuggestionProps {
    command: string;
    description?: string;
}

const COMMAND_PREFIX = '/';
export const COMMAND_SUGGESTION_ROW_HEIGHT = 52;

export const CommandSuggestion = React.memo(({ command, description }: CommandSuggestionProps) => {
    return (
        <View testID="agent-input-command-suggestion" style={styles.commandSuggestionContainer}>
            <Text 
                style={styles.commandText}
                numberOfLines={1}
            >
                {COMMAND_PREFIX}{command}
            </Text>
            {description && (
                <Text
                    style={styles.commandSubtitleText}
                    numberOfLines={1}
                >
                    {description}
                </Text>
            )}
        </View>
    );
});

interface FileMentionProps {
    fileName: string;
    filePath: string;
    fileType?: 'file' | 'folder';
}

export const FileMentionSuggestion = React.memo(({ fileName, filePath, fileType = 'file' }: FileMentionProps) => {
    const { name } = React.useMemo(() => {
        return normalizeRepoPathParts({ fileName, filePath });
    }, [fileName, filePath]);

    const icon = fileType === 'folder'
        ? <Ionicons name="folder-outline" size={16} color={styles.iconColor.color} />
        : <FileIcon fileName={name || fileName} size={16} />;

    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.leadingIcon}>{icon}</View>
            <InlineRepoPathLabel
                fileName={fileName}
                filePath={filePath}
                nameSuffix={fileType === 'folder' ? '/' : undefined}
                pathTextStyle={styles.filePathText}
                nameTextStyle={styles.fileTitleText}
            />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    commandSuggestionContainer: {
        flex: 1,
        flexDirection: 'column',
        alignItems: 'stretch',
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 8,
    },
    suggestionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    commandText: {
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text.primary,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    commandSubtitleText: {
        marginTop: 2,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    leadingIcon: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 8,
    },
    iconColor: {
        color: theme.colors.text.secondary,
    },
    fileTitleText: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    filePathText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));
