import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { selectBrowserSecurityOriginModel, type BrowserSecurityLevel } from '@/sync/domains/browser/shell';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 34,
        maxWidth: 220,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        flexShrink: 1,
    },
}));

type SecurityVisual = Readonly<{
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    tone: 'secure' | 'local' | 'insecure' | 'neutral';
}>;

function visualForLevel(level: BrowserSecurityLevel): SecurityVisual {
    switch (level) {
        case 'secure':
            return { iconName: 'lock-closed', tone: 'secure' };
        case 'local':
            return { iconName: 'home', tone: 'local' };
        case 'insecure':
            return { iconName: 'lock-open', tone: 'insecure' };
        case 'internal':
            return { iconName: 'cube-outline', tone: 'neutral' };
        case 'unknown':
            return { iconName: 'help-circle-outline', tone: 'neutral' };
    }
}

/**
 * Renders the security posture of the active page — the browser already TRACKS `securityOrigin`,
 * this finally SHOWS it (Lunel-parity gap #52). Secure origins get a closed lock, loopback dev
 * servers a home glyph, plaintext sites an open-lock warning. Pure presentation over the canonical
 * `selectBrowserSecurityOriginModel` selector; no scheme/host parsing lives here.
 */
export function SecurityOriginIndicator(props: Readonly<{
    view: BrowserControlViewState | null;
    testID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const model = selectBrowserSecurityOriginModel(props.view);

    // A blank/new tab has no origin to vouch for — defer to the origin chip instead.
    if (model.securityLevel === 'unknown' && !model.originLabel) {
        return null;
    }

    const visual = visualForLevel(model.securityLevel);
    const iconColor = visual.tone === 'secure'
        ? theme.colors.state.success.foreground
        : visual.tone === 'insecure'
            ? theme.colors.state.warning.foreground
            : theme.colors.text.secondary;
    const accessibilityLabel = t(`browserShell.security.${model.securityLevel}` as const);

    return (
        <View
            testID={props.testID}
            style={stylesheet.chip}
            accessibilityRole="text"
            accessibilityLabel={model.originLabel
                ? `${accessibilityLabel}: ${model.originLabel}`
                : accessibilityLabel}
        >
            <Ionicons name={visual.iconName} size={14} color={iconColor} />
            <Text numberOfLines={1} style={stylesheet.text}>
                {model.originLabel ?? accessibilityLabel}
            </Text>
        </View>
    );
}
