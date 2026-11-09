import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

import type { MemoryContentPolicyV1, MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { MEMORY_SETTINGS } from '@/components/settings/memory/memorySettings';
import {
    readMemoryContentPolicy,
    withMemoryContentPolicy,
} from './memorySettingsPolicies';

type MemoryContentPolicyKey = keyof MemoryContentPolicyV1;

const CONTENT_ROWS = [
    { key: 'includeUserMessages', testID: 'memory-settings-content-user-messages', setting: MEMORY_SETTINGS.settings.userMessages },
    { key: 'includeAssistantMessages', testID: 'memory-settings-content-assistant-messages', setting: MEMORY_SETTINGS.settings.assistantMessages },
    { key: 'includeReasoning', testID: 'memory-settings-content-reasoning', setting: MEMORY_SETTINGS.settings.reasoning },
    { key: 'includeToolSummaries', testID: 'memory-settings-content-tool-summaries', setting: MEMORY_SETTINGS.settings.toolSummaries },
] as const satisfies ReadonlyArray<Readonly<{ key: MemoryContentPolicyKey; testID: string; setting: SettingRef }>>;

export const MemorySettingsContentPolicySection = React.memo(function MemorySettingsContentPolicySection(props: Readonly<{
    settings: MemorySettingsV1;
    writeSettings: (next: MemorySettingsV1) => void | Promise<void>;
}>) {
    const contentPolicy = readMemoryContentPolicy(props.settings);

    return (
        <ItemGroup
            title={t('memorySearchSettings.contentPolicy.title')}
            description={t('memorySearchSettings.contentPolicy.footer')}
        >
            {CONTENT_ROWS.map((row) => (
                <SettingRow
                    key={row.key}
                    testID={`${row.testID}-item`}
                    setting={row.setting}
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
