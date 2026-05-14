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
import { getThemeProfileContrastWarnings, readDraftTokenValue } from './themeProfileEditorModel';

export const ThemeColorTokenRow = React.memo(function ThemeColorTokenRow(props: Readonly<{
    profile: ThemeProfileV1;
    mode: ThemeProfileMode;
    token: ThemeProfileTokenDefinition;
    invalid: boolean;
    readonly?: boolean;
    recentColors: readonly string[];
    onChange: (tokenId: string, value: string) => void;
    onInvalidChange: (tokenId: string, invalid: boolean) => void;
    onReset: (tokenId: string) => void;
}>) {
    const styles = stylesheet;
    const value = readDraftTokenValue(props.profile, props.mode, props.token);
    const overridden = Object.prototype.hasOwnProperty.call(props.profile.overrides[props.mode], props.token.id);
    const warnings = getThemeProfileContrastWarnings(props.profile, props.mode, props.token);
    const resetActionId = `reset-${props.mode}-${props.token.id}`;
    const resetActions: ItemAction[] = overridden && !props.readonly ? [{
        id: resetActionId,
        title: t('settingsAppearance.themeProfiles.resetToken'),
        subtitle: props.token.id,
        icon: 'refresh-outline',
        inlineTestID: `settings-theme-color-reset-${props.mode}-${props.token.id}`,
        onPress: () => props.onReset(props.token.id),
    }] : [];

    return (
        <View testID={`settings-theme-color-token-${props.mode}-${props.token.id}`}>
            <Item
                title={props.token.label}
                subtitle={props.token.description}
                mode="info"
                rightElement={(
                    <View style={styles.controls}>
                        <ThemeColorPicker
                            value={value}
                            inputTestID={`settings-theme-color-input-${props.mode}-${props.token.id}`}
                            previewTestID={`settings-theme-color-swatch-${props.mode}-${props.token.id}`}
                            recentColors={props.recentColors}
                            disabled={props.readonly}
                            onChange={(nextValue) => props.onChange(props.token.id, nextValue)}
                            onValidityChange={(isValid) => props.onInvalidChange(props.token.id, !isValid)}
                        />
                        {resetActions.length ? (
                            <ItemRowActions
                                title={props.token.id}
                                actions={resetActions}
                                compactActionIds={[resetActionId]}
                                pinnedActionIds={[resetActionId]}
                                overflowTriggerTestID={`settings-theme-color-actions-${props.mode}-${props.token.id}`}
                            />
                        ) : null}
                    </View>
                )}
            />
            {props.invalid ? (
                <Text testID={`settings-theme-color-error-${props.mode}-${props.token.id}`} style={styles.feedbackText}>
                    {t('settingsAppearance.themeProfiles.invalidColor')}
                </Text>
            ) : null}
            {warnings.length ? (
                <Text testID={`settings-theme-contrast-warning-${props.mode}-${props.token.id}`} style={styles.feedbackText}>
                    {t('settingsAppearance.themeProfiles.contrastWarning')}
                </Text>
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    controls: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 12,
    },
    feedbackText: {
        color: theme.colors.state.warning.foreground,
        paddingHorizontal: 18,
        paddingBottom: 8,
        fontSize: 12,
    },
}));
