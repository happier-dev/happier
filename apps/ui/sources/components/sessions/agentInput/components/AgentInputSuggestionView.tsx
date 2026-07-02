import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { COMMAND_SUGGESTION_ROW_HEIGHT } from '@/components/autocomplete/commandSuggestionConstants';


interface CommandSuggestionProps {
    command: string;
    description?: string;
}

const COMMAND_PREFIX = '/';
export { COMMAND_SUGGESTION_ROW_HEIGHT };

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

interface VendorPluginMentionSuggestionProps {
    name: string;
    displayName: string;
    description?: string;
    source?: string;
}

export const VendorPluginMentionSuggestion = React.memo((props: VendorPluginMentionSuggestionProps) => {
    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.leadingIcon}>
                <Ionicons name="extension-puzzle-outline" size={16} color={styles.iconColor.color} />
            </View>
            <View style={styles.labelColumn}>
                <Text style={styles.fileTitleText} numberOfLines={1}>
                    {props.displayName}
                </Text>
                <Text style={styles.filePathText} numberOfLines={1}>
                    {props.source ?? props.name}
                </Text>
            </View>
        </View>
    );
});

interface SkillMentionSuggestionProps {
    name: string;
    displayName: string;
    description?: string;
    source?: string;
}

export const SkillMentionSuggestion = React.memo((props: SkillMentionSuggestionProps) => {
    return (
        <View style={styles.suggestionContainer}>
            <View style={styles.leadingIcon}>
                <Ionicons name="sparkles-outline" size={16} color={styles.iconColor.color} />
            </View>
            <View style={styles.labelColumn}>
                <Text style={styles.fileTitleText} numberOfLines={1}>
                    {props.displayName}
                </Text>
                <Text style={styles.filePathText} numberOfLines={1}>
                    {props.description ?? props.source ?? props.name}
                </Text>
            </View>
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
    labelColumn: {
        flex: 1,
        minWidth: 0,
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
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));
