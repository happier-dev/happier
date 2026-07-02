import * as React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

import { BrandSubTagline } from './BrandSubTagline';
import { BrandTagline } from './BrandTagline';
import { BrandTrustStrip } from './BrandTrustStrip';
import { BrandWordmark } from './BrandWordmark';
import { ProviderMarkRow } from '@/components/onboarding/preAuth/ProviderMarkRow';
import { PlanetBackground } from './PlanetBackground';
import { useBrandPaneTokens } from './brandPaneTokens';

// Mobile brand-hero content padding. Top matches horizontal so the wordmark
// sits visually flush with the left margin from both directions (instead of
// hugging the safe area too tightly). Bottom is a touch more generous to
// give the "Get started" button breathing room from the home indicator.
const MOBILE_CONTENT_TOP = 24;
const MOBILE_CONTENT_HORIZONTAL = 24;
const MOBILE_CONTENT_BOTTOM = 28;

export type BrandPanelProps = Readonly<{
    variant: 'desktop' | 'mobile-hero';
    /**
     * Required when variant === 'mobile-hero'. Called when the user taps
     * "Get started" to dismiss the one-time mobile brand prelude. The shell
     * passes a callback that writes `brandHeroSeenAt` to local settings.
     */
    onGetStarted?: () => void;
    testID?: string;
}>;

/**
 * The brand surface on the unauth onboarding flow. Theme-aware: in dark mode
 * the canvas is near-black with the dark planet variant and white text; in
 * light mode the canvas is cream paper with the warm planet variant and
 * near-black text. The provider row and trust strip use the matching muted
 * foreground so they read on both planets.
 *
 * Renders as:
 *   - desktop: left half of the split view (logo top-left, planet behind,
 *     tagline/provider row/trust strip bottom-left).
 *   - mobile-hero: full-screen prelude with the same composition vertically
 *     centered and a "Get started" button anchored at the bottom.
 *
 * See `00-context.md` § Decision 9 for the rationale behind the theme-aware
 * brand-pane palette.
 */
export const BrandPanel = React.memo(function BrandPanel(props: BrandPanelProps) {
    const { theme } = useUnistyles();
    const safeAreaInsets = useSafeAreaInsets();
    const tokens = useBrandPaneTokens();
    const styles = stylesheet;
    const rootStyle = [styles.root, { backgroundColor: tokens.background }];
    const fadeColors = [tokens.backgroundTransparent, tokens.background] as const;
    const markTone: 'on-dark' | 'on-light' = theme.dark ? 'on-dark' : 'on-light';

    if (props.variant === 'desktop') {
        return (
            <View
                testID={props.testID ?? 'unauth-shell-brand-pane'}
                style={rootStyle}
            >
                <PlanetBackground variant="desktop" />
                <LinearGradient
                    pointerEvents="none"
                    colors={fadeColors}
                    locations={[0, 1]}
                    style={styles.bottomFadeDesktop}
                />
                <View style={styles.contentDesktop} pointerEvents="box-none">
                    <BrandWordmark height={32} />
                    <View style={styles.bottomBlockDesktop}>
                        <BrandTagline />
                        <View style={styles.gap22} />
                        <BrandSubTagline />
                        <View style={styles.gap26} />
                        <ProviderMarkRow tone={markTone} justify="flex-start" />
                        <View style={styles.gap16} />
                        <BrandTrustStrip />
                    </View>
                </View>
            </View>
        );
    }

    // mobile-hero
    return (
        <View
            testID={props.testID ?? 'unauth-shell-brand-pane'}
            style={rootStyle}
        >
            <PlanetBackground variant="mobile" />
            <LinearGradient
                pointerEvents="none"
                colors={fadeColors}
                locations={[0, 1]}
                style={styles.bottomFadeMobile}
            />
            <View
                testID="unauth-shell-brand-content-mobile"
                style={[
                    styles.contentMobile,
                    {
                        top: MOBILE_CONTENT_TOP + safeAreaInsets.top,
                        left: MOBILE_CONTENT_HORIZONTAL + safeAreaInsets.left,
                        right: MOBILE_CONTENT_HORIZONTAL + safeAreaInsets.right,
                        bottom: MOBILE_CONTENT_BOTTOM + safeAreaInsets.bottom,
                    },
                ]}
                pointerEvents="box-none"
            >
                <BrandWordmark height={30} />
                <View style={styles.mobileTaglineBlock}>
                    <BrandTagline mobile />
                    <View style={styles.gap18} />
                    <BrandSubTagline mobile />
                    <View style={styles.gap22} />
                    <ProviderMarkRow tone={markTone} justify="center" />
                    <View style={styles.gap22} />
                    <BrandTrustStrip mobile />
                </View>
                <View style={styles.mobileButtonContainer}>
                    <RoundButton
                        size="large"
                        display="default"
                        title={t('welcome.brandHeroGetStarted')}
                        onPress={props.onGetStarted}
                        testID="brand-hero-get-started"
                        accessibilityLabel={t('welcome.brandHeroGetStarted')}
                    />
                </View>
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
        overflow: 'hidden',
    },
    contentDesktop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        padding: 56,
        justifyContent: 'space-between',
    },
    // Soft bottom fade so the tagline / trust strip read cleanly against the
    // planet. Mirrors the website hero's `linear-gradient(to bottom,
    // transparent 0%, canvas 100%)`; the canvas color comes from the
    // theme-aware brand-pane tokens.
    bottomFadeDesktop: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '55%',
    },
    bottomFadeMobile: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '60%',
    },
    bottomBlockDesktop: {
        // Bottom-anchored tagline block.
    },
    contentMobile: {
        position: 'absolute',
        justifyContent: 'space-between',
    },
    mobileTaglineBlock: {
        flexShrink: 1,
        justifyContent: 'center',
    },
    mobileButtonContainer: {
        // Anchors "Get started" at the bottom of the hero.
    },
    gap16: { height: 16 },
    gap18: { height: 18 },
    gap22: { height: 22 },
    gap26: { height: 26 },
}));
