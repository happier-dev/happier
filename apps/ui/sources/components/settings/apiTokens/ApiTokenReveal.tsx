import * as React from 'react';
import { Animated, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens, slideTransitionTokens } from '@/components/ui/motion';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

/**
 * The shown-once API token reveal: success, the secret with Copy, and the warning, staged in, then
 * Done. One presentation for every place that mints a root token (API tokens, Settings → Embeds);
 * the reveal's lifecycle (acknowledge, dismiss guard, clearing the secret) stays in
 * `apiTokenSettingsController`.
 */

const stepMotion = slideTransitionTokens.routine.timed;

/**
 * Starts an entrance that always ends at rest. A JS-driven Animated value stops for good when the view
 * it drives detaches mid-run (a frozen or re-suspended screen, a modal re-presented on a resize), and
 * the stopped stagger left the reveal at opacity 0 for as long as it stayed open. Anything that
 * interrupts the entrance other than its own cleanup settles it at its resting state instead.
 */
function startEntrance(animation: Animated.CompositeAnimation, settle: () => void): () => void {
    let cleanedUp = false;
    animation.start((result) => {
        if (result?.finished !== true && !cleanedUp) settle();
    });
    return () => {
        cleanedUp = true;
        animation.stop();
    };
}

const stylesheet = StyleSheet.create((theme) => ({
    error: {
        color: theme.colors.state.danger.textForeground,
        ...Typography.variant('body'),
    },
    revealHero: {
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: theme.space.s4,
    },
    revealTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('title'),
        textAlign: 'center',
    },
    revealBody: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    secretSurface: {
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 12,
        padding: theme.space.s12,
        gap: theme.space.s10,
    },
    // Copy (and a domain's secondary copy) side by side under the secret, each half the surface.
    secretActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    secretAction: {
        flexGrow: 1,
        flexBasis: 160,
    },
    secret: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 19,
    },
}));

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
        const stopEntrance = startEntrance(animation, () => progress.setValue(1));
        return () => {
            clearTimeout(revealTimer);
            stopEntrance();
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
            const stopEntrance = startEntrance(animation, () => reducedOpacity.setValue(1));
            return () => {
                stopEntrance();
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
        const stopEntrance = startEntrance(animation, () => stageProgresses.forEach((progress) => progress.setValue(1)));
        return () => {
            stopEntrance();
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
    /** A domain's wording for the one-time warning and Copy (an embed's key); defaults to the token's. */
    copy?: Readonly<{ shownOnce: string; copy: string; successTitle?: string | null }>;
    /** A secondary copy action beside Copy, inside the secret surface (an embed's ".env line"). */
    accessory?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const copyFeedback = useHappierCopyFeedback(1_500);
    const [copyError, setCopyError] = React.useState(false);
    const { onCopied, token } = props;
    const writeClipboard = useClipboardWrite();
    const copied = copyFeedback.isCopied('token');
    const copyLabel = copied ? t('settingsApiTokens.reveal.copied') : props.copy?.copy ?? t('settingsApiTokens.reveal.copy');

    // The shared button owns the in-flight (busy) state and same-tick reentry while the clipboard
    // write settles; only a real copy acknowledges the reveal.
    const copy = React.useCallback(async () => {
        setCopyError(false);
        const didCopy = await writeClipboard(token);
        setCopyError(!didCopy);
        if (!didCopy) return;
        onCopied();
        copyFeedback.markCopied('token');
        announceAccessibilityMessage(t('settingsApiTokens.reveal.copied'));
    }, [copyFeedback, onCopied, token, writeClipboard]);

    return (
        <ApiTokenRevealStages
            revealKey={token}
            reducedMotion={props.reducedMotion}
            success={(
                <View style={styles.revealHero}>
                    <Icon name="check-circle" size={34} color={theme.colors.state.success.foreground} />
                    {/* A domain whose band already names what is ready (an embed) shows only the mark. */}
                    {props.copy && props.copy.successTitle === undefined ? null : (
                        <Text style={styles.revealTitle}>{props.copy?.successTitle ?? t('settingsApiTokens.reveal.successTitle')}</Text>
                    )}
                </View>
            )}
            warning={<Text style={styles.revealBody}>{props.copy?.shownOnce ?? t('settingsApiTokens.reveal.shownOnce')}</Text>}
            secret={(
                <View style={styles.secretSurface}>
                    <Text selectable testID="settings-api-tokens-reveal-secret" style={styles.secret}>{token}</Text>
                    {/* A pair shares one geometry: a filled Copy and its bordered sibling stand at the same height. */}
                    <RoundButtonSizeScope size="normal" presentation={props.accessory ? 'uniform' : 'contextual'}>
                        <View style={styles.secretActions}>
                            <View style={styles.secretAction}>
                                <RoundButton
                                    testID="settings-api-tokens-reveal-copy"
                                    size="normal"
                                    display={props.accessory ? 'default' : 'secondary'}
                                    title={copyLabel}
                                    accessibilityLabel={copyLabel}
                                    leading={<Icon name={copied ? 'check' : 'copy'} size={18} color={props.accessory ? theme.colors.button.primary.tint : theme.colors.text.primary} />}
                                    action={copy}
                                />
                            </View>
                            {props.accessory ? <View style={styles.secretAction}>{props.accessory}</View> : null}
                        </View>
                    </RoundButtonSizeScope>
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
