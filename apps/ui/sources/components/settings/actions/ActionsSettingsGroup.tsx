import * as React from 'react';
import { View } from 'react-native';

import { listActionSpecs, type ActionsSettingsV1 } from '@happier-dev/protocol';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';

function toggleDisabled(settings: ActionsSettingsV1, actionId: string): ActionsSettingsV1 {
    const id = String(actionId ?? '').trim();
    if (!id) return settings;
    const current = Array.isArray(settings.disabledActionIds) ? settings.disabledActionIds : [];
    const set = new Set(current);
    if (set.has(id as any)) {
        set.delete(id as any);
    } else {
        set.add(id as any);
    }
    return { v: 1, disabledActionIds: Array.from(set) };
}

export function ActionsSettingsGroup(props: Readonly<{
    settings: ActionsSettingsV1;
    setSettings: (next: ActionsSettingsV1) => void;
}>) {
    const specs = React.useMemo(() => {
        return listActionSpecs()
            .slice()
            .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }, []);

    const disabledSet = React.useMemo(() => new Set(props.settings.disabledActionIds ?? []), [props.settings.disabledActionIds]);

    return (
        <ItemGroup
            title="Actions"
            footer="Disable actions to remove them from UI, voice, and MCP surfaces. Disabled actions are fail-closed at runtime."
        >
            <View style={{ gap: 2 }}>
                {specs.map((spec) => {
                    const disabled = disabledSet.has(spec.id);
                    return (
                        <Item
                            key={spec.id}
                            title={spec.title}
                            subtitle={spec.id}
                            onPress={() => props.setSettings(toggleDisabled(props.settings, spec.id))}
                            showChevron={false}
                            rightElement={disabled ? 'Disabled' : 'Enabled'}
                        />
                    );
                })}
            </View>
        </ItemGroup>
    );
}

