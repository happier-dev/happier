import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { ThemeColorPicker } from '@/components/ui/forms/color/ThemeColorPicker';
import { t } from '@/text';
import type { ThemeProfileMode } from '@/theme/profiles/themeProfileTypes';
import { getThemeProfileTokenDefinition, type ThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import { joinList } from '@/utils/text/joinList';

/**
 * One colour of a theme: its name, what it follows or that it changed, the colour field, and Reset when
 * it changed. The seeds (Page, Accent) and every token share this one anatomy.
 */
export const ThemeColorRow = React.memo(function ThemeColorRow(props: Readonly<{
    /** Stable id for tests and the reset action (`<mode>-<id>`). */
    rowId: string;
    title: string;
    subtitle: string;
    value: string;
    changed: boolean;
    invalid: boolean;
    /** A failing contrast pair, said only when it fails. */
    warning?: string;
    readonly?: boolean;
    recentColors: readonly string[];
    onChange: (value: string) => void;
    onInvalidChange: (invalid: boolean) => void;
    onReset?: () => void;
    onFixContrast?: () => void;
    /** The highlighted row the colour picker found in the app. */
    highlighted?: boolean;
}>) {
    const styles = stylesheet;
    const canReset = props.changed && props.onReset !== undefined && !props.readonly;
    const canFix = Boolean(props.warning) && props.onFixContrast !== undefined && !props.readonly;

    return (
        <View testID={`settings-theme-color-token-${props.rowId}`} style={props.highlighted ? styles.highlighted : null}>
            <Item
                title={props.title}
                subtitle={props.subtitle}
                // Reset sits with the fact it undoes ("Changed"), in the row's text, never beside the field.
                subtitleAccessory={canReset ? (
                    <TextLinkButton testID={`settings-theme-color-reset-${props.rowId}`} size="meta" tone="quiet"
                        label={t('settingsAppearance.themeProfiles.resetToken')} onPress={props.onReset!} />
                ) : undefined}
                mode="info"
                accessoryLayout="adaptive"
                // The contrast warning belongs to this row: under its description, naming the pair, with its fix.
                bottomElement={props.warning ? (
                    <View style={styles.warningLine}>
                        <Text testID={`settings-theme-contrast-warning-${props.rowId}`} variant="meta" style={styles.warningText}>
                            {props.warning}
                        </Text>
                        {canFix ? (
                            <TextLinkButton testID={`settings-theme-contrast-fix-${props.rowId}`} size="meta" tone="strong"
                                label={t('settingsAppearance.themeProfiles.fixContrast')} onPress={props.onFixContrast!} />
                        ) : null}
                    </View>
                ) : undefined}
                bottomElementInset="text"
                bottomElementOutsidePressable
                // Every row's control is the colour alone, so swatches and fields stand on one column.
                rightElement={(
                    <ThemeColorPicker
                        value={props.value}
                        inputTestID={`settings-theme-color-input-${props.rowId}`}
                        previewTestID={`settings-theme-color-swatch-${props.rowId}`}
                        recentColors={props.recentColors}
                        disabled={props.readonly}
                        onChange={props.onChange}
                        onValidityChange={(isValid) => props.onInvalidChange(!isValid)}
                    />
                )}
            />
            {props.invalid ? (
                <Text testID={`settings-theme-color-error-${props.rowId}`} variant="meta" style={styles.feedbackText}>
                    {t('settingsAppearance.themeProfiles.invalidColor')}
                </Text>
            ) : null}
        </View>
    );
});

/** A token of the colour registry, read from the draft for one mode. */
export const ThemeColorTokenRow = React.memo(function ThemeColorTokenRow(props: Readonly<{
    value: string;
    changed: boolean;
    /** The colours this one fails to contrast with, named ("Danger background"); null when every pair reads. */
    contrastAgainst: string | null;
    contrastFix: string | null;
    mode: ThemeProfileMode;
    token: ThemeProfileTokenDefinition;
    invalid: boolean;
    readonly?: boolean;
    recentColors: readonly string[];
    highlighted?: boolean;
    onChange: (tokenId: string, value: string) => void;
    onInvalidChange: (tokenId: string, invalid: boolean) => void;
    onReset: (tokenId: string) => void;
}>) {
    const { token, onChange, onInvalidChange, onReset } = props;
    const { changed, contrastFix } = props;
    const fixContrast = React.useCallback(() => {
        if (contrastFix !== null) onChange(token.id, contrastFix);
    }, [contrastFix, onChange, token.id]);
    return (
        <ThemeColorRow
            rowId={`${props.mode}-${token.id}`}
            title={token.labelKey ? t(token.labelKey) : token.label}
            subtitle={changed ? t('settingsAppearance.themeProfiles.colorChanged') : token.descriptionKey ? t(token.descriptionKey) : token.description}
            value={props.value}
            changed={changed}
            invalid={props.invalid}
            warning={props.contrastAgainst ? t('settingsAppearance.themeProfiles.contrastWarning', { pair: props.contrastAgainst }) : undefined}
            onFixContrast={contrastFix === null ? undefined : fixContrast}
            readonly={props.readonly}
            recentColors={props.recentColors}
            highlighted={props.highlighted}
            onChange={React.useCallback((value: string) => onChange(token.id, value), [onChange, token.id])}
            onInvalidChange={React.useCallback((invalid: boolean) => onInvalidChange(token.id, invalid), [onInvalidChange, token.id])}
            onReset={React.useCallback(() => onReset(token.id), [onReset, token.id])}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    feedbackText: {
        color: theme.colors.state.warning.textForeground,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s8,
    },
    highlighted: {
        backgroundColor: theme.colors.surface.selected,
    },
    warningText: {
        color: theme.colors.state.warning.textForeground,
    },
    warningLine: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
    },
}));

const NO_PAIRS: readonly string[] = Object.freeze([]);

/** The colours a token fails to contrast with, by their names, for its row's warning; null when none fails. */
export function describeContrastPairs(tokenIds: readonly string[] = NO_PAIRS): string | null {
    if (tokenIds.length === 0) return null;
    return joinList(tokenIds.map((id) => {
        const definition = getThemeProfileTokenDefinition(id);
        return definition ? (definition.labelKey ? t(definition.labelKey) : definition.label) : id;
    }));
}
