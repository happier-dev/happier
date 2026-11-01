import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ThemeColorPicker } from '@/components/ui/forms/color/ThemeColorPicker';
import { Text } from '@/components/ui/text/Text';
import { useCustomSessionAppearanceColors } from '@/hooks/session/useSessionAppearance';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import {
    parseSessionAppearanceColor,
    resolveSessionAppearanceColor,
    type SessionAppearanceColor,
} from '@/sync/domains/session/organization/appearanceColor';
import { ACCENT_COLOR_KEYS } from '@/theme/accentColors';
import { t } from '@/text';

type AppearanceTheme = Parameters<typeof resolveSessionAppearanceColor>[1];

function toOpaqueHex(color: SessionAppearanceColor | null, theme: AppearanceTheme): `#${string}` | null {
    const paint = resolveSessionAppearanceColor(color, theme);
    const parsed = paint ? parseSessionAppearanceColor({ kind: 'custom', hex: paint }) : null;
    return parsed?.kind === 'custom' ? parsed.hex : null;
}

export function SessionAppearanceCustomColorModal(props: Readonly<{
    initialColor: SessionAppearanceColor | null;
    serverId?: string | null;
    onResolve: (value: SessionAppearanceColor | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // Seeded from the target's own or inherited colour; a fresh pick starts from the first preset.
    // Fixed for the dialog's life: a theme switch mid-edit must not reset what the person typed.
    const [seed] = React.useState(
        () => toOpaqueHex(props.initialColor, theme) ?? toOpaqueHex({ kind: 'accent', key: ACCENT_COLOR_KEYS[0] }, theme) ?? '',
    );
    // A preset's paint saved as a custom hex would stop adapting to light/dark, so it is never offered.
    const blockedHexes = React.useMemo(() => new Set([
        seed,
        ...ACCENT_COLOR_KEYS.map((key) => toOpaqueHex({ kind: 'accent', key }, theme)),
    ]), [seed, theme]);
    const [hex, setHex] = React.useState<string>(seed);
    const [valid, setValid] = React.useState(true);
    // Mounted only while this picker is open, per the closed-popover rule.
    const colorsInUse = useCustomSessionAppearanceColors(props.serverId);
    const parsed = valid ? parseSessionAppearanceColor({ kind: 'custom', hex }) : null;
    const chosen = parsed?.kind === 'custom' && !blockedHexes.has(parsed.hex) ? parsed : null;

    const finish = React.useCallback((value: SessionAppearanceColor | null) => {
        props.onResolve(value);
        props.onClose();
    }, [props]);

    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            <RoundButton display="inverted" title={t('common.cancel')} onPress={() => finish(null)} />
            <RoundButton
                title={t('common.save')}
                disabled={chosen === null}
                onPress={() => {
                    if (chosen) finish(chosen);
                }}
            />
        </View>
    ), [chosen, finish, styles.footer]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionsList.appearance.customColorTitle'),
        subtitle: t('sessionsList.appearance.customColorMessage'),
        testID: 'session-appearance-custom-color-modal',
        dimensions: { width: 380, maxHeightRatio: 0.86, size: 'dialog' as const },
        footer,
    }), [footer]));

    return (
        <View style={styles.body}>
            <ThemeColorPicker
                value={hex}
                onChange={setHex}
                onValidityChange={setValid}
                inline
                allowAlpha={false}
                recentColors={colorsInUse}
                inputTestID="session-appearance-custom-color-input"
                previewTestID="session-appearance-custom-color-preview"
                pickerTestID="session-appearance-custom-color-picker"
            />
            {!valid ? (
                <Text style={styles.error}>{t('sessionsList.appearance.invalidColor')}</Text>
            ) : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        padding: 18,
        gap: 10,
    },
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
    },
    error: {
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
    },
}));
