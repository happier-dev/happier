import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

import type {
    ActionSettingsToolExposureControlValue,
    ActionSettingsToolExposureState,
} from './actionSettingsToolExposure';

const stylesheet = StyleSheet.create(() => ({
    optionIcon: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    resolvedMarker: {
        width: 0,
        height: 0,
        overflow: 'hidden',
    },
}));

function getDefaultExposureTitleKey(defaultMode: 'direct' | 'discoverable_only') {
    return defaultMode === 'direct'
        ? 'settingsActions.toolExposure.options.defaultDirect.title'
        : 'settingsActions.toolExposure.options.defaultDiscoverableOnly.title';
}

function buildExposureItems(params: Readonly<{
    defaultMode: 'direct' | 'discoverable_only';
    testIDPrefix: string;
    iconColor: string;
}>): readonly DropdownMenuItem[] {
    const styles = stylesheet;
    const icon = (name: React.ComponentProps<typeof Ionicons>['name']) => (
        <View style={styles.optionIcon}>
            <Ionicons name={name} size={21} color={params.iconColor} />
        </View>
    );

    return [
        {
            id: 'default',
            testID: `${params.testIDPrefix}:default`,
            title: t(getDefaultExposureTitleKey(params.defaultMode)),
            subtitle: t('settingsActions.toolExposure.options.default.subtitle'),
            icon: icon('refresh-outline'),
        },
        {
            id: 'discoverable_only',
            testID: `${params.testIDPrefix}:discoverable_only`,
            title: t('settingsActions.toolExposure.options.discoverableOnly.title'),
            subtitle: t('settingsActions.toolExposure.options.discoverableOnly.subtitle'),
            icon: icon('search-outline'),
        },
        {
            id: 'direct',
            testID: `${params.testIDPrefix}:direct`,
            title: t('settingsActions.toolExposure.options.direct.title'),
            subtitle: t('settingsActions.toolExposure.options.direct.subtitle'),
            icon: icon('flash-outline'),
        },
    ] satisfies readonly DropdownMenuItem[];
}

export type ActionSettingsToolExposureControlProps = Readonly<{
    state: Extract<ActionSettingsToolExposureState, { kind: 'visible' }>;
    disabled?: boolean;
    surfaceTitle: string;
    testIDPrefix: string;
    onChange: (value: ActionSettingsToolExposureControlValue) => void;
}>;

export const ActionSettingsToolExposureControl = React.memo(function ActionSettingsToolExposureControl(
    props: ActionSettingsToolExposureControlProps,
) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const disabled = props.disabled === true || props.state.disabled;
    const items = React.useMemo(() => buildExposureItems({
        defaultMode: props.state.defaultMode,
        testIDPrefix: props.testIDPrefix,
        iconColor: theme.colors.text.secondary,
    }), [props.state.defaultMode, props.testIDPrefix, theme.colors.text.secondary]);

    return (
        <>
            <View
                testID={`${props.testIDPrefix}:resolved:${props.state.resolvedMode}`}
                style={styles.resolvedMarker}
            />
            <DropdownMenu
                open={open}
                onOpenChange={(next) => {
                    if (!disabled) {
                        setOpen(next);
                    }
                }}
                variant="selectable"
                search={false}
                selectedId={props.state.value}
                showCategoryTitles={false}
                matchTriggerWidth
                connectToTrigger
                rowKind="item"
                items={items}
                onSelect={(itemId) => props.onChange(itemId as ActionSettingsToolExposureControlValue)}
                itemTrigger={{
                    title: props.surfaceTitle,
                    icon: <Ionicons name="construct-outline" size={29} color={theme.colors.text.secondary} />,
                    subtitle: disabled
                        ? t('settingsActions.toolExposure.disabledSubtitle')
                        : t('settingsActions.toolExposure.subtitle'),
                    itemProps: {
                        testID: props.testIDPrefix,
                        disabled,
                    },
                }}
            />
        </>
    );
});
