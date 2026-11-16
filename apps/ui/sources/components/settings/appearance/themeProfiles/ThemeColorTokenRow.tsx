import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Text } from '@/components/ui/text/Text';
import { ThemeColorPicker } from '@/components/ui/forms/color/ThemeColorPicker';
import { t } from '@/text';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { ThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import { getThemeProfileContrastAnalysis, readDraftTokenValue } from './themeProfileEditorModel';

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
    const resetActionId = `reset-${props.rowId}`;
    const fixActionId = `fix-contrast-${props.rowId}`;
    const onReset = props.onReset;
    const actions: ItemAction[] = props.changed && onReset && !props.readonly ? [{
        id: resetActionId,
        title: t('settingsAppearance.themeProfiles.resetToken'),
        icon: 'arrow-clockwise',
        inlineTestID: `settings-theme-color-reset-${props.rowId}`,
        onPress: onReset,
    }] : [];
    if (props.warning && props.onFixContrast && !props.readonly) actions.unshift({
        id: fixActionId,
        title: t('settingsAppearance.themeProfiles.fixContrast'),
        icon: 'magic-wand',
        inlineTestID: `settings-theme-contrast-fix-${props.rowId}`,
        onPress: props.onFixContrast,
    });
    const actionIds = actions.map(action => action.id);

    return (
        <View testID={`settings-theme-color-token-${props.rowId}`} style={props.highlighted ? styles.highlighted : null}>
            <Item
                title={props.title}
                subtitle={props.subtitle}
                mode="info"
                accessoryLayout="adaptive"
                rightElement={(
                    <View style={styles.controls}>
                        <ThemeColorPicker
                            value={props.value}
                            inputTestID={`settings-theme-color-input-${props.rowId}`}
                            previewTestID={`settings-theme-color-swatch-${props.rowId}`}
                            recentColors={props.recentColors}
                            disabled={props.readonly}
                            onChange={props.onChange}
                            onValidityChange={(isValid) => props.onInvalidChange(!isValid)}
                        />
                        {actions.length ? (
                            <ItemRowActions
                                title={props.title}
                                actions={actions}
                                compactActionIds={actionIds}
                                pinnedActionIds={actionIds}
                                overflowTriggerTestID={`settings-theme-color-actions-${props.rowId}`}
                            />
                        ) : null}
                    </View>
                )}
            />
            {props.invalid ? (
                <Text testID={`settings-theme-color-error-${props.rowId}`} variant="meta" style={styles.feedbackText}>
                    {t('settingsAppearance.themeProfiles.invalidColor')}
                </Text>
            ) : null}
            {props.warning ? (
                <Text testID={`settings-theme-contrast-warning-${props.rowId}`} variant="meta" style={styles.feedbackText}>
                    {props.warning}
                </Text>
            ) : null}
        </View>
    );
});

/** A token of the colour registry, read from the draft for one mode. */
export const ThemeColorTokenRow = React.memo(function ThemeColorTokenRow(props: Readonly<{
    profile: ThemeProfileV1;
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
    const changed = Object.prototype.hasOwnProperty.call(props.profile.overrides[props.mode], token.id);
    const contrast = getThemeProfileContrastAnalysis(props.profile, props.mode, token);
    const fixContrast = React.useCallback(() => {
        if (contrast.fix !== null) onChange(token.id, contrast.fix);
    }, [contrast.fix, onChange, token.id]);
    return (
        <ThemeColorRow
            rowId={`${props.mode}-${token.id}`}
            title={token.labelKey ? t(token.labelKey) : token.label}
            subtitle={changed ? t('settingsAppearance.themeProfiles.colorChanged') : token.descriptionKey ? t(token.descriptionKey) : token.description}
            value={readDraftTokenValue(props.profile, props.mode, token)}
            changed={changed}
            invalid={props.invalid}
            warning={contrast.warnings.length ? t('settingsAppearance.themeProfiles.contrastWarning') : undefined}
            onFixContrast={contrast.fix === null ? undefined : fixContrast}
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
    controls: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.s12,
    },
    feedbackText: {
        color: theme.colors.state.warning.foreground,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s8,
    },
    highlighted: {
        backgroundColor: theme.colors.surface.selected,
    },
}));
