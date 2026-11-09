import * as React from 'react';
import { HappierRadioMark } from '@happier-dev/plugin-ui/presentation';
import { hasManagedMachinePresetCreationV1, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

/** A Preset can start this provider's Machine when its creation part names that provider and it is still usable. */
export function managedStartFromPresets(presets: readonly ManagedMachinePresetV1[], provisioner: string): readonly ManagedMachinePresetV1[] {
    return presets.filter(preset => hasManagedMachinePresetCreationV1(preset) && preset.archivedAt === undefined
        && preset.delegatedAcquire?.kind !== 'unavailable'
        && buildQualifiedPluginContributionKey(preset.launch.provider) === provisioner);
}

const HAND = 'hand';

/** "Start from" at the head of the configurator (lab `add/create`): exactly one Preset, or the choices by hand. */
export function ManagedStartFromSection(props: Readonly<{
    presets: readonly ManagedMachinePresetV1[];
    selectedId: string | null;
    disabled: boolean;
    onChange: (presetId: string | null) => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const markTheme = usePluginUiTheme(theme);
    const title = t('managedMachines.config.startFrom');
    const row = (id: string, rowTitle: string, subtitle: string | undefined, presetId: string | null) => {
        const selected = props.selectedId === presetId;
        return <Item key={id} testID={`${props.testID}:${id}`} title={rowTitle} subtitle={subtitle} subtitleLines={0} selected={selected}
            accessibilityRole="radio" webRole="radio" accessibilityChecked={selected} disabled={props.disabled} showChevron={false}
            icon={<HappierRadioMark selected={selected} disabled={props.disabled} theme={markTheme} />}
            onPress={selected ? undefined : () => props.onChange(presetId)} />;
    };
    return <ItemGroup testID={props.testID} title={title} description={t('managedMachines.config.startFromDescription')}
        accessibilityRole="radiogroup" accessibilityLabel={title}>
        {props.presets.map(preset => {
            const items = preset.setup?.items?.length ?? 0;
            return row(preset.id, preset.name,
                items ? t('managedMachines.config.startFromSetsUp', { items: t('machinePresets.setup.itemCount', { count: items }) }) : undefined,
                preset.id);
        })}
        {row(HAND, t('managedMachines.config.chooseByHand'), t('managedMachines.config.chooseByHandSubtitle'), null)}
    </ItemGroup>;
}
