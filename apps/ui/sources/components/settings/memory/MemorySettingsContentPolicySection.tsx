import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t, type TranslationKeyNoParams } from '@/text';

import type { MemoryContentPolicyV1, MemorySettingsV1 } from '@happier-dev/protocol';
import {
    readMemoryContentPolicy,
    withMemoryContentPolicy,
} from './memorySettingsPolicies';

type MemoryContentPolicyKey = keyof MemoryContentPolicyV1;

const CONTENT_ROWS = [
    {
        key: 'includeUserMessages',
        testID: 'memory-settings-content-user-messages',
        titleKey: 'memorySearchSettings.contentPolicy.userMessagesTitle',
        subtitleKey: 'memorySearchSettings.contentPolicy.userMessagesSubtitle',
        iconName: 'person-outline',
    },
    {
        key: 'includeAssistantMessages',
        testID: 'memory-settings-content-assistant-messages',
        titleKey: 'memorySearchSettings.contentPolicy.assistantMessagesTitle',
        subtitleKey: 'memorySearchSettings.contentPolicy.assistantMessagesSubtitle',
        iconName: 'chatbubble-ellipses-outline',
    },
    {
        key: 'includeReasoning',
        testID: 'memory-settings-content-reasoning',
        titleKey: 'memorySearchSettings.contentPolicy.reasoningTitle',
        subtitleKey: 'memorySearchSettings.contentPolicy.reasoningSubtitle',
        iconName: 'bulb-outline',
    },
    {
        key: 'includeToolSummaries',
        testID: 'memory-settings-content-tool-summaries',
        titleKey: 'memorySearchSettings.contentPolicy.toolSummariesTitle',
        subtitleKey: 'memorySearchSettings.contentPolicy.toolSummariesSubtitle',
        iconName: 'construct-outline',
    },
] as const satisfies ReadonlyArray<Readonly<{
    key: MemoryContentPolicyKey;
    testID: string;
    titleKey: TranslationKeyNoParams;
    subtitleKey: TranslationKeyNoParams;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
}>>;

export const MemorySettingsContentPolicySection = React.memo(function MemorySettingsContentPolicySection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const { theme } = useUnistyles();
    const contentPolicy = readMemoryContentPolicy(props.settings);

    return (
        <ItemGroup
            title={t('memorySearchSettings.contentPolicy.title')}
            footer={t('memorySearchSettings.contentPolicy.footer')}
        >
            {CONTENT_ROWS.map((row) => (
                <Item
                    key={row.key}
                    testID={`${row.testID}-item`}
                    title={t(row.titleKey)}
                    subtitle={t(row.subtitleKey)}
                    icon={<Ionicons name={row.iconName} size={29} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Switch
                            testID={row.testID}
                            value={contentPolicy[row.key]}
                            onValueChange={(value) => {
                                void props.writeSettings(withMemoryContentPolicy(props.settings, {
                                    ...contentPolicy,
                                    [row.key]: Boolean(value),
                                }));
                            }}
                        />
                    )}
                    showChevron={false}
                />
            ))}
        </ItemGroup>
    );
});
