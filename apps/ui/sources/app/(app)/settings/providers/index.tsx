import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PROVIDER_SETTINGS_PLUGINS } from '@/agents/providers/_registry/providerSettingsRegistry';
import { t } from '@/text';

export default React.memo(function ProviderSettingsIndexScreen() {
    const router = useRouter();

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsProviders.title')}
                footer={t('settingsProviders.footer')}
            >
                {PROVIDER_SETTINGS_PLUGINS.map((plugin) => (
                    <Item
                        key={plugin.providerId}
                        title={plugin.title}
                        subtitle={t('settingsProviders.providerSubtitle')}
                        icon={<Ionicons name={plugin.icon.ionName as any} size={29} color={plugin.icon.color} />}
                        onPress={() => router.push(`/(app)/settings/providers/${plugin.providerId}` as any)}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});
