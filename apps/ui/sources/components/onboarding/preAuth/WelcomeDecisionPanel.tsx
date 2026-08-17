import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, {
    Easing,
    interpolate,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSetting } from '@/sync/store/hooks';
import { t } from '@/text';
import { useReturningGreeting } from './useReturningGreeting';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

// Premium-feel hover affordances on the welcome buttons. The whole button
// lifts 1px on hover and its content shifts:
//   - primary button → filled ink, the trailing arrow slides 4px right
//     (anticipates the forward action) and the whole pill dims slightly
//   - secondary button → ghost outline, the QR icon scales to 1.08 and the
//     background fades partway from surface.base toward surface.elevated
//     (subtle darken in light theme, subtle lighten in dark theme —
//     surface.elevated is defined per theme to flip in both directions)
// All animations share the same Material standard easing + 180ms duration so
// the two interactions read as one family. Native (iOS/Android) doesn't emit
// hover events, so this is automatically a web/Tauri-only enhancement.
const ICON_HOVER_TRANSLATE_PX = 4;
const ICON_HOVER_SCALE = 1.08;
const BUTTON_HOVER_LIFT_PX = 1;
const PRIMARY_HOVER_OPACITY = 0.92;
// Secondary button bg only fades half the way from surface.base toward
// surface.elevated. That lands at the visual midpoint (~#f8f8f8 in light
// theme, ~#1d1a1a in dark), which is subtler than the full elevated value
// and reads as a hint rather than a state change.
const SECONDARY_HOVER_BG_INTENSITY = 0.5;
const ICON_HOVER_DURATION_MS = 180;
// Material "standard" easing curve. Avoids springs (too playful for a CTA).
const ICON_HOVER_EASING = Easing.bezier(0.4, 0, 0.2, 1);
const DECISION_ROW_PRESSED_STYLE = { opacity: 0.88 };

// Pressable made animatable so we can drive its style from a shared value.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type WelcomeDecisionPanelProps = Readonly<{
    authEntryOptions: AuthEntryOptions;
    onCreateAccount: () => Promise<void> | void;
    onCreateAccountViaProvider: (providerId: string) => Promise<void> | void;
    onLoginWithKeylessProvider: (providerId: string) => Promise<void> | void;
    onLoginWithMtls: () => Promise<void> | void;
    onOpenRestore: () => void;
    onChangeRelay: () => void;
    canScanQr?: boolean;
    onStartScan?: () => void;
}>;

type DecisionButtonProps = Readonly<{
    testID: string;
    title: string;
    subtitle?: string;
    primary?: boolean;
    iconName?: IconName;
    onPress: () => Promise<void> | void;
}>;

function DecisionButton(props: DecisionButtonProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const [isHovered, setIsHovered] = React.useState(false);
    const [isPressed, setIsPressed] = React.useState(false);
    // Single 0→1 progress drives every hover-related animation on the button:
    // the lift translateY, the primary's opacity dim, the secondary's bg
    // colour fade, and the icon slide/scale. Keeping them on one timeline
    // means they start and finish together and read as one motion.
    const hoverProgress = useSharedValue(0);

    React.useEffect(() => {
        const target = isHovered ? 1 : 0;
        if (reducedMotion) {
            hoverProgress.value = target;
            return;
        }
        hoverProgress.value = withTiming(target, {
            duration: ICON_HOVER_DURATION_MS,
            easing: ICON_HOVER_EASING,
        });
    }, [isHovered, reducedMotion, hoverProgress]);

    const isPrimary = props.primary === true;
    const supportsHoverAnimation = Platform.OS === 'web';
    const primaryBg = theme.colors.button.primary.background;
    const primaryTint = theme.colors.button.primary.tint;
    const surfaceRest = theme.colors.surface.base;
    const surfaceHover = theme.colors.surface.elevated;

    // Outer animated style — applied to the Pressable itself.
    //   - Both buttons: lift translateY: 0 → -1
    //   - Primary: dim opacity: 1 → 0.92
    //   - Secondary: background fades between surface.base and surface.elevated
    const containerAnimatedStyle = useAnimatedStyle(() => {
        const lift = interpolate(hoverProgress.value, [0, 1], [0, -BUTTON_HOVER_LIFT_PX]);
        if (isPrimary) {
            return {
                transform: [{ translateY: lift }],
                opacity: interpolate(hoverProgress.value, [0, 1], [1, PRIMARY_HOVER_OPACITY]),
            };
        }
        // Scale the bg progress down so the colour only fades half the way
        // toward surface.elevated. The full elevated shade reads too dark in
        // light theme; landing at the midpoint keeps the cue subtle.
        const bgProgress = interpolate(
            hoverProgress.value,
            [0, 1],
            [0, SECONDARY_HOVER_BG_INTENSITY],
        );
        return {
            transform: [{ translateY: lift }],
            backgroundColor: interpolateColor(
                bgProgress,
                [0, 1],
                [surfaceRest, surfaceHover],
            ),
        };
    }, [isPrimary, primaryBg, surfaceRest, surfaceHover]);

    // Inner animated style — applied to the icon's Animated.View only.
    //   - Primary: arrow slides right (translateX)
    //   - Secondary: icon scales up
    const iconAnimatedStyle = useAnimatedStyle(() => {
        if (isPrimary) {
            const translateX = interpolate(hoverProgress.value, [0, 1], [0, ICON_HOVER_TRANSLATE_PX]);
            return { transform: [{ translateX }] };
        }
        const scale = interpolate(hoverProgress.value, [0, 1], [1, ICON_HOVER_SCALE]);
        return { transform: [{ scale }] };
    }, [isPrimary]);

    const foregroundColor = isPrimary ? primaryTint : theme.colors.text.primary;
    const subtitleColor = isPrimary ? primaryTint : theme.colors.text.secondary;
    const content = (
        <>
            <View testID={`${props.testID}-text`} style={styles.decisionTextBlock}>
                <Text testID={`${props.testID}-title`} style={[styles.decisionTitle, { color: foregroundColor }]}>
                    {props.title}
                </Text>
                {props.subtitle ? (
                    <Text testID={`${props.testID}-subtitle`} style={[styles.decisionSubtitle, { color: subtitleColor }]}>
                        {props.subtitle}
                    </Text>
                ) : null}
            </View>
            {props.iconName ? (
                supportsHoverAnimation ? (
                    <Animated.View style={iconAnimatedStyle}>
                        <Icon
                            testID={`${props.testID}-icon`}
                            name={props.iconName}
                            size={20}
                            color={foregroundColor}
                        />
                    </Animated.View>
                ) : (
                    <View>
                        <Icon
                            testID={`${props.testID}-icon`}
                            name={props.iconName}
                            size={20}
                            color={foregroundColor}
                        />
                    </View>
                )
            ) : null}
        </>
    );
    const baseStyle = [
        styles.decisionButton,
        isPrimary
            ? {
                backgroundColor: primaryBg,
                borderColor: primaryBg,
            }
            : {
                // The rest backgroundColor is also baked in here so
                // the button reads correctly on first paint before
                // the animated value evaluates. The interpolation
                // above then takes over on hover.
                backgroundColor: surfaceRest,
                borderColor: theme.colors.border.default,
            },
        isPressed ? DECISION_ROW_PRESSED_STYLE : null,
    ];

    if (!supportsHoverAnimation) {
        return (
            <Pressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.title}
                onPressIn={() => setIsPressed(true)}
                onPressOut={() => setIsPressed(false)}
                onPress={() => {
                    void props.onPress();
                }}
                style={baseStyle}
            >
                {content}
            </Pressable>
        );
    }

    return (
        <AnimatedPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.title}
            onHoverIn={() => setIsHovered(true)}
            onHoverOut={() => setIsHovered(false)}
            onPressIn={() => setIsPressed(true)}
            onPressOut={() => setIsPressed(false)}
            onPress={() => {
                void props.onPress();
            }}
            style={[
                ...baseStyle,
                containerAnimatedStyle,
            ]}
        >
            {content}
        </AnimatedPressable>
    );
}

export const WelcomeDecisionPanel = React.memo(function WelcomeDecisionPanel(props: WelcomeDecisionPanelProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const options = props.authEntryOptions;
    const showBlocked = options.serverAvailability === 'unavailable' || options.serverAvailability === 'incompatible';
    const providerId = options.providerId;
    const keylessProviderId = options.keylessProviderId;
    const primaryAction = options.primaryAction;
    const showSecondaryKeylessProviderLogin = options.showKeylessProviderLogin && !options.keylessPrimary && !!keylessProviderId;
    const handleLogin = props.canScanQr && props.onStartScan ? props.onStartScan : props.onOpenRestore;
    // Returning users (those who have authenticated on this device before) get
    // a warmer copy variant — a randomly-rotating warm greeting + an inverted
    // button hierarchy (Login becomes primary because that's the most likely
    // intent for a returning visit). The flag is flipped in
    // AuthContext.loginWithCredentials and preserved on logout, so it remains
    // true across re-installs of the session — exactly like the brand-hero
    // seen flag.
    const isReturningUser = useLocalSetting('hasCompletedAuthOnce');
    const returningGreeting = useReturningGreeting();

    const renderActions = () => {
        if (options.serverAvailability === 'loading') {
            return (
                <View testID="welcome-auth-loading" style={styles.statusBlock}>
                    <ActivitySpinner color={theme.colors.text.primary} />
                    <Text style={styles.statusText}>{t('common.loading')}</Text>
                </View>
            );
        }

        if (showBlocked) {
            return (
                <View testID="welcome-auth-blocked" style={styles.statusBlock}>
                    <Text style={styles.statusTitle}>
                        {options.serverAvailability === 'incompatible'
                            ? t('welcome.serverIncompatibleTitle')
                            : t('welcome.serverUnavailableTitle')}
                    </Text>
                    <Text style={styles.statusText}>
                        {options.serverAvailability === 'incompatible'
                            ? t('welcome.serverIncompatibleBody', { serverUrl: options.serverUrlForCopy })
                            : t('welcome.serverUnavailableBody', { serverUrl: options.serverUrlForCopy })}
                    </Text>
                    <View style={styles.statusActions}>
                        <DecisionButton
                            testID="welcome-auth-blocked-change-relay"
                            title={t('setupOnboarding.changeRelayAction')}
                            onPress={props.onChangeRelay}
                        />
                        <DecisionButton
                            testID="welcome-auth-blocked-retry"
                            title={t('common.retry')}
                            onPress={options.retryServerCheck}
                        />
                    </View>
                </View>
            );
        }

        if (!options.showAuthActions) {
            return (
                <View testID="welcome-auth-blocked" style={styles.statusBlock}>
                    <Text style={styles.statusText}>{options.serverUrlForCopy}</Text>
                </View>
            );
        }

        if (options.showAnonymousSignup) {
            // First-time visitors see Start fresh as the primary CTA (the
            // expected action when arriving for the first time). Returning
            // users see Login as the primary CTA — they almost certainly want
            // to sign back into their existing account, so we give the filled
            // black slot to Login and demote Start fresh to the bordered card
            // below. The optional keyless-provider login row sits between
            // primary and secondary in both flows.
            const startFreshButton = (
                <DecisionButton
                    testID="welcome-primary-start"
                    primary={!isReturningUser}
                    title={isReturningUser ? t('welcome.welcomeReturningStartFreshButton') : t('welcome.welcomePrimaryButton')}
                    subtitle={isReturningUser ? t('welcome.welcomeReturningStartFreshSubtitle') : t('welcome.welcomePrimarySubtitle')}
                    iconName="arrow-right"
                    onPress={props.onCreateAccount}
                />
            );
            const loginButton = (
                <DecisionButton
                    testID="welcome-secondary-login"
                    primary={isReturningUser}
                    title={isReturningUser ? t('welcome.welcomeReturningLoginButton') : t('welcome.welcomeSecondaryButton')}
                    subtitle={t('welcome.welcomeSecondarySubtitle')}
                    iconName="qr-code"
                    onPress={handleLogin}
                />
            );
            return (
                <View style={styles.actionStack}>
                    {isReturningUser ? loginButton : startFreshButton}
                    {showSecondaryKeylessProviderLogin ? (
                        <DecisionButton
                            testID="welcome-login-provider"
                            title={options.providerKeylessTitle}
                            onPress={() => props.onLoginWithKeylessProvider(keylessProviderId!)}
                        />
                    ) : null}
                    {options.showProviderSignup && providerId ? (
                        <DecisionButton
                            testID="welcome-signup-provider"
                            title={options.providerSignupTitle}
                            onPress={() => props.onCreateAccountViaProvider(providerId)}
                        />
                    ) : null}
                    {isReturningUser ? startFreshButton : loginButton}
                </View>
            );
        }

        if (primaryAction?.kind === 'mtls') {
            return (
                <View style={styles.actionStack}>
                    <DecisionButton
                        testID="welcome-mtls-primary"
                        primary
                        title={primaryAction.title}
                        onPress={props.onLoginWithMtls}
                    />
                    {showSecondaryKeylessProviderLogin ? (
                        <DecisionButton
                            testID="welcome-login-provider"
                            title={options.providerKeylessTitle}
                            onPress={() => props.onLoginWithKeylessProvider(keylessProviderId!)}
                        />
                    ) : null}
                    <DecisionButton
                        testID="welcome-secondary-login"
                        title={t('welcome.welcomeSecondaryButton')}
                        subtitle={t('welcome.welcomeSecondarySubtitle')}
                        iconName="qr-code"
                        onPress={handleLogin}
                    />
                </View>
            );
        }

        if (primaryAction?.kind === 'keyless' && keylessProviderId) {
            return (
                <View style={styles.actionStack}>
                    <DecisionButton
                        testID="welcome-provider-primary"
                        primary
                        title={primaryAction.title}
                        onPress={() => props.onLoginWithKeylessProvider(keylessProviderId)}
                    />
                    <DecisionButton
                        testID="welcome-secondary-login"
                        title={t('welcome.welcomeSecondaryButton')}
                        subtitle={t('welcome.welcomeSecondarySubtitle')}
                        iconName="qr-code"
                        onPress={handleLogin}
                    />
                </View>
            );
        }

        if (primaryAction?.kind === 'provider-keyed' && providerId) {
            return (
                <View style={styles.actionStack}>
                    <DecisionButton
                        testID="welcome-provider-primary"
                        primary
                        title={primaryAction.title}
                        onPress={() => props.onCreateAccountViaProvider(providerId)}
                    />
                    {showSecondaryKeylessProviderLogin ? (
                        <DecisionButton
                            testID="welcome-login-provider"
                            title={options.providerKeylessTitle}
                            onPress={() => props.onLoginWithKeylessProvider(keylessProviderId!)}
                        />
                    ) : null}
                    <DecisionButton
                        testID="welcome-secondary-login"
                        title={t('welcome.welcomeSecondaryButton')}
                        subtitle={t('welcome.welcomeSecondarySubtitle')}
                        iconName="qr-code"
                        onPress={handleLogin}
                    />
                </View>
            );
        }

        return (
            <View style={styles.actionStack}>
                <DecisionButton
                    testID="welcome-secondary-login"
                    primary={primaryAction === null}
                    title={t('welcome.welcomeSecondaryButton')}
                    subtitle={t('welcome.welcomeSecondarySubtitle')}
                    iconName="qr-code"
                    onPress={handleLogin}
                />
            </View>
        );
    };

    // First-time visitors see the "Happier is the control room… your account is
    // a private key" explainer body. Returning users don't need it — they
    // already know what they're signing into — so we hide it for them.
    const shouldRenderPrivateKeyCopy = options.serverAvailability !== 'loading'
        && !showBlocked
        && options.showAuthActions
        && options.showAnonymousSignup
        && !isReturningUser;

    return (
        <View testID="welcome-decision-panel" style={styles.root}>
            {/*
              * The mobile wordmark is rendered by WorkflowPanel (absolutely
              * pinned to the top-left of the pane) so it stays anchored at the
              * top of the screen while the welcome content sits at the bottom
              * — same coordinates as the brand hero's wordmark so users see
              * the same logo position across both mobile screens.
              */}
            <View style={styles.headingBlock}>
                <Text accessibilityRole="header" style={styles.title}>
                    {isReturningUser ? returningGreeting.title : t('welcome.welcomeQuestionTitle')}
                </Text>
                <Text accessibilityRole="header" style={styles.subtitleTitle}>
                    {isReturningUser ? returningGreeting.subtitle : t('welcome.welcomeQuestionSubtitle')}
                </Text>
                {shouldRenderPrivateKeyCopy ? (
                    <Text testID="welcome-private-key-copy" style={styles.body}>
                        {t('welcome.welcomeQuestionBody')}
                    </Text>
                ) : null}
            </View>
            {options.showAuthActions && primaryAction === null ? (
                <Text testID="welcome-signup-disabled" style={[styles.statusText, styles.signupDisabledNotice]}>
                    {t('errors.signupDisabled')}
                </Text>
            ) : null}
            {renderActions()}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        justifyContent: 'center',
        width: '100%',
        maxWidth: 520,
        alignSelf: 'center',
        gap: 30,
    },
    headingBlock: {
        // No vertical gap between the two title lines — matches the brand
        // tagline's `Start anywhere. / Continue everywhere.` rhythm, where
        // line-height == font-size and the lines sit flush against each other.
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        // line-height == font-size mirrors the brand tagline (48/48). At 44px
        // this gives the same tight, deliberate vertical spacing the planet
        // tagline uses on the left pane.
        lineHeight: 44,
        letterSpacing: -1.54,
        color: theme.colors.text.primary,
    },
    subtitleTitle: {
        ...Typography.default('semiBold'),
        fontSize: 44,
        lineHeight: 44,
        letterSpacing: -1.54,
        color: theme.colors.text.secondary,
    },
    body: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text.secondary,
        // The previous 8px relied on `headingBlock.gap: 10` for the question→body
        // breathing room. With the gap removed, bump this to 22 so the rhythm
        // matches the brand pane (tagline → sub-tagline gap is 22).
        marginTop: 22,
        maxWidth: 440,
    },
    actionStack: {
        gap: 12,
        width: '100%',
    },
    decisionButton: {
        minHeight: 66,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 18,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
    },
    decisionTextBlock: {
        flex: 1,
        gap: 0,
    },
    decisionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
    },
    decisionSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
    },
    statusBlock: {
        width: '100%',
        gap: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    statusTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        lineHeight: 22,
        color: theme.colors.text.primary,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    signupDisabledNotice: {
        textAlign: 'center',
        maxWidth: 440,
        alignSelf: 'center',
    },
    statusActions: {
        gap: 10,
        marginTop: 6,
    },
}));
