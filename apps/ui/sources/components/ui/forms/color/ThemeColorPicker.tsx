import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import ColorPicker, { HueSlider, OpacitySlider, Panel1, Swatches, type ColorFormatsObject } from 'reanimated-color-picker';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text, TextInput } from '@/components/ui/text/Text';
import { isValidThemeProfileColorValue } from '@/theme/profiles/themeProfileColorValidation';
import { t } from '@/text';
import { ThemeColorPreviewSwatch } from './ThemeColorPreviewSwatch';

export const ThemeColorPicker = React.memo(function ThemeColorPicker(props: Readonly<{
    value: string;
    onChange: (value: string) => void;
    onValidityChange?: (isValid: boolean) => void;
    inputTestID?: string;
    previewTestID?: string;
    pickerTestID?: string;
    recentColors?: readonly string[];
    disabled?: boolean;
}>) {
    const styles = stylesheet;
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [textValue, setTextValue] = React.useState(props.value);

    React.useEffect(() => {
        setTextValue(props.value);
    }, [props.value]);

    const commit = React.useCallback((nextValue: string) => {
        if (props.disabled) return;
        setTextValue(nextValue);
        const valid = isValidThemeProfileColorValue(nextValue);
        props.onValidityChange?.(valid);
        if (valid) {
            props.onChange(nextValue.trim());
        }
    }, [props]);

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
                <View testID={props.pickerTestID ? `${props.pickerTestID}:opacity` : undefined}>
                    <OpacitySlider style={styles.slider} />
                </View>
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

    return (
        <View ref={anchorRef} collapsable={false} style={styles.container}>
            <Pressable
                testID={props.previewTestID ? `${props.previewTestID}-button` : undefined}
                accessibilityRole="button"
                accessibilityLabel={props.value}
                onPress={() => setOpen((current) => !current)}
                disabled={props.disabled}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
                <ThemeColorPreviewSwatch
                    testID={props.previewTestID}
                    color={props.value}
                />
            </Pressable>
            <TextInput
                testID={props.inputTestID}
                value={textValue}
                onChangeText={commit}
                onFocus={() => {
                    if (!props.disabled) setOpen(true);
                }}
                editable={!props.disabled}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('settingsAppearance.themeProfiles.colorInputPlaceholder')}
                style={styles.input}
            />
            {open ? (
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement="auto-vertical"
                    gap={8}
                    maxHeightCap={360}
                    maxWidthCap={320}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false }}
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
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
        minWidth: 180,
    },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 10,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    pickerSurface: {
        gap: 10,
        minWidth: 240,
        padding: 4,
    },
    picker: {
        gap: 8,
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
        gap: 6,
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
        gap: 6,
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
