import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { WidgetSizePicker, happierPageTextMetrics, type WidgetSizePickerCompactInput } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { getWidgetSizeFootprintV1, stepWidgetSizeV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type WidgetSizeControl = Readonly<{
    surface: WidgetSurfaceRefV1['owner']['kind'];
    sizes: readonly WidgetSizeV1[];
    size?: WidgetSizeV1;
    onSet: (size: WidgetSizeV1) => void;
    disabled?: boolean;
    /** Sizes shown but not choosable here, and why (a widget inside a half-width group). */
    unavailable?: Readonly<{ sizes: readonly WidgetSizeV1[]; reason: string }>;
}>;

/** Core supplies labels, theme and its field menu; app and plugins render the same presentation primitive. */
export function WidgetSizeControl(props: WidgetSizeControl & Readonly<{ testID: string; showLabel?: boolean }>) {
    const { theme } = useUnistyles();
    const testID = props.testID;
    const renderCompact = React.useCallback((input: WidgetSizePickerCompactInput) => (
        <WidgetSizeMenu input={input} testID={`${testID}.compact`} />
    ), [testID]);
    if (props.sizes.length === 0) return null;
    return <View style={{ gap: 6 }}>
        {props.showLabel ? <Text>{t('widgetAdd.size')}</Text> : null}
        <WidgetSizePicker testID={props.testID} accessibilityLabel={t('widgetAdd.size')} value={props.size}
            disabled={props.disabled}
            renderCompact={renderCompact}
            choices={props.sizes.flatMap(size => {
                const footprint = getWidgetSizeFootprintV1(props.surface, size);
                return footprint ? [{ key: size, label: t(`widgetAdd.sizes.${size}`), footprint,
                    ...(props.unavailable?.sizes.includes(size) ? { unavailable: true } : {}) }] : [];
            })}
            colors={{ track: theme.colors.segmentedControl.trackBackground, thumb: theme.colors.segmentedControl.activeBackground,
                label: theme.colors.text.secondary, activeLabel: theme.colors.text.primary, focusRing: theme.colors.border.focus }}
            onChange={key => {
                const size = props.sizes.find(size => size === key);
                if (size && !props.unavailable?.sizes.includes(size)) props.onSet(size);
            }} />
        {props.unavailable?.sizes.length ? (
            <Text testID={`${testID}.unavailable`} style={{ ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary }}>{props.unavailable.reason}</Text>
        ) : null}
    </View>;
}

/**
 * The size choice when its segments do not fit the room (a phone's sheet): the app's one field
 * select, "Size · Medium", opening the same choices in the shared menu.
 */
function WidgetSizeMenu(props: Readonly<{ input: WidgetSizePickerCompactInput; testID: string }>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const { input } = props;
    const selected = input.choices.find((choice) => choice.key === input.value) ?? null;
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            items={input.choices.map((choice) => ({ id: choice.key, testID: `${props.testID}.${choice.key}`, title: choice.label,
                ...(choice.unavailable ? { disabled: true } : {}) }))}
            selectedId={selected?.key ?? null}
            onSelect={(id) => { input.onChange(id); setOpen(false); }}
            variant="default"
            matchTriggerWidth={false}
            itemTrigger={{
                title: input.accessibilityLabel,
                detailFormatter: () => selected?.label ?? null,
                itemProps: { testID: `${props.testID}.trigger`, disabled: input.disabled === true, showDivider: false },
            }}
        />
    );
}

/** Keyboard and pointer selection share the Protocol order and the same caller mutation. */
export function stepWidgetSizeControl(control: WidgetSizeControl | undefined, key: string): boolean {
    if (!control || control.disabled || (key !== '[' && key !== ']')) return false;
    const choosable = control.sizes.filter(size => !control.unavailable?.sizes.includes(size));
    const next = stepWidgetSizeV1(choosable, control.size, key === '[' ? -1 : 1);
    if (next && next !== control.size) control.onSet(next);
    return true;
}

/** Only an open overflow mounts the picker; no descriptor reads or details are mounted while shut. */
export function renderWidgetSizeMenuSection(control: WidgetSizeControl | undefined, id: string, testID: string): React.ReactNode | undefined {
    return control && id === 'size' ? <View style={{ padding: 12 }}><WidgetSizeControl {...control} showLabel testID={testID} /></View> : undefined;
}
