import * as React from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveHappierFocusRingVisible } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens, slideTransitionTokens } from '@/components/ui/motion';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

/**
 * The shown-once API token reveal: success, the secret with Copy, and the warning, staged in, then
 * Done. One presentation for every place that mints a root token (API tokens, Settings → Embeds);
 * the reveal's lifecycle (acknowledge, dismiss guard, clearing the secret) stays in
 * `apiTokenSettingsController`.
 */

const stepMotion = slideTransitionTokens.routine.timed;

const stylesheet = StyleSheet.create((theme) => ({
    error: {
        ...Typography.default(),
        color: theme.colors.state.danger.foreground,
        fontSize: 13,
        lineHeight: 18,
    },
    revealHero: {
        alignItems: 'center',
        gap: 8,
        paddingTop: 4,
    },
    revealTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 22,
        lineHeight: 28,
        textAlign: 'center',
    },
    revealBody: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 20,
    },
    secretSurface: {
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 12,
        padding: 12,
        gap: 10,
    },
    secret: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 19,
    },
    copyRow: {
        minHeight: Platform.OS === 'android' ? 48 : 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderRadius: 10,
        backgroundColor: theme.colors.button.secondary.background,
    },
    copyText: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    copyFeedbackContent: {
        position: 'relative',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    copyFeedbackLayer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
    },
    copyFeedbackOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
}));

function ApiTokenCopyFeedbackContent(props: Readonly<{
    copied: boolean;
    color: string;
}>) {
    const styles = stylesheet;
    const progress = React.useRef(new Animated.Value(props.copied ? 1 : 0)).current;

    React.useEffect(() => {
        const animation = Animated.timing(progress, {
            toValue: props.copied ? 1 : 0,
            duration: motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: true,
        });
        animation.start();
        return () => animation.stop();
    }, [progress, props.copied]);

    const hiddenFromAccessibility = {
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
    };

    return (
        <View style={styles.copyFeedbackContent}>
            <Animated.View
                {...hiddenFromAccessibility}
                style={[styles.copyFeedbackLayer, {
                    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                }]}
            >
                <Icon name="copy" size={18} color={props.color} />
                <Text style={styles.copyText}>{t('settingsApiTokens.reveal.copy')}</Text>
            </Animated.View>
            <Animated.View
                {...hiddenFromAccessibility}
                style={[styles.copyFeedbackLayer, styles.copyFeedbackOverlay, { opacity: progress }]}
            >
                <Icon name="check" size={18} color={props.color} />
                <Text style={styles.copyText}>{t('settingsApiTokens.reveal.copied')}</Text>
            </Animated.View>
        </View>
    );
}

export function ApiTokenRevealDone(props: Readonly<{
    revealKey: string;
    reducedMotion: boolean;
    onClose: () => void;
}>) {
    const progress = React.useRef(new Animated.Value(props.reducedMotion ? 1 : 0)).current;
    const [revealed, setRevealed] = React.useState(props.reducedMotion);

    React.useEffect(() => {
        if (props.reducedMotion) {
            progress.setValue(1);
            setRevealed(true);
            return;
        }
        progress.setValue(0);
        setRevealed(false);
        const animation = Animated.timing(progress, {
            toValue: 1,
            delay: motionTokens.durationMs.fast * 3,
            duration: stepMotion.durationMs.enter,
            easing: stepMotion.easing,
            useNativeDriver: true,
        });
        const revealTimer = setTimeout(
            () => setRevealed(true),
            motionTokens.durationMs.fast * 3 + stepMotion.durationMs.enter,
        );
        animation.start();
        return () => {
            clearTimeout(revealTimer);
            animation.stop();
        };
    }, [progress, props.reducedMotion, props.revealKey]);

    return (
        <Animated.View
            testID="settings-api-tokens-reveal-stage-done"
            pointerEvents={revealed ? 'auto' : 'none'}
            accessibilityElementsHidden={!revealed}
            importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}
            style={{
                opacity: progress,
                transform: props.reducedMotion ? [] : [{
                    translateY: progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [stepMotion.translatePx, 0],
                    }),
                }],
            }}
        >
            <RoundButton
                size="normal"
                title={t('common.done')}
                testID="settings-api-tokens-reveal-done"
                disabled={!revealed}
                onPress={props.onClose}
            />
        </Animated.View>
    );
}

function ApiTokenRevealStages(props: Readonly<{
    revealKey: string;
    reducedMotion: boolean;
    success: React.ReactNode;
    warning: React.ReactNode;
    secret: React.ReactNode;
}>) {
    const successProgress = React.useRef(new Animated.Value(props.reducedMotion ? 1 : 0)).current;
    const warningProgress = React.useRef(new Animated.Value(props.reducedMotion ? 1 : 0)).current;
    const secretProgress = React.useRef(new Animated.Value(props.reducedMotion ? 1 : 0)).current;
    const reducedOpacity = React.useRef(new Animated.Value(props.reducedMotion ? 0 : 1)).current;
    const activeAnimationRef = React.useRef<Animated.CompositeAnimation | null>(null);

    React.useEffect(() => {
        activeAnimationRef.current?.stop();
        const stageProgresses = [successProgress, secretProgress, warningProgress];

        if (props.reducedMotion) {
            stageProgresses.forEach((progress) => progress.setValue(1));
            reducedOpacity.setValue(0);
            const animation = Animated.timing(reducedOpacity, {
                toValue: 1,
                duration: stepMotion.durationMs.enter,
                easing: stepMotion.easing,
                useNativeDriver: true,
            });
            activeAnimationRef.current = animation;
            animation.start();
            return () => {
                animation.stop();
                if (activeAnimationRef.current === animation) activeAnimationRef.current = null;
            };
        }

        reducedOpacity.setValue(1);
        stageProgresses.forEach((progress) => progress.setValue(0));
        const animation = Animated.stagger(
            motionTokens.durationMs.fast,
            stageProgresses.map((progress) => Animated.timing(progress, {
                toValue: 1,
                duration: stepMotion.durationMs.enter,
                easing: stepMotion.easing,
                useNativeDriver: true,
            })),
        );
        activeAnimationRef.current = animation;
        animation.start();
        return () => {
            animation.stop();
            if (activeAnimationRef.current === animation) activeAnimationRef.current = null;
        };
    }, [props.reducedMotion, props.revealKey, reducedOpacity, secretProgress, successProgress, warningProgress]);

    if (props.reducedMotion) {
        return (
            <Animated.View testID="settings-api-tokens-reveal-reduced-fade" style={{ gap: 18, opacity: reducedOpacity }}>
                {props.success}
                {props.secret}
                {props.warning}
            </Animated.View>
        );
    }

    const stageStyle = (progress: Animated.Value) => ({
        opacity: progress,
        transform: [{
            translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [stepMotion.translatePx, 0],
            }),
        }],
    });

    return (
        <View testID="settings-api-tokens-reveal-stages" style={{ gap: 18 }}>
            <Animated.View testID="settings-api-tokens-reveal-stage-success" style={stageStyle(successProgress)}>
                {props.success}
            </Animated.View>
            <Animated.View testID="settings-api-tokens-reveal-stage-secret" style={stageStyle(secretProgress)}>
                {props.secret}
            </Animated.View>
            <Animated.View testID="settings-api-tokens-reveal-stage-warning" style={stageStyle(warningProgress)}>
                {props.warning}
            </Animated.View>
        </View>
    );
}

/** The staged reveal body. `onCopied` runs once the secret is really on the clipboard. */
export function ApiTokenRevealBody(props: Readonly<{
    token: string;
    reducedMotion: boolean;
    onCopied: () => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const copyFeedback = useTemporaryCopyFeedback(1_500);
    const [copyError, setCopyError] = React.useState(false);
    const [copyPending, setCopyPending] = React.useState(false);
    const copyPendingRef = React.useRef(false);
    const { onCopied, token } = props;

    const copy = React.useCallback(async () => {
        if (copyPendingRef.current) return;
        copyPendingRef.current = true;
        setCopyPending(true);
        setCopyError(false);
        try {
            const copied = await setClipboardStringSafe(token);
            setCopyError(!copied);
            if (!copied) return;
            onCopied();
            copyFeedback.markCopied('token');
        } finally {
            copyPendingRef.current = false;
            setCopyPending(false);
        }
    }, [copyFeedback, onCopied, token]);

    return (
        <ApiTokenRevealStages
            revealKey={token}
            reducedMotion={props.reducedMotion}
            success={(
                <View style={styles.revealHero}>
                    <Icon name="check-circle" size={34} color={theme.colors.state.success.foreground} />
                    <Text style={styles.revealTitle}>{t('settingsApiTokens.reveal.successTitle')}</Text>
                </View>
            )}
            warning={<Text style={styles.revealBody}>{t('settingsApiTokens.reveal.shownOnce')}</Text>}
            secret={(
                <View style={styles.secretSurface}>
                    <Text selectable testID="settings-api-tokens-reveal-secret" style={styles.secret}>{token}</Text>
                    <Pressable
                        testID="settings-api-tokens-reveal-copy"
                        accessibilityRole="button"
                        accessibilityLabel={copyFeedback.isCopied('token')
                            ? t('settingsApiTokens.reveal.copied')
                            : t('settingsApiTokens.reveal.copy')}
                        accessibilityState={{ disabled: copyPending, busy: copyPending }}
                        accessibilityLiveRegion="polite"
                        focusable
                        disabled={copyPending}
                        onPress={copy}
                        style={(interactionState) => {
                            const webState = interactionState as typeof interactionState & { focused?: boolean };
                            return [
                                styles.copyRow,
                                focusRingStyle({ focused: resolveHappierFocusRingVisible(webState.focused), color: theme.colors.border.focus }),
                                { opacity: interactionState.pressed ? motionTokens.press.opacity : 1 },
                            ];
                        }}
                    >
                        <ApiTokenCopyFeedbackContent
                            copied={copyFeedback.isCopied('token')}
                            color={theme.colors.button.secondary.tint}
                        />
                    </Pressable>
                    {copyError ? (
                        <Text accessibilityLiveRegion="assertive" style={styles.error} testID="settings-api-tokens-copy-error">
                            {t('settingsApiTokens.errors.copyFailed')}
                        </Text>
                    ) : null}
                </View>
            )}
        />
    );
}
