import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { WidgetSizePicker } from '@happier-dev/plugin-ui/presentation';
import { getWidgetSizeFootprintV1, stepWidgetSizeV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type WidgetSizeControl = Readonly<{
    surface: WidgetSurfaceRefV1['owner']['kind'];
    sizes: readonly WidgetSizeV1[];
    size?: WidgetSizeV1;
    onSet: (size: WidgetSizeV1) => void;
    disabled?: boolean;
}>;

/** Core supplies labels and theme; app and plugins render the same presentation primitive. */
export function WidgetSizeControl(props: WidgetSizeControl & Readonly<{ testID: string; showLabel?: boolean }>) {
    const { theme } = useUnistyles();
    if (props.sizes.length === 0) return null;
    return <View style={{ gap: 6 }}>
        {props.showLabel ? <Text>{t('widgetAdd.size')}</Text> : null}
        <WidgetSizePicker testID={props.testID} accessibilityLabel={t('widgetAdd.size')} value={props.size}
            disabled={props.disabled}
            choices={props.sizes.flatMap(size => {
                const footprint = getWidgetSizeFootprintV1(props.surface, size);
                return footprint ? [{ key: size, label: t(`widgetAdd.sizes.${size}`), footprint }] : [];
            })}
            colors={{ track: theme.colors.segmentedControl.trackBackground, thumb: theme.colors.segmentedControl.activeBackground,
                label: theme.colors.text.secondary, activeLabel: theme.colors.text.primary, focusRing: theme.colors.border.focus }}
            onChange={key => {
                const size = props.sizes.find(size => size === key);
                if (size) props.onSet(size);
            }} />
    </View>;
}

/** Keyboard and pointer selection share the Protocol order and the same caller mutation. */
export function stepWidgetSizeControl(control: WidgetSizeControl | undefined, key: string): boolean {
    if (!control || control.disabled || (key !== '[' && key !== ']')) return false;
    const next = stepWidgetSizeV1(control.sizes, control.size, key === '[' ? -1 : 1);
    if (next && next !== control.size) control.onSet(next);
    return true;
}

/** Only an open overflow mounts the picker; no descriptor reads or details are mounted while shut. */
export function renderWidgetSizeMenuSection(control: WidgetSizeControl | undefined, id: string, testID: string): React.ReactNode | undefined {
    return control && id === 'size' ? <View style={{ padding: 12 }}><WidgetSizeControl {...control} showLabel testID={testID} /></View> : undefined;
}
