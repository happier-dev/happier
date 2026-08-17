import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentPickerIconScale } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
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

interface SessionMentionAgentLogoProps {
    agentId: AgentId;
    testID?: string;
}

/**
 * The leading glyph of a session mention row: the logo of the provider running in
 * that session.
 *
 * This is an icon for `CommandMenuRow`, not a competing row — the exception below
 * still stands. It is a component rather than a bare `<AgentIcon>` element because
 * the optical size correction must be read at RENDER time: candidate resolution
 * runs on every keystroke, and in Node-side tests the registry's image assets
 * cannot be loaded at all, which turned the whole session kind into a failed kind
 * and emptied the section.
 */
export const SessionMentionAgentLogo = React.memo(({ agentId, testID }: SessionMentionAgentLogoProps) => (
    <AgentIcon
        agentId={agentId}
        size={16}
        style={{ transform: [{ scale: getAgentPickerIconScale(agentId) }] }}
        testID={testID}
    />
));

/*
 * Vendor-plugin, skill and slash-command rows used to live here as three more
 * bespoke components drawing the same icon + title + subtitle shape
 * `CommandMenuRow` already draws (SB-6 / D-17). They are gone: the registry
 * supplies the icon, label and subtitle, and the primitive renders them.
 * `renderRow` survives only for the file row, which needs
 * `InlineRepoPathLabel`'s path-aware truncation.
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
