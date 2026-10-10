import * as React from 'react';
import { Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { PLANET_PALETTES, planetLightForProgress } from '@happier-dev/brand/planet';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { useSetupBlockPanelWidth } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupSteps, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { Text } from '@/components/ui/text/Text';
import { VoiceMarkArt, type VoiceMarkEvent } from '@/components/voice/presence/VoiceMark';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { VoiceServiceGallery, type VoiceServiceTile } from '@/voice/settings/panels/VoiceServiceGallery';

import type { VoiceSetupFacts } from './voiceSetupFacts';
import { isVoiceSetupFailed, readVoiceSetupLight } from './voiceSetupPresentation';

/** Below this width the planet sits above the steps (lab SBp) instead of beside them (SB). */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 600;
const PLANET_SIDE_PX = 168;
const PLANET_STACKED_PX = 96;
const PLANET_COLUMN_PX = 200;

/** What the open block shows. Every fact is derived by its owner; the panel only lays it out. */
export type VoiceSetupPanelModel = Readonly<{
    /** m-core's facts: each step's state (done · current · upcoming · blocked · working) and the counts. */
    facts: VoiceSetupFacts;
    /** The chosen service's name (step 1 done), or null while none is chosen. */
    serviceTitle: string | null;
    serviceTiles: readonly VoiceServiceTile[];
    /** The readiness owner's reason and recovery wording, localized; null while it is unknown. */
    readiness: Readonly<{ reason: string | null; action: string | null }> | null;
    /** True while the person's first try is running: the try step shows the live status and heard words. */
    tryLive: boolean;
    /** The first genuine turn completed setup here: the planet's dots gather once (lab SD). */
    firstSuccess?: VoiceMarkEvent | null;
    /** The resolved `voice.toggle` binding (rebindable), or null where there is no keyboard. */
    shortcutLabel: string | null;
}>;

export type VoiceSetupPanelActions = Readonly<{
    onSelectService: (serviceId: string) => void;
    onRecover: () => void;
    onAllowMicrophone: () => void;
    /** Null where the platform has no settings deep link (web). */
    onOpenSystemSettings: (() => void) | null;
    onTry: () => void;
    onDone: () => void;
    onOpenSettings: () => void;
    onClose: () => void;
}>;

/**
 * "Set up voice" grown in place (lab `voice-moments` SB–SD): the Daybreak planet whose Light is how
 * many steps are really done, beside the four steps in the one numbered-step anatomy (`SetupSteps`).
 * A step that is already true is drawn done and never asked; only the current step asks for
 * something. Nothing here acquires the microphone, starts a provider or downloads: each action is a
 * press, routed to the owner that does it. `renderTry` is the live try (status and heard words).
 */
export const VoiceSetupPanel = React.memo(function VoiceSetupPanel(props: Readonly<{
    testID: string;
    model: VoiceSetupPanelModel;
    actions: VoiceSetupPanelActions;
    renderTry?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const hinted = useSetupBlockPanelWidth();
    const [width, setWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.width;
        if (Number.isFinite(next) && next > 0) setWidth((current) => (current === next ? current : next));
    }, []);
    const laidOut = width ?? hinted ?? SIDE_BY_SIDE_MIN_WIDTH_PX;
    const sideBySide = laidOut >= SIDE_BY_SIDE_MIN_WIDTH_PX;
    const { model, actions } = props;
    const { facts } = model;
    const complete = facts.complete;
    const [changingService, setChangingService] = React.useState(false);

    const failed = isVoiceSetupFailed(facts);
    const lightProgress = readVoiceSetupLight(facts);
    const light = React.useMemo(() => planetLightForProgress(lightProgress), [lightProgress]);
    // One message per state: once ready, the title says so; the count only speaks during the steps.
    const caption = complete ? null : t('voiceMoments.setupLightCaption', { done: facts.doneCount, total: facts.total });
    const daybreak = useDaybreakWash();

    const steps = React.useMemo(
        () => facts.steps.map((step) => buildStep(step, model, actions, {
            changingService,
            onChangeService: () => setChangingService(true),
            onServiceChosen: (id: string) => {
                setChangingService(false);
                actions.onSelectService(id);
            },
            renderTry: props.renderTry,
            sideBySide,
        })),
        [actions, changingService, facts.steps, model, props.renderTry, sideBySide],
    );

    return (
        <View testID={props.testID} onLayout={onLayout} style={[styles.root, sideBySide ? null : styles.rootStacked]} accessibilityLabel={t('voiceMoments.setupTitle')}>
            <View style={sideBySide ? styles.sideBySide : styles.stacked}>
                <View style={sideBySide ? [styles.visualSide, daybreak] : styles.visualStacked}>
                    <VoiceMarkArt
                        pose={failed ? 'shade' : 'ready'}
                        light={light}
                        event={model.firstSuccess}
                        // One planet moves at a time: while the first try runs, the live Voice presence
                        // carries the atmosphere, so the setup planet keeps its readiness light, still.
                        still
                        size={sideBySide ? PLANET_SIDE_PX : PLANET_STACKED_PX}
                        testID={`${props.testID}.planet`}
                    />
                    {caption ? <Text testID={`${props.testID}.caption`} style={styles.caption}>{caption}</Text> : null}
                </View>
                <View style={styles.body}>
                    <Text accessibilityRole="header" style={styles.title}>
                        {complete ? t('voiceMoments.setupDoneTitle') : t('voiceMoments.setupTitle')}
                    </Text>
                    <Text style={styles.description}>
                        {complete ? t('voiceMoments.setupDoneBody') : t('voiceMoments.setupDescription')}
                    </Text>
                    {complete ? (
                        <>
                            <View style={styles.gestures}>
                                <GestureHint keyLabel={t('voiceMoments.setupGestureTap')} meaning={t('voiceMoments.setupGestureStartEnd')} />
                                {model.shortcutLabel ? (
                                    <GestureHint keyLabel={model.shortcutLabel} meaning={t('voiceMoments.setupGestureAnywhere')} />
                                ) : null}
                            </View>
                            <View style={styles.footer}>
                                <RoundButton
                                    testID={`${props.testID}.done`}
                                    size="small"
                                    title={t('voiceMoments.setupDoneAction')}
                                    onPress={actions.onDone}
                                />
                                <RoundButton
                                    testID={`${props.testID}.settings`}
                                    size="small"
                                    display="secondary"
                                    title={t('voiceMoments.setupSettingsAction')}
                                    onPress={actions.onOpenSettings}
                                />
                            </View>
                        </>
                    ) : (
                        <View style={styles.steps}>
                            <SetupSteps testID={`${props.testID}.steps`} steps={steps} />
                        </View>
                    )}
                </View>
            </View>
            <View style={styles.close}>
                <IconButton
                    testID={`${props.testID}.close`}
                    iconName="x"
                    variant="plain"
                    size={24}
                    iconSize={13}
                    accessibilityLabel={t('voiceMoments.setupClose')}
                    tooltip={t('voiceMoments.setupClose')}
                    onPress={actions.onClose}
                />
            </View>
        </View>
    );
});

type StepContext = Readonly<{
    changingService: boolean;
    onChangeService: () => void;
    onServiceChosen: (id: string) => void;
    renderTry: React.ReactNode;
    sideBySide: boolean;
}>;

/** SetupSteps draws done · current · upcoming; blocked and working are the current step's two moods. */
function stepMarker(state: VoiceSetupFacts['steps'][number]['state']): 'done' | 'current' | 'upcoming' {
    return state === 'done' || state === 'upcoming' ? state : 'current';
}

function buildStep(
    step: VoiceSetupFacts['steps'][number],
    model: VoiceSetupPanelModel,
    actions: VoiceSetupPanelActions,
    context: StepContext,
): SetupStep {
    const testID = `voice-setup.step.${step.id}`;
    const service = model.serviceTitle ?? t('voiceMoments.setupReadinessGeneric');
    switch (step.id) {
        case 'service': {
            const choosing = stepMarker(step.state) === 'current' || context.changingService;
            if (choosing) {
                return {
                    key: step.id,
                    testID,
                    state: 'current',
                    title: t('voiceMoments.setupServiceTitle'),
                    detail: t('voiceMoments.setupServiceDetail'),
                    body: (
                        <View style={stylesheet.gallery}>
                            <VoiceServiceGallery
                                tiles={model.serviceTiles}
                                offSelected={false}
                                presentation="setup"
                                onSelect={context.onServiceChosen}
                                onSelectOff={() => {}}
                            />
                        </View>
                    ),
                };
            }
            if (step.state !== 'done') {
                return { key: step.id, testID, state: stepMarker(step.state), title: t('voiceMoments.setupServiceTitle') };
            }
            // Done collapses to one line: the chosen service, what it uses, and Change (lab SC).
            const chosen = model.serviceTiles.find((tile) => tile.selected);
            return {
                key: step.id,
                testID,
                state: 'done',
                title: (
                    <View>
                        <Text style={stylesheet.doneTitle}>
                            {model.serviceTitle ?? t('voiceMoments.setupServiceTitle')}
                        </Text>
                        <Text style={stylesheet.doneDetail}>
                        {chosen?.subtitle ? `${chosen.subtitle} · ` : ''}
                        <Text
                            testID={`${testID}.change`}
                            accessibilityRole="button"
                            onPress={context.onChangeService}
                            style={stylesheet.inlineLink}
                        >
                            {t('voiceMoments.setupChange')}
                        </Text>
                    </Text>
                    </View>
                ),
            };
        }
        case 'readiness': {
            if (step.state === 'done') return { key: step.id, testID, state: 'done', title: t('voiceMoments.setupReadinessDone', { service }) };
            const current = stepMarker(step.state) === 'current';
            const reason = model.readiness?.reason ?? (current ? t('voiceMoments.setupReadinessUnknown') : undefined);
            const action = model.readiness?.action ?? t('voiceMoments.setupReadinessCheck');
            return {
                key: step.id,
                testID,
                state: stepMarker(step.state),
                title: model.serviceTitle
                    ? t('voiceMoments.setupReadinessTitle', { service: model.serviceTitle })
                    : t('voiceMoments.setupReadinessTitleGeneric'),
                detail: current ? reason : undefined,
                // An install keeps going on its own owner; the step finishes by itself when it does.
                body: current && step.state !== 'working' ? (
                    <RoundButton testID={`${testID}.recover`} size="small" title={action} onPress={actions.onRecover} />
                ) : undefined,
            };
        }
        case 'microphone': {
            if (step.state === 'done') return { key: step.id, testID, state: 'done', title: t('voiceMoments.setupMicrophoneDone') };
            const denied = step.state === 'blocked';
            const current = stepMarker(step.state) === 'current';
            return {
                key: step.id,
                testID,
                state: stepMarker(step.state),
                title: denied ? t('voiceMoments.setupMicrophoneDeniedTitle') : t('voiceMoments.setupMicrophoneTitle'),
                detail: current ? (denied ? t('voiceMoments.setupMicrophoneDeniedDetail') : t('voiceMoments.setupMicrophoneDetail')) : undefined,
                body: !current ? undefined : denied ? (
                    actions.onOpenSystemSettings ? (
                        <RoundButton
                            testID={`${testID}.openSettings`}
                            size="small"
                            title={t('voiceMoments.setupOpenSystemSettings')}
                            onPress={actions.onOpenSystemSettings}
                        />
                    ) : undefined
                ) : (
                    <RoundButton
                        testID={`${testID}.allow`}
                        size="small"
                        leading={<MicGlyph />}
                        title={t('voiceMoments.setupMicrophoneAction')}
                        onPress={actions.onAllowMicrophone}
                    />
                ),
            };
        }
        case 'first_turn': {
            if (step.state === 'done') return { key: step.id, testID, state: 'done', title: t('voiceMoments.setupTryDone') };
            const current = stepMarker(step.state) === 'current';
            return {
                key: step.id,
                testID,
                state: stepMarker(step.state),
                title: t('voiceMoments.setupTryTitle'),
                detail: current ? (model.facts.canTry ? t('voiceMoments.setupTryDetail') : t('voiceMoments.setupTryNeedsService')) : undefined,
                body: current ? (
                    model.tryLive && context.renderTry ? context.renderTry : (
                        <RoundButton
                            testID={`${testID}.try`}
                            size="small"
                            title={t('voiceMoments.setupTryAction')}
                            disabled={!model.facts.canTry}
                            onPress={actions.onTry}
                        />
                    )
                ) : undefined,
            };
        }
    }
}

/**
 * The planet's daybreak (lab SB–SD): Brand's Horizon material — its sky with the atmosphere rising
 * behind the disc — as the planet column's field, the same material the onboarding stage uses.
 * Native draws the sky's base colour; the layered gradients are web CSS.
 */
function useDaybreakWash(): ViewStyle {
    const { theme } = useUnistyles();
    const horizon = PLANET_PALETTES[(theme as { dark?: boolean }).dark ? 'dark' : 'light'].horizon;
    return React.useMemo(() => ({
        backgroundColor: horizon.backgroundColor,
        ...(Platform.OS === 'web'
            ? { backgroundImage: `radial-gradient(circle at 50% 42%, ${horizon.atmosphereColor} 0%, ${horizon.backgroundColorTransparent} 62%), ${horizon.skyGradient}` }
            : null),
    }) as ViewStyle, [horizon]);
}

function MicGlyph() {
    const { theme } = useUnistyles();
    return <Icon name="microphone" size={14} color={theme.colors.button.primary.tint} />;
}

/** "Tap · start · end": the key in the text's own weight, its meaning quieter. */
function GestureHint(props: Readonly<{ keyLabel: string; meaning: string }>) {
    const styles = stylesheet;
    return (
        <View style={styles.gesture}>
            <View style={styles.key}>
                <Text style={styles.keyLabel}>{props.keyLabel}</Text>
            </View>
            <Text style={styles.gestureMeaning}>{props.meaning}</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        position: 'relative',
        paddingTop: 22,
        paddingBottom: 22,
        paddingLeft: 22,
        paddingRight: 24,
    },
    // Phone (lab SBp): the panel's own gutter tightens to the page's.
    rootStacked: {
        paddingTop: 16,
        paddingBottom: 18,
        paddingLeft: 16,
        paddingRight: 16,
    },
    sideBySide: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 28,
    },
    stacked: {
        gap: 14,
    },
    visualSide: {
        width: PLANET_COLUMN_PX,
        alignSelf: 'stretch',
        alignItems: 'center',
        gap: 10,
        paddingTop: 18,
        paddingBottom: 18,
        borderRadius: 16,
        overflow: 'hidden',
    },
    visualStacked: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    caption: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    body: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        lineHeight: 24,
        letterSpacing: -0.2,
        color: theme.colors.text.primary,
        paddingRight: 28,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        marginTop: 5,
        maxWidth: 460,
        color: theme.colors.text.secondary,
    },
    steps: {
        marginTop: 16,
    },
    gallery: {
        alignSelf: 'stretch',
        flexGrow: 1,
        flexBasis: '100%',
    },
    doneTitle: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowTitle'),
        paddingTop: 1,
        color: theme.colors.text.secondary,
    },
    doneDetail: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: 2,
        color: theme.colors.text.secondary,
    },
    inlineLink: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
    gestures: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 18,
        marginTop: 14,
    },
    gesture: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    key: {
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 6,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.inset,
    },
    keyLabel: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
    },
    gestureMeaning: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 18,
    },
    close: {
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 1,
    },
}));
