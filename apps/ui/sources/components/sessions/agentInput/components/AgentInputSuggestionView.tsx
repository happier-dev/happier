import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';


interface CommandSuggestionProps {
    command: string;
    description?: string;
}

const COMMAND_PREFIX = '/';

export const CommandSuggestion = React.memo(({ command, description }: CommandSuggestionProps) => {
    return (
        <View style={styles.suggestionContainer}>
            <Text 
                style={[styles.commandText, { marginRight: description ? 12 : 0 }]}
            >
                {COMMAND_PREFIX}{command}
            </Text>
            {description && (
                <Text
                    style={styles.descriptionText}
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
    const { dir, name } = React.useMemo(() => {
        return normalizeRepoPathParts({ fileName, filePath });
    }, [fileName, filePath]);
    const dirLabel = dir ? `${dir}/` : null;

    const icon = fileType === 'folder'
        ? <Ionicons name="folder-outline" size={16} color={styles.iconColor.color} />
        : <FileIcon fileName={name || fileName} size={16} />;

    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.leadingIcon}>{icon}</View>
            <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline' }}>
                {dirLabel ? (
                    <Text style={styles.filePathText} numberOfLines={1} ellipsizeMode="clip">
                        {dirLabel}
                    </Text>
                ) : (
                    <View style={{ flex: 1, minWidth: 0 }} />
                )}
                <Text style={styles.fileTitleText} numberOfLines={1} ellipsizeMode="middle">
                    {fileType === 'folder' ? `${name}/` : name}
                </Text>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    suggestionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    commandText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    descriptionText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
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
        color: theme.colors.textSecondary,
    },
    fileTitleText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    filePathText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));
