import * as React from 'react';
import { Animated, Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { motionTokens, StepTransitionFrame, stepTransitionTokens } from '@/components/ui/motion';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import type { ApiTokenExpiryPreset, ApiTokenSettingsController } from './apiTokenSettingsController';
import { resolveApiTokenOperationErrorMessageKey } from './apiTokenSettingsPresentation';
import { useApiTokenSettingsControllerState } from './useApiTokenSettingsControllerState';

const EXPIRY_PRESETS: readonly ApiTokenExpiryPreset[] = ['30d', '90d', '1y', 'none'];

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 24,
        gap: 18,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        marginBottom: 8,
    },
    input: {
        ...Typography.default(),
        minHeight: Platform.OS === 'android' ? 48 : 44,
        color: theme.colors.text.primary,
        backgroundColor: theme.colors.input.background,
        borderColor: theme.colors.border.default,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    presets: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    preset: {
        minHeight: Platform.OS === 'android' ? 48 : 44,
        minWidth: Platform.OS === 'android' ? 48 : 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        paddingHorizontal: 14,
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.border.default,
        borderWidth: 1,
    },
    presetSelected: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.colors.border.strong,
    },
    presetText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    presetTextSelected: {
        color: theme.colors.text.primary,
    },
    guidanceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 4,
    },
    guidanceText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 19,
    },
    actionSettingsLink: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
        borderRadius: 8,
    },
    webFocusRing: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        })),
    },
    link: {
        color: theme.colors.text.link,
        textDecorationLine: 'underline',
    },
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

function ApiTokenRevealDone(props: Readonly<{
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
            duration: stepTransitionTokens.durationMs.enter,
            easing: stepTransitionTokens.easing,
            useNativeDriver: true,
        });
        const revealTimer = setTimeout(
            () => setRevealed(true),
            motionTokens.durationMs.fast * 3 + stepTransitionTokens.durationMs.enter,
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
                        outputRange: [stepTransitionTokens.translatePx, 0],
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
                duration: stepTransitionTokens.durationMs.enter,
                easing: stepTransitionTokens.easing,
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
                duration: stepTransitionTokens.durationMs.enter,
                easing: stepTransitionTokens.easing,
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
                outputRange: [stepTransitionTokens.translatePx, 0],
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

export function ApiTokenCreateModal(props: Readonly<{
    controller: ApiTokenSettingsController;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const state = useApiTokenSettingsControllerState(props.controller);
    const copyFeedback = useTemporaryCopyFeedback(1_500);
    const [copyError, setCopyError] = React.useState(false);
    const reveal = state.reveal;
    const reducedMotion = useReducedMotionPreference();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    React.useEffect(() => {
        if (!reveal) return;
        announceAccessibilityMessage(t('settingsApiTokens.reveal.accessibilityAnnouncement'));
    }, [reveal?.token]);

    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 16, paddingVertical: 12, gap: 10 }}>
            {reveal ? (
                <ApiTokenRevealDone
                    revealKey={reveal.token}
                    reducedMotion={reducedMotion}
                    onClose={props.onClose}
                />
            ) : (
                <>
                    <RoundButton
                        size="normal"
                        display="inverted"
                        title={t('common.cancel')}
                        disabled={state.createPending}
                        onPress={props.onClose}
                    />
                    <RoundButton
                        size="normal"
                        title={t('settingsApiTokens.create.submit')}
                        testID="settings-api-tokens-create-submit"
                        disabled={!state.createDraft.label.trim() || state.createPending}
                        loading={state.createPending}
                        action={props.controller.createToken}
                    />
                </>
            )}
        </View>
    ), [props.controller, props.onClose, reducedMotion, reveal, state.createDraft.label, state.createPending]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: reveal ? t('settingsApiTokens.reveal.title') : t('settingsApiTokens.create.title'),
        subtitle: reveal ? t('settingsApiTokens.reveal.accessibilityAnnouncement') : t('settingsApiTokens.create.subtitle'),
        testID: 'settings-api-tokens-create-modal',
        closeButtonTestID: 'settings-api-tokens-create-close',
        dimensions: { width: 600, maxHeightRatio: 0.9, size: 'md' as const },
        footer,
    }), [footer, reveal]));

    const copy = React.useCallback(async () => {
        if (!reveal) return;
        const copied = await setClipboardStringSafe(reveal.token);
        setCopyError(!copied);
        if (!copied) return;
        props.controller.acknowledgeReveal();
        copyFeedback.markCopied('token');
    }, [copyFeedback, props.controller, reveal]);

    return (
        <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
            contentContainerStyle={styles.body}
        >
            <StepTransitionFrame
                transitionKey={reveal ? 'reveal' : 'create'}
                direction="replace"
                reducedMotion={reducedMotion}
                testID="settings-api-tokens-create-step"
            >
                {reveal ? (
                    <ApiTokenRevealStages
                        revealKey={reveal.token}
                        reducedMotion={reducedMotion}
                        success={(
                            <View style={styles.revealHero}>
                                <Icon name="check-circle" size={34} color={theme.colors.state.success.foreground} />
                                <Text style={styles.revealTitle}>{t('settingsApiTokens.reveal.successTitle')}</Text>
                            </View>
                        )}
                        warning={<Text style={styles.revealBody}>{t('settingsApiTokens.reveal.shownOnce')}</Text>}
                        secret={(
                            <View style={styles.secretSurface}>
                                <Text selectable testID="settings-api-tokens-reveal-secret" style={styles.secret}>{reveal.token}</Text>
                                <Pressable
                                    testID="settings-api-tokens-reveal-copy"
                                    accessibilityRole="button"
                                    accessibilityLabel={copyFeedback.isCopied('token')
                                        ? t('settingsApiTokens.reveal.copied')
                                        : t('settingsApiTokens.reveal.copy')}
                                    accessibilityLiveRegion="polite"
                                    focusable
                                    onPress={copy}
                                    style={(interactionState) => {
                                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                                        return [
                                            styles.copyRow,
                                            webState.focused === true ? styles.webFocusRing : null,
                                            { opacity: interactionState.pressed ? 0.7 : 1 },
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
                ) : (
                    <View style={{ gap: 18 }}>
                        <View>
                            <Text style={styles.label}>{t('settingsApiTokens.create.label')}</Text>
                            <TextInput
                                testID="settings-api-tokens-create-label"
                                accessibilityLabel={t('settingsApiTokens.create.label')}
                                autoFocus
                                maxLength={256}
                                value={state.createDraft.label}
                                placeholder={t('settingsApiTokens.create.labelPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                editable={!state.createPending}
                                onChangeText={(label) => props.controller.setCreateDraft({ ...state.createDraft, label })}
                                style={styles.input}
                                returnKeyType="done"
                                onSubmitEditing={() => {
                                    if (state.createDraft.label.trim() && !state.createPending) void props.controller.createToken();
                                }}
                            />
                        </View>
                        <View>
                            <Text style={styles.label}>{t('settingsApiTokens.create.expiry')}</Text>
                            <View style={styles.presets} accessibilityRole="radiogroup">
                                {EXPIRY_PRESETS.map((preset) => {
                                    const selected = state.createDraft.expiryPreset === preset;
                                    return (
                                        <Pressable
                                            key={preset}
                                            testID={`settings-api-tokens-expiry-${preset}`}
                                            accessibilityRole="radio"
                                            accessibilityState={{ checked: selected, disabled: state.createPending }}
                                            aria-checked={Platform.OS === 'web' ? selected : undefined}
                                            disabled={state.createPending}
                                            onPress={() => props.controller.setCreateDraft({ ...state.createDraft, expiryPreset: preset })}
                                            style={(interactionState) => {
                                                const webState = interactionState as typeof interactionState & { focused?: boolean };
                                                return [
                                                    styles.preset,
                                                    selected ? styles.presetSelected : null,
                                                    webState.focused === true ? styles.webFocusRing : null,
                                                    { opacity: interactionState.pressed ? 0.7 : 1 },
                                                ];
                                            }}
                                        >
                                            <Text style={[styles.presetText, selected ? styles.presetTextSelected : null]}>
                                                {t(`settingsApiTokens.create.expiryOptions.${preset}`)}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        </View>
                        <View style={styles.guidanceRow}>
                            <Text style={styles.guidanceText}>{t('settingsApiTokens.create.actionSettingsPrefix')}</Text>
                            <Pressable
                                testID="settings-api-tokens-action-settings"
                                accessibilityRole="link"
                                accessibilityLabel={t('settingsApiTokens.create.actionSettingsLink')}
                                accessibilityState={{ disabled: state.createPending }}
                                focusable
                                disabled={state.createPending}
                                onPress={() => {
                                    props.onClose();
                                    router.push('/settings/actions');
                                }}
                                style={(interactionState) => {
                                    const webState = interactionState as typeof interactionState & { focused?: boolean };
                                    return [
                                        styles.actionSettingsLink,
                                        {
                                            minWidth: minimumInteractiveTargetSize,
                                            minHeight: minimumInteractiveTargetSize,
                                        },
                                        webState.focused === true ? styles.webFocusRing : null,
                                        { opacity: interactionState.pressed ? 0.7 : 1 },
                                    ];
                                }}
                            >
                                <Text style={styles.link}>{t('settingsApiTokens.create.actionSettingsLink')}</Text>
                            </Pressable>
                        </View>
                        {state.createError ? (
                            <Text accessibilityLiveRegion="assertive" style={styles.error} testID="settings-api-tokens-create-error">
                                {t(resolveApiTokenOperationErrorMessageKey(state.createError))}
                            </Text>
                        ) : null}
                    </View>
                )}
            </StepTransitionFrame>
        </ScrollView>
    );
}
