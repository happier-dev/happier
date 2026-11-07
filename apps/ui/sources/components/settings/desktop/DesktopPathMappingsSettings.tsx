import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import type { DesktopPathMapping } from '@/sync/domains/files/localFilePath';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Direct destination for file actions that need a shared-folder mapping. */
export function DesktopPathMappingsSettingsView() {
    return <ItemList><DesktopPathMappingsSettings /></ItemList>;
}

/**
 * Shared folders that let "Open in…" and "Open file location" reach files of sessions running on
 * other machines: the folder as that machine sees it, and the same folder as this computer reaches it.
 */
export const DesktopPathMappingsSettings = React.memo(function DesktopPathMappingsSettings() {
    const { theme } = useUnistyles();
    const [mappings, setMappings] = useLocalSettingMutable('desktopPathMappingsV1');

    const addMapping = React.useCallback(async () => {
        const remotePath = (await Modal.prompt(
            t('settingsDesktop.pathMappingsRemotePrompt'),
            t('settingsDesktop.pathMappingsRemotePromptMessage'),
            { placeholder: '/srv/projects' },
        ))?.trim();
        if (!remotePath) return;
        const localPath = (await Modal.prompt(
            t('settingsDesktop.pathMappingsLocalPrompt'),
            t('settingsDesktop.pathMappingsLocalPromptMessage', { remotePath }),
            { placeholder: '\\\\server\\projects' },
        ))?.trim();
        if (!localPath) return;
        setMappings([
            ...mappings.filter((mapping) => mapping.remotePath !== remotePath),
            { remotePath, localPath },
        ]);
    }, [mappings, setMappings]);

    const removeMapping = React.useCallback(async (target: DesktopPathMapping) => {
        const confirmed = await Modal.confirm(
            t('settingsDesktop.pathMappingsRemoveTitle'),
            t('settingsDesktop.pathMappingsRemoveMessage', target),
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;
        setMappings(mappings.filter((mapping) => mapping.remotePath !== target.remotePath));
    }, [mappings, setMappings]);

    return (
        <ItemGroup
            title={t('settingsDesktop.pathMappingsTitle')}
            footer={t('settingsDesktop.pathMappingsFooter')}
        >
            {mappings.map((mapping) => (
                <Item
                    key={mapping.remotePath}
                    testID="settings-desktop-path-mapping"
                    title={mapping.remotePath}
                    subtitle={mapping.localPath}
                    icon={<Icon name="folder-open" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => { void removeMapping(mapping); }}
                    showChevron={false}
                />
            ))}
            <Item
                testID="settings-desktop-path-mapping-add"
                title={t('settingsDesktop.pathMappingsAdd')}
                icon={<Icon name="plus" size={29} color={theme.colors.accent.green} />}
                onPress={() => { void addMapping(); }}
                showChevron={false}
            />
        </ItemGroup>
    );
});
