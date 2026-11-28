import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { formatMinorAmount } from '../planSurfaceCopy';

const OTHER_ID = 'other';

/** The server's currency as the person's locale prints its symbol, e.g. "$" for usd. */
function currencySymbol(currency: string): string {
    return formatMinorAmount(0, currency).replace(/[\d\s.,]/g, '');
}

export type AmountChoice = Readonly<{ presetMinor: number } | { otherText: string }>;

/** The chosen amount in minor units, or null while "Other" holds no valid number. */
export function resolveAmountMinor(choice: AmountChoice): number | null {
    if ('presetMinor' in choice) return choice.presetMinor;
    const normalized = choice.otherText.trim().replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    return Math.round(Number(normalized) * 100);
}

export type AmountPickerProps = Readonly<{
    presetsMinor: readonly number[];
    suggestedMinor: number | null;
    currency: string;
    choice: AmountChoice;
    onChange: (next: AmountChoice) => void;
    disabled?: boolean;
}>;

/**
 * Pay-what-you-like amounts for the Supporter pack: the server's presets as tiles plus "Other",
 * whose field opens as one row under the tiles. Choosing makes no request.
 */
export const AmountPicker = React.memo(function AmountPicker(props: AmountPickerProps) {
    const options = React.useMemo<Array<SelectionTile<string>>>(() => [
        ...props.presetsMinor.map((minor) => ({
            id: String(minor),
            title: formatMinorAmount(minor, props.currency),
            subtitle: minor === props.suggestedMinor ? t('planSurface.suggested') : undefined,
            disabled: props.disabled,
        })),
        { id: OTHER_ID, title: t('planSurface.otherAmount'), disabled: props.disabled },
    ], [props.currency, props.disabled, props.presetsMinor, props.suggestedMinor]);

    const value = 'presetMinor' in props.choice ? String(props.choice.presetMinor) : OTHER_ID;
    const otherText = 'otherText' in props.choice ? props.choice.otherText : '';
    const { onChange } = props;

    const otherSelected = value === OTHER_ID;

    return (
        <View style={styles.root}>
            <SelectionTiles
                testIdPrefix="supporter-amount"
                density="compact"
                // Every amount on one row when the sheet is wide enough; the tiles wrap on a phone.
                minimumColumns={options.length}
                options={options}
                value={value}
                onChange={(next) => {
                    if (next === null) return;
                    if (next === OTHER_ID) onChange({ otherText });
                    else onChange({ presetMinor: Number(next) });
                }}
            />
            {/* "Other" opens one fixed-height field under the tiles, so the grid keeps its shape. */}
            {otherSelected ? (
                <View style={styles.otherRow}>
                    <Text style={styles.currency}>{currencySymbol(props.currency)}</Text>
                    <TextInput
                        testID="supporter-amount-other-input"
                        autoFocus
                        value={otherText}
                        onChangeText={(text) => onChange({ otherText: text })}
                        accessibilityLabel={t('planSurface.amountLabel')}
                        keyboardType={Platform.select({ ios: 'decimal-pad', default: 'numeric' })}
                        inputMode="decimal"
                        style={styles.otherInput}
                        selectTextOnFocus
                    />
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 10,
    },
    otherRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 44,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    currency: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text.secondary,
    },
    otherInput: {
        ...Typography.default('semiBold'),
        flex: 1,
        fontSize: 16,
        paddingVertical: 0,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
}));
