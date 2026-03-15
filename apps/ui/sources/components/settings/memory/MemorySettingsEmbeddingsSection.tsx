import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { t } from '@/text';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

export const MemorySettingsEmbeddingsSection = React.memo(function MemorySettingsEmbeddingsSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const { settings } = props;

    if (settings.indexMode !== 'deep') return null;

    return (
        <ItemGroup
            title={t('memorySearchSettings.embeddings.groupTitle')}
            footer={t('memorySearchSettings.embeddings.groupFooter')}
        >
            <Item
                testID="memory-settings-embeddings-enabled-item"
                title={t('memorySearchSettings.embeddings.enableTitle')}
                subtitle={t('memorySearchSettings.embeddings.enableSubtitle')}
                icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.success} />}
                rightElement={(
                    <Switch
                        testID="memory-settings-embeddings-enabled"
                        value={settings.embeddings.enabled}
                        onValueChange={(value) => {
                            void props.writeSettings({
                                ...settings,
                                embeddings: { ...settings.embeddings, enabled: Boolean(value) },
                            });
                        }}
                    />
                )}
                showChevron={false}
            />
            <Item
                title={t('memorySearchSettings.embeddings.modelTitle')}
                subtitle={settings.embeddings.modelId}
                icon={<Ionicons name="cube-outline" size={29} color={theme.colors.accent.purple} />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        t('memorySearchSettings.embeddings.modelTitle'),
                        t('memorySearchSettings.embeddings.promptBody'),
                        {
                            defaultValue: settings.embeddings.modelId,
                            placeholder: t('memorySearchSettings.embeddings.modelPlaceholder'),
                            confirmText: t('common.save'),
                            cancelText: t('common.cancel'),
                        },
                    );
                    if (typeof next === 'string' && next.trim()) {
                        void props.writeSettings({
                            ...settings,
                            embeddings: { ...settings.embeddings, modelId: next.trim() },
                        });
                    }
                }}
                showChevron={false}
            />
        </ItemGroup>
    );
});
