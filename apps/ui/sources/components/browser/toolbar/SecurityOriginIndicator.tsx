import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { selectBrowserSecurityOriginModel, type BrowserSecurityLevel } from '@/sync/domains/browser/shell';
import { t } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

import { BROWSER_CHROME_WIDTH } from '../browserChromeDensity';

const stylesheet = StyleSheet.create((theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 34,
        maxWidth: BROWSER_CHROME_WIDTH.chip,
        borderRadius: 8,
        paddingHorizontal: 8,
    },
    // Quiet by default: the toolbar already had six bordered grey pills, and the one that carries
    // trust should not be visually interchangeable with them. It earns a fill only when the
    // connection is something the user needs to know about.
    chipInsecure: {
        backgroundColor: theme.colors.state.warning.background,
    },
    chipCompact: {
        paddingHorizontal: 6,
        gap: 0,
    },
    text: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    textInsecure: {
        color: theme.colors.state.warning.foreground,
    },
}));

type SecurityVisual = Readonly<{
    iconName: IconName;
    tone: 'secure' | 'local' | 'insecure' | 'neutral';
}>;

function visualForLevel(level: BrowserSecurityLevel): SecurityVisual {
    switch (level) {
        case 'secure':
            return { iconName: 'lock', tone: 'secure' };
        case 'local':
            return { iconName: 'house', tone: 'local' };
        case 'insecure':
            // A DIFFERENT glyph, not the same padlock in a different hue: WCAG 1.4.1 forbids
            // conveying this distinction by colour alone, and a user who cannot separate the two
            // hues would otherwise read a plaintext origin as secure.
            return { iconName: 'lock-open', tone: 'insecure' };
        case 'internal':
            return { iconName: 'cube', tone: 'neutral' };
        case 'unknown':
            return { iconName: 'question', tone: 'neutral' };
    }
}

/**
 * The label for a view that has no origin to vouch for yet — a blank new tab, or a target whose
 * identity is its kind rather than a host. Absorbed from the former `BrowserOriginChip`, which sat
 * immediately beside this chip saying a near-identical thing in a near-identical grey pill.
 */
function originKindLabel(view: BrowserControlViewState | null): string {
    if (!view) return t('browserShell.origin.newTab');
    switch (view.target.kind) {
        case 'localServicePreview':
            return t('browserShell.origin.localPreview');
        case 'hostedPluginWeb':
            return t('browserShell.origin.hostedPlugin');
        case 'externalUrl':
            return t('browserShell.origin.external');
        case 'streamedBrowser':
            return t('browserShell.origin.streamed');
        default:
            return t('browserShell.origin.simulator');
    }
}

function originKindGlyph(view: BrowserControlViewState | null): IconName {
    if (!view) return 'globe';
    switch (view.target.kind) {
        case 'localServicePreview':
            return 'house';
        case 'hostedPluginWeb':
            return 'cube';
        case 'externalUrl':
            return 'globe';
        default:
            return 'question';
    }
}

/**
 * The ONE identity chip in the browser toolbar: what this page is, and whether the connection to it
 * can be trusted.
 *
 * It used to be two chips and a title — a security indicator, an origin-kind chip and a page-title
 * chip, three bordered grey pills in a row saying overlapping things while the workspace tab strip
 * already owned the title. This is their single owner. Secure origins get a closed lock, loopback
 * dev servers a home glyph, and plaintext origins an OPEN lock in the warning tone — a different
 * glyph, so the warning survives a user who cannot separate the two hues.
 *
 * Pure presentation over the canonical `selectBrowserSecurityOriginModel` selector; no scheme/host
 * parsing lives here.
 */
export function SecurityOriginIndicator(props: Readonly<{
    view: BrowserControlViewState | null;
    /**
     * Narrow chrome: keep the glyph, drop the label. The origin text is already in the address
     * field two controls to the left, so the label is the redundant half — the trust glyph is not.
     */
    compact?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const model = selectBrowserSecurityOriginModel(props.view);

    // No origin to vouch for: name what the view IS instead of rendering an empty trust chip.
    const hasOrigin = Boolean(model.originLabel) || model.securityLevel !== 'unknown';
    const visual = hasOrigin ? visualForLevel(model.securityLevel) : null;
    const iconName = visual?.iconName ?? originKindGlyph(props.view);
    const iconColor = visual?.tone === 'secure'
        ? theme.colors.state.success.foreground
        : visual?.tone === 'insecure'
            ? theme.colors.state.warning.foreground
            : theme.colors.text.secondary;

    const securityLabel = t(`browserShell.security.${model.securityLevel}` as const);
    const label = model.originLabel ?? (hasOrigin ? securityLabel : originKindLabel(props.view));
    const insecure = visual?.tone === 'insecure';

    return (
        <View
            testID={props.testID}
            style={[
                stylesheet.chip,
                insecure ? stylesheet.chipInsecure : null,
                props.compact ? stylesheet.chipCompact : null,
            ]}
            accessibilityRole="text"
            accessibilityLabel={hasOrigin && model.originLabel
                ? `${securityLabel}: ${model.originLabel}`
                : hasOrigin
                    ? securityLabel
                    : originKindLabel(props.view)}
        >
            <Icon name={iconName} size={14} color={iconColor} />
            {props.compact ? null : (
                <Text numberOfLines={1} style={[stylesheet.text, insecure ? stylesheet.textInsecure : null]}>
                    {label}
                </Text>
            )}
        </View>
    );
}
