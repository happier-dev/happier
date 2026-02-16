import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';

import type { MemorySettingsV1 } from '@happier-dev/protocol';

export const MemorySettingsEmbeddingsSection = React.memo(function MemorySettingsEmbeddingsSection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { settings } = props;

    if (settings.indexMode !== 'deep') return null;

    return (
        <ItemGroup
            title="Embeddings"
            footer="Optional: download a local model to improve semantic matches when using Deep mode."
        >
            <Item
                testID="memory-settings-embeddings-enabled-item"
                title="Enable embeddings"
                subtitle="Improves ranking for deep search (downloads a model on first use)"
                icon={<Ionicons name="sparkles-outline" size={29} color="#34C759" />}
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
                title="Embeddings model"
                subtitle={settings.embeddings.modelId}
                icon={<Ionicons name="cube-outline" size={29} color="#AF52DE" />}
                onPress={async () => {
                    const next = await Modal.prompt(
                        'Embeddings model',
                        'Enter a local transformers model id.',
                        {
                            defaultValue: settings.embeddings.modelId,
                            placeholder: 'Xenova/all-MiniLM-L6-v2',
                            confirmText: 'Save',
                            cancelText: 'Cancel',
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

