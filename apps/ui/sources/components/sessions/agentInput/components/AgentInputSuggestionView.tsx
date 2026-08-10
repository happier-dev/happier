import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { normalizeRepoPathParts } from '@/utils/path/normalizeRepoPathParts';
import { Icon } from '@/components/ui/icons/Icon';


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
        ? <Icon name="folder" size={16} color={styles.iconColor.color} />
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

/*
 * Vendor-plugin and skill rows used to live here as two more bespoke components
 * drawing the same icon + title + subtitle shape `CommandMenuRow` already draws
 * (SB-6 / D-17). They are gone: the registry supplies the icon, label and
 * subtitle, and the primitive renders them. `renderRow` survives only for the
 * file row, which needs `InlineRepoPathLabel`'s path-aware truncation.
 */

const styles = StyleSheet.create((theme) => ({
    suggestionContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
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
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));
