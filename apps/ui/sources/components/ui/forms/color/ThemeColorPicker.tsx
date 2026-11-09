import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import ColorPicker, { HueSlider, OpacitySlider, Panel1, Swatches, type ColorFormatsObject } from 'reanimated-color-picker';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import {
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
    Popover,
} from '@/components/ui/popover';
import { Text, TextInput } from '@/components/ui/text/Text';
import { isValidThemeProfileColorValue, normalizeOpaqueThemeHexColor } from '@/theme/profiles/themeProfileColorValidation';
import { t } from '@/text';
import { ThemeColorPreviewSwatch } from './ThemeColorPreviewSwatch';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export const ThemeColorPicker = React.memo(function ThemeColorPicker(props: Readonly<{
    value: string;
    onChange: (value: string) => void;
    onValidityChange?: (isValid: boolean) => void;
    inputTestID?: string;
    previewTestID?: string;
    pickerTestID?: string;
    recentColors?: readonly string[];
    disabled?: boolean;
    /** Show the picker surface below the field instead of in a popover (for hosts that are already a dialog). */
    inline?: boolean;
    /** When false, only opaque hex colours are accepted and committed, normalized to `#RRGGBB`. */
    allowAlpha?: boolean;
}>) {
    const styles = stylesheet;
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [textValue, setTextValue] = React.useState(props.value);

    React.useEffect(() => {
        setTextValue(props.value);
    }, [props.value]);

    const allowAlpha = props.allowAlpha !== false;
    const commit = React.useCallback((nextValue: string) => {
        if (props.disabled) return;
        setTextValue(nextValue);
        const committed = allowAlpha
            ? (isValidThemeProfileColorValue(nextValue) ? nextValue.trim() : null)
            : normalizeOpaqueThemeHexColor(nextValue);
        props.onValidityChange?.(committed !== null);
        if (committed !== null) {
            props.onChange(committed);
        }
    }, [allowAlpha, props]);

    const commitPickerColor = React.useCallback((colors: ColorFormatsObject) => {
        const nextValue = /,\s*1\)$/.test(colors.rgba) ? colors.hex : colors.rgba;
        commit(nextValue);
    }, [commit]);

    const pickerValue = props.value === 'transparent' ? 'rgba(0,0,0,0)' : props.value;
    const swatchColors = props.recentColors?.filter((color) => color !== 'transparent');

    const picker = (
        <View testID={props.pickerTestID} style={styles.pickerSurface}>
            <ColorPicker
                value={pickerValue}
                onChangeJS={commitPickerColor}
                onCompleteJS={commitPickerColor}
                boundedThumb
                thumbSize={20}
                sliderThickness={16}
                style={styles.picker}
            >
                <View testID={props.pickerTestID ? `${props.pickerTestID}:panel` : undefined}>
                    <Panel1 style={styles.panel} />
                </View>
                <View testID={props.pickerTestID ? `${props.pickerTestID}:hue` : undefined}>
                    <HueSlider style={styles.slider} />
                </View>
                {allowAlpha ? (
                    <View testID={props.pickerTestID ? `${props.pickerTestID}:opacity` : undefined}>
                        <OpacitySlider style={styles.slider} />
                    </View>
                ) : null}
                <View testID={props.pickerTestID ? `${props.pickerTestID}:swatches` : undefined}>
                    <Swatches
                        colors={swatchColors?.length ? [...swatchColors] : undefined}
                        style={styles.pickerSwatches}
                        swatchStyle={styles.pickerSwatch}
                    />
                </View>
            </ColorPicker>
            {props.recentColors?.length ? (
                <View style={styles.recentRow} accessibilityLabel={t('settingsAppearance.themeProfiles.recentColors')}>
                    {props.recentColors.map((color) => (
                        <Pressable
                            key={color}
                            accessibilityRole="button"
                            accessibilityLabel={color}
                            onPress={() => commit(color)}
                            style={[styles.recentColor, { backgroundColor: color }]}
                        />
                    ))}
                </View>
            ) : (
                <Text style={styles.fallbackText}>{t('settingsAppearance.themeProfiles.colorPickerFallback')}</Text>
            )}
        </View>
    );

    const field = (
        <View ref={anchorRef} collapsable={false} style={styles.container}>
            <HappierPressable
                testID={props.previewTestID ? `${props.previewTestID}-button` : undefined}
                accessibilityRole="button"
                accessibilityLabel={props.value}
                onPress={() => setOpen((current) => !current)}
                disabled={props.disabled || props.inline}
            >
                <ThemeColorPreviewSwatch
                    testID={props.previewTestID}
                    color={props.value}
                />
            </HappierPressable>
            <TextInput
                testID={props.inputTestID}
                value={textValue}
                onChangeText={commit}
                onFocus={() => {
                    if (!props.disabled && !props.inline) setOpen(true);
                }}
                editable={!props.disabled}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('settingsAppearance.themeProfiles.colorInputPlaceholder')}
                style={styles.input}
            />
            {open && !props.inline ? (
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement="auto-vertical"
                    gap={8}
                    maxHeightCap={360}
                    maxWidthCap={320}
                    portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
                    onRequestClose={() => setOpen(false)}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} keyboardShouldPersistTaps="always" surfaceChrome="theme">
                            {picker}
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );

    if (!props.inline) return field;
    return (
        <View style={styles.inlineContainer}>
            {field}
            {picker}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.s8,
        minWidth: 0,
        maxWidth: '100%',
        flexShrink: 1,
    },
    inlineContainer: {
        gap: theme.space.s12,
    },
    input: {
        flex: 1,
        minWidth: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s8,
    },
    pickerSurface: {
        gap: theme.space.s10,
        minWidth: 240,
        padding: theme.space.s4,
    },
    picker: {
        gap: theme.space.s8,
        width: '100%',
    },
    panel: {
        height: 120,
        borderRadius: 10,
    },
    slider: {
        borderRadius: 999,
    },
    pickerSwatches: {
        gap: theme.space.s6,
        justifyContent: 'flex-start',
    },
    pickerSwatch: {
        width: 20,
        height: 20,
        borderRadius: 999,
    },
    recentRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    recentColor: {
        width: 22,
        height: 22,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    fallbackText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
}));
