import * as React from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import type {
    OnboardingWizardController,
    OnboardingWizardSurfaceProps,
} from '@/components/onboarding/surfaces/useOnboardingWizardController';
import type { WizardStepId } from '@/components/onboarding/state/wizardTypes';
import {
    useSetupWizardController,
    type SetupWizardController,
} from '@/components/onboarding/surfaces/useSetupWizardController';
import { usePendingSetupIntent } from '@/components/onboarding/state/usePendingSetupIntent';
import { WizardChoiceRow } from '@/components/onboarding/ui/WizardChoiceRow';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { installDemoFirewall, uninstallDemoFirewall } from '@/demoMode/guards/demoFirewall';
import { clearDemoWorld, seedDemoWorld } from '@/demoMode/seed/seedDemoWorld';
import { takeStoreSnapshot, type StoreSnapshot } from '@/demoMode/seed/storeSnapshot';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { buildDismissedThisComputerSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { MOBILE_MAX_WIDTH_PX } from '../unauthShell/useUnauthShellLayout';
import { RelayRetentionDisclosure } from '../unauthShell/RelayRetentionDisclosure';
import { JourneyConfigSlot, type JourneyConfigControllerSurface } from './config/JourneyConfigSlot';
import { SplitStageLayout, type SplitStageLayoutOrientation } from './desktop/SplitStageLayout';
import { StoryScrollerLayout } from './mobile/StoryScrollerLayout';
import { ShowcaseReel } from './reel/ShowcaseReel';
import { DemoStage } from './stage/DemoStage';
import type { StageDevice } from './stage/DeviceFrame';
import { resolveStageFramesForHostDevice, stageFrameById } from './stage/stageFrames';
import { preloadStageSurfaces, type StageSurfaceId } from './stage/stageSurfaces';
import { stageVisualTokens } from './stage/stageVisualTokens';
import { useDemoStageUnmountGate } from './stage/useDemoStageUnmountGate';
import {
    JOURNEY_STORY_SURFACE,
    type JourneyBeat,
    type JourneyBeatId,
    type JourneyConfigStepId,
    type JourneySurface,
    journeyBeatById,
} from './state/journeyBeats';
import {
    useJourneyProgress,
    type JourneyAttentionChoice,
    type JourneyCompletion,
} from './state/useJourneyProgress';
import { beginOnboardingJourneySession, endOnboardingJourneySession } from './state/journeySession';

export type OnboardingJourneyHostProps = Readonly<{
    surface: JourneySurface;
    isDesktopShell: boolean;
    preAuthController: OnboardingWizardController;
    wizardSurfaceProps: OnboardingWizardSurfaceProps;
    initialBeatId?: JourneyBeatId;
    initialAttentionChoice?: JourneyAttentionChoice;
    retentionSummary?: string | null;
    reducedMotion?: boolean;
    onExit?: () => void;
    testID?: string;
}>;

const PRE_AUTH_CONFIG_STEPS = new Set<JourneyConfigStepId>(['relay_select', 'auth']);
type PreAuthJourneyConfigStepId = 'relay_select' | 'auth';
type SetupJourneyConfigStepId = 'setup_this_computer' | 'providers_optional';
type ConfigStepSyncStatus = 'pending' | 'settled' | 'advancing';
type ConfigStepSyncState = Readonly<{
    beatId: JourneyBeatId;
    stepId: WizardStepId;
    status: ConfigStepSyncStatus;
}>;
type DemoLifecycleGeneration = {
    cancelled: boolean;
    activationPromise: Promise<void> | null;
    seedPromise: Promise<unknown> | null;
    preDemoSnapshot: StoreSnapshot | null;
    firewallInstalled: boolean;
    firewallReleased: boolean;
    teardownStarted: boolean;
    tornDown: boolean;
    teardownPromise: Promise<void> | null;
};

export const ONBOARDING_JOURNEY_SPLIT_ORIENTATION: SplitStageLayoutOrientation = stageVisualTokens.orientation.default;

export type JourneyLayoutMode = 'story' | 'split';

/**
 * Single owner of the journey's presentation decision (F-W13-3). The choice is
 * WIDTH-based, not platform-based: at or below the classic shell's mobile
 * breakpoint (`MOBILE_MAX_WIDTH_PX`, shared with `useUnauthShellLayout` so the
 * journey and the classic flag-off shell can never disagree) the journey uses
 * the mobile story presentation — on web and desktop too. Above the breakpoint
 * (including the 720–1000px band) the desktop split stays: the narration column
 * clamps to its min width and the planet renders full-bleed in the narrower
 * stage pane (cover fallback in `PlanetBackground`), never letterboxed bands.
 * Native surfaces always use the story presentation.
 */
export function resolveJourneyLayoutMode(params: Readonly<{
    surface: JourneySurface;
    windowWidth: number;
}>): JourneyLayoutMode {
    if (params.surface === 'native') return 'story';
    if (params.windowWidth <= MOBILE_MAX_WIDTH_PX) return 'story';
    return 'split';
}

/**
 * Beat curation consumes the presentation decision above instead of detecting a
 * phone a second time. `journeyBeats[].surfaces` describes which CUT a beat plays
 * in, and the story pager is the phone cut wherever it runs — so a narrow browser
 * window resolves to `JOURNEY_STORY_SURFACE` and gets the curated script. Before
 * this, curation was keyed by the running platform while presentation was keyed by
 * width, and mobile web played the whole 19-beat wide cut, including the seven
 * beats curation hides precisely because they read as cramped phone frames.
 */
export function resolveJourneyCurationSurface(params: Readonly<{
    surface: JourneySurface;
    layoutMode: JourneyLayoutMode;
}>): JourneySurface {
    return params.layoutMode === 'story' ? JOURNEY_STORY_SURFACE : params.surface;
}

/** The largest device canvas the resolved presentation can host a stage frame on. */
export function resolveJourneyStageHostDevice(layoutMode: JourneyLayoutMode): StageDevice {
    return layoutMode === 'story' ? 'phone' : 'desktop';
}

function resolveFallbackFrameId(beat: JourneyBeat): string {
    if (stageFrameById.has(beat.frameId)) return beat.frameId;
    if (beat.featureId === 'relay' || beat.featureId === 'privacy') return 'relay-settings.hero';
    if (beat.featureId === 'machine') return 'machines-settings.spotlight';
    if (beat.featureId === 'providers') return 'session-view.spotlight';
    if (beat.featureId === 'attention' || beat.featureId === 'grid') return 'sessions-list.hero';
    return 'session-view.hero';
}

export function adaptPreAuthController(
    controller: OnboardingWizardController,
    journeyBack: (() => void) | null,
): JourneyConfigControllerSurface {
    return {
        body: controller.body,
        onPrimary: controller.onPrimary,
        primaryLabel: controller.primaryLabel,
        primaryDisabled: controller.primaryDisabled,
        onBack: journeyBack ?? controller.onBack,
        backLabel: journeyBack ? t('common.back') : undefined,
        showBack: journeyBack ? true : controller.showBack,
        // The pre-auth per-step "skip" on the journey's config beats
        // (relay_select "Next", auth skip) is an advance DUPLICATE of the
        // primary CTA (F-W12-2 split-brain affordance). The journey primary is
        // the single advance owner on every layout — desktop split AND the
        // story presentation — so the duplicate never surfaces here.
        onSkip: null,
        skipLabel: undefined,
        skipDisabled: undefined,
        showSkip: false,
        footerHint: controller.footerHint,
    };
}

function adaptSetupController(
    controller: SetupWizardController,
    journeyBack: (() => void) | null,
): JourneyConfigControllerSurface {
    return {
        body: controller.body,
        onPrimary: controller.onPrimary,
        primaryLabel: controller.primaryLabel,
        primaryDisabled: controller.primaryDisabled,
        onBack: journeyBack ?? controller.onBack,
        backLabel: journeyBack ? t('common.back') : controller.backLabel,
        showBack: journeyBack ? true : controller.showBack,
        onSkip: controller.onSkip,
        skipLabel: controller.skipLabel,
        skipDisabled: controller.skipDisabled,
        showSkip: controller.showSkip,
        footerHint: controller.footerHint,
    };
}

function AttentionChoiceBody(props: Readonly<{
    choice: JourneyAttentionChoice;
    setChoice: (choice: JourneyAttentionChoice) => void;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={styles.attentionChoices}>
            <WizardChoiceRow
                testID={`${props.testID}-promote_attention_and_working`}
                selected={props.choice === 'promote_attention_and_working'}
                icon="stack"
                title={t('settingsSession.sessionList.attentionPromotionModeGlobalTitle')}
                subtitle={t('settingsSession.sessionList.workingPlacementModeGlobalSubtitle')}
                onPress={() => props.setChoice('promote_attention_and_working')}
            />
            <WizardChoiceRow
                testID={`${props.testID}-keep_current`}
                selected={props.choice === 'keep_current'}
                icon="list"
                title={t('settingsSession.sessionList.attentionPromotionModeOffTitle')}
                subtitle={t('settingsSession.sessionList.workingPlacementModeOffSubtitle')}
                onPress={() => props.setChoice('keep_current')}
            />
        </View>
    );
}

function buildDefaultController(params: Readonly<{
    progress: ReturnType<typeof useJourneyProgress>;
    handleExit: () => Promise<void>;
    advance: () => void | Promise<void>;
    skipToSetup: () => void | Promise<void>;
    testID: string;
}>): JourneyConfigControllerSurface {
    const beat = params.progress.currentBeat;
    const isFinalBeat = !params.progress.nextBeatId;
    const body = beat.id === 'A14' ? (
        <ShowcaseReel
            onSetUpHappier={params.skipToSetup}
            testID={`${params.testID}-reel`}
        />
    ) : beat.configStepId === 'attention_micro_choice' ? (
        <AttentionChoiceBody
            choice={params.progress.attentionChoice}
            setChoice={params.progress.setAttentionChoice}
            testID={`${params.testID}-attention-choice`}
        />
    ) : (
        <Text>{null}</Text>
    );

    return {
        body,
        onPrimary: isFinalBeat ? params.handleExit : params.advance,
        primaryLabel: isFinalBeat ? t('common.done') : t('common.next'),
        onBack: params.progress.previousBeatId ? params.progress.back : null,
        showBack: Boolean(params.progress.previousBeatId),
        onSkip: beat.act === 'dream' ? params.skipToSetup : null,
        skipLabel: t('journey.actions.skipToSetup'),
        showSkip: beat.act === 'dream',
    };
}

function isSetupJourneyConfigStepId(configStepId: JourneyConfigStepId | undefined): configStepId is SetupJourneyConfigStepId {
    return configStepId === 'setup_this_computer' || configStepId === 'providers_optional';
}

function isPreAuthJourneyConfigStepId(configStepId: JourneyConfigStepId | undefined): configStepId is PreAuthJourneyConfigStepId {
    return configStepId === 'relay_select' || configStepId === 'auth';
}

function isPreAuthControllerAuthStep(stepId: OnboardingWizardController['stepId']): boolean {
    return stepId === 'auth'
        || stepId === 'auth_restore'
        || stepId === 'auth_secret_key'
        || stepId === 'auth_lost_access';
}

function resolveSetupScope(configStepId: SetupJourneyConfigStepId | undefined): 'machine' | 'all' {
    return configStepId === 'providers_optional' ? 'all' : 'machine';
}

function syncConfigStep(params: Readonly<{
    syncRef: React.MutableRefObject<ConfigStepSyncState | null>;
    beatId: JourneyBeatId;
    targetStepId: WizardStepId;
    currentStepId: WizardStepId;
    goToStep: (stepId: WizardStepId) => void;
    isControllerAtNextBeat?: (stepId: WizardStepId) => boolean;
    advanceJourney?: () => void;
}>): void {
    const existing = params.syncRef.current;
    const matchesCurrentTarget = existing?.beatId === params.beatId
        && existing.stepId === params.targetStepId;

    if (
        existing?.beatId === params.beatId
        && existing.stepId === params.targetStepId
        && existing.status === 'settled'
        && params.isControllerAtNextBeat?.(params.currentStepId) === true
    ) {
        params.syncRef.current = {
            beatId: params.beatId,
            stepId: params.targetStepId,
            status: 'advancing',
        };
        params.advanceJourney?.();
        return;
    }

    if (matchesCurrentTarget) {
        if (params.currentStepId === params.targetStepId && existing.status !== 'settled') {
            params.syncRef.current = {
                beatId: params.beatId,
                stepId: params.targetStepId,
                status: 'settled',
            };
        }
        return;
    }

    if (params.currentStepId === params.targetStepId) {
        params.syncRef.current = {
            beatId: params.beatId,
            stepId: params.targetStepId,
            status: 'settled',
        };
        return;
    }

    params.syncRef.current = {
        beatId: params.beatId,
        stepId: params.targetStepId,
        status: 'pending',
    };
    params.goToStep(params.targetStepId);
}

function isSetupBeatId(beatId: JourneyBeatId | null | undefined): boolean {
    return beatId ? journeyBeatById.get(beatId)?.act === 'setup' : false;
}

function shouldRenderLiveDemoStage(beat: JourneyBeat): boolean {
    return beat.act === 'dream' && beat.stageTreatment !== 'planet-hero';
}

/**
 * How far ahead the journey warms stage surfaces. The stage MOUNTS the first
 * entry and only imports the rest, so two keeps one module warm behind the
 * mounted beat: the beat after the pre-mounted one is already imported by the
 * time the user reaches it, and nothing further ahead is fetched speculatively.
 */
const JOURNEY_STAGE_WARM_LOOKAHEAD = 2;

/**
 * The stage frames the journey mounts AFTER `beat`, nearest first.
 *
 * Beat order lives here because the host is its only holder: the stage frame
 * table's array order is not the script, so warming array neighbours warms
 * surfaces the user never reaches. Beats that mount no live stage (the
 * planet-hero openings, the whole setup act) are skipped rather than warmed.
 */
function resolveUpcomingStageFrameIds(
    visibleBeats: readonly JourneyBeat[],
    beat: JourneyBeat,
): readonly string[] {
    const beatIndex = visibleBeats.findIndex((visibleBeat) => visibleBeat.id === beat.id);
    if (beatIndex < 0) return [];

    const frameIds: string[] = [];
    for (let index = beatIndex + 1; index < visibleBeats.length; index += 1) {
        const upcomingBeat = visibleBeats[index];
        if (!upcomingBeat || !shouldRenderLiveDemoStage(upcomingBeat)) continue;
        frameIds.push(resolveFallbackFrameId(upcomingBeat));
        if (frameIds.length >= JOURNEY_STAGE_WARM_LOOKAHEAD) break;
    }
    return frameIds;
}

function restoreExactSnapshot(snapshot: StoreSnapshot): void {
    storage.setState((current) => ({
        sessions: snapshot.sessions,
        sessionListRenderables: snapshot.sessionListRenderables,
        sessionListIndexByServerId: snapshot.sessionListIndexByServerId,
        machines: snapshot.machines,
        machineDisplayById: snapshot.machineDisplayById,
        machineListByServerId: snapshot.machineListByServerId,
        sessionMessages: snapshot.sessionMessages,
        sessionPending: snapshot.sessionPending,
        reviewCommentsDraftsBySessionId: snapshot.reviewCommentsDraftsBySessionId,
        settings: {
            ...current.settings,
            ...snapshot.settings,
        },
    }));
}

function SetupJourneyControllerBridge(props: Readonly<{
    isDesktopShell: boolean;
    configStepId: SetupJourneyConfigStepId;
    initialSetupAction: 'local' | 'remote';
    nextBeatId: JourneyBeatId | null;
    currentBeatId: JourneyBeatId;
    journeyBack: (() => void) | null;
    onExit: () => void;
    advanceJourney: () => void;
    render: (controller: JourneyConfigControllerSurface) => React.ReactElement;
}>): React.ReactElement {
    const syncRef = React.useRef<ConfigStepSyncState | null>(null);
    const controller = useSetupWizardController({
        isDesktopShell: props.isDesktopShell,
        initialStepId: props.configStepId,
        initialSetupAction: props.initialSetupAction,
        scope: resolveSetupScope(props.configStepId),
        onExit: props.onExit,
    });

    React.useEffect(() => {
        syncConfigStep({
            syncRef,
            beatId: props.currentBeatId,
            targetStepId: props.configStepId,
            currentStepId: controller.stepId,
            goToStep: controller.goToStep,
            isControllerAtNextBeat: (stepId) => {
                const nextBeat = props.nextBeatId ? journeyBeatById.get(props.nextBeatId) : undefined;
                if (!nextBeat || nextBeat.act !== 'setup') return false;
                if (isSetupJourneyConfigStepId(nextBeat.configStepId)) {
                    return stepId === nextBeat.configStepId;
                }
                return nextBeat.configStepId === undefined && stepId === 'done';
            },
            advanceJourney: props.advanceJourney,
        });
    }, [
        controller.goToStep,
        controller.stepId,
        props.advanceJourney,
        props.configStepId,
        props.currentBeatId,
        props.nextBeatId,
    ]);

    return props.render(adaptSetupController(controller, props.journeyBack));
}

export function OnboardingJourneyHost(props: OnboardingJourneyHostProps): React.ReactElement {
    const stylesForHost = hostStylesheet;
    useUnistyles();
    const testID = props.testID ?? 'onboarding-journey';
    const isNativeSurface = props.surface === 'native';
    const mainContentTargetId = `${testID}-main-content`;
    const bypassMinimumTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const mainContentRef = React.useRef<React.ComponentRef<typeof View> | null>(null);
    const [isBypassFocused, setBypassFocused] = React.useState(false);
    const windowWidth = useWindowDimensions().width;
    const layoutMode = resolveJourneyLayoutMode({ surface: props.surface, windowWidth });
    const curationSurface = resolveJourneyCurationSurface({ surface: props.surface, layoutMode });
    const layoutStageFrames = resolveStageFramesForHostDevice(resolveJourneyStageHostDevice(layoutMode));
    const auth = useAuth();
    const pendingSetupIntent = usePendingSetupIntent();
    const applySettings = useApplySettings();
    const demoLifecycleRef = React.useRef<DemoLifecycleGeneration | null>(null);
    const demoTeardownStartedRef = React.useRef(false);
    const demoTornDownRef = React.useRef(false);
    const actTwoBoundaryTeardownRef = React.useRef<Promise<void> | null>(null);
    const startsOnSetupBeatRef = React.useRef(isSetupBeatId(props.initialBeatId));
    const hingeHandledRef = React.useRef(false);
    const preAuthStepSyncRef = React.useRef<ConfigStepSyncState | null>(null);
    const { demoSeeded, setDemoSeeded, unmountDemoStage } = useDemoStageUnmountGate();

    const persistCompletionSettings = React.useCallback((completion: JourneyCompletion) => {
        if (completion.attentionChoice !== 'promote_attention_and_working') return;
        applySettings({
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'global',
        });
    }, [applySettings]);

    const dismissPendingSetupIntent = React.useCallback(() => {
        if (pendingSetupIntent) {
            if (pendingSetupIntent.phase !== 'dismissed') {
                setPendingSetupIntent({ ...pendingSetupIntent, phase: 'dismissed' });
            }
            return;
        }
        const snapshot = getActiveServerSnapshot();
        setPendingSetupIntent(buildDismissedThisComputerSetupIntent(snapshot.serverUrl));
    }, [pendingSetupIntent]);

    const teardownDemoGeneration = React.useCallback(async (generation: DemoLifecycleGeneration) => {
        const existingTeardown = generation.teardownPromise;
        if (existingTeardown) return existingTeardown;

        generation.teardownStarted = true;
        if (demoLifecycleRef.current === generation) {
            demoTeardownStartedRef.current = true;
        }
        const teardownPromise = (async () => {
            await generation.activationPromise?.catch(() => undefined);
            if (!generation.firewallInstalled) return;

            try {
                await generation.seedPromise?.catch(() => undefined);
                // Inherits the diagnostic policy fixed at seed (single decision).
                await clearDemoWorld();
                const snapshot = generation.preDemoSnapshot;
                if (snapshot) {
                    restoreExactSnapshot(snapshot);
                }
            } finally {
                if (!generation.firewallReleased) {
                    generation.firewallReleased = true;
                    uninstallDemoFirewall();
                }
            }
        })();
        generation.teardownPromise = teardownPromise;
        try {
            await teardownPromise;
            generation.tornDown = true;
            if (demoLifecycleRef.current === generation) {
                demoTornDownRef.current = true;
            }
        } catch (error) {
            if (generation.teardownPromise === teardownPromise) {
                generation.teardownPromise = null;
            }
            throw error;
        }
    }, []);

    const teardownDemo = React.useCallback(async () => {
        const generation = demoLifecycleRef.current;
        if (!generation) {
            // Setup-entry journeys never create a demo generation, but their final
            // exit still performs the existing idempotent world-clear settlement.
            await clearDemoWorld();
            uninstallDemoFirewall();
            return;
        }
        await teardownDemoGeneration(generation);
    }, [teardownDemoGeneration]);

    const settleJourneyExit = React.useCallback((completion?: JourneyCompletion) => {
        void (async () => {
            try {
                await teardownDemo();
                if (completion) {
                    persistCompletionSettings(completion);
                }
                dismissPendingSetupIntent();
                props.onExit?.();
            } catch {
                // Fall back to the authenticated route owner; pending setup intent remains for legacy continuation.
            } finally {
                endOnboardingJourneySession();
            }
        })();
    }, [dismissPendingSetupIntent, persistCompletionSettings, props.onExit, teardownDemo]);

    const handleComplete = React.useCallback((completion: JourneyCompletion) => {
        settleJourneyExit(completion);
    }, [settleJourneyExit]);

    const progress = useJourneyProgress({
        surface: curationSurface,
        initialBeatId: props.initialBeatId,
        initialAttentionChoice: props.initialAttentionChoice,
        onComplete: handleComplete,
    });
    const setupConfigStepId = isSetupJourneyConfigStepId(progress.currentBeat.configStepId)
        ? progress.currentBeat.configStepId
        : undefined;

    const ensureActTwoDemoTeardown = React.useCallback(async () => {
        await unmountDemoStage();
        if (demoTornDownRef.current) {
            return;
        }
        await teardownDemo();
    }, [teardownDemo, unmountDemoStage]);

    const attemptActTwoDemoTeardown = React.useCallback(async () => {
        try {
            await ensureActTwoDemoTeardown();
        } catch {
            // The setup-beat boundary effect retries teardown after navigation.
        }
    }, [ensureActTwoDemoTeardown]);

    const advanceJourney = React.useCallback(async () => {
        if (isSetupBeatId(progress.nextBeatId)) {
            await attemptActTwoDemoTeardown();
        }
        progress.advance();
    }, [attemptActTwoDemoTeardown, progress]);

    const skipToSetupJourney = React.useCallback(async () => {
        if (isSetupBeatId(progress.skipTargetBeatId)) {
            await attemptActTwoDemoTeardown();
        }
        progress.skipToSetup();
    }, [attemptActTwoDemoTeardown, progress]);

    const journeyProgress = React.useMemo(() => ({
        ...progress,
        advance: advanceJourney,
        skipToSetup: skipToSetupJourney,
    }), [advanceJourney, progress, skipToSetupJourney]);

    const focusJourneyContent = React.useCallback(() => {
        const mainContent = mainContentRef.current;
        if (!mainContent) return;

        if (isNativeSurface) {
            const reactTag = findNodeHandle(mainContent);
            if (reactTag != null) {
                AccessibilityInfo.setAccessibilityFocus(reactTag);
            }
            return;
        }

        mainContent.focus();
    }, [isNativeSurface]);

    React.useEffect(() => {
        beginOnboardingJourneySession();

        // A journey that STARTS on a setup beat (deep-link replay, authed S3 re-latch)
        // never renders the dream act, so the demo world must not be seeded at all:
        // seeding here races the async act-two teardown, and real setup controllers
        // (wizard relay selection, active-relay footer) capture mid-demo state that no
        // later store restore can heal. This mirrors the normal path, where teardown
        // completes before any setup beat renders.
        if (startsOnSetupBeatRef.current) {
            demoTornDownRef.current = true;
            return () => {
                endOnboardingJourneySession();
            };
        }

        const predecessor = demoLifecycleRef.current;
        const generation: DemoLifecycleGeneration = {
            cancelled: false,
            activationPromise: null,
            seedPromise: null,
            preDemoSnapshot: null,
            firewallInstalled: false,
            firewallReleased: false,
            teardownStarted: false,
            tornDown: false,
            teardownPromise: null,
        };
        demoLifecycleRef.current = generation;
        demoTeardownStartedRef.current = false;
        demoTornDownRef.current = false;

        generation.activationPromise = (async () => {
            if (predecessor) {
                // React may replay this effect before the prior async cleanup settles.
                // Finish that generation before snapshotting/installing the replacement,
                // so a stale cleanup can neither restore over nor release the live world.
                try {
                    await teardownDemoGeneration(predecessor);
                } catch {
                    // A failed teardown clears its generation-owned promise so the
                    // existing idempotent retry can settle transient clear failures.
                    // A second rejection aborts this activation before it can snapshot,
                    // install the firewall, or seed over an uncleared predecessor.
                    await teardownDemoGeneration(predecessor);
                }
            }
            if (generation.cancelled || generation.teardownStarted) return;

            generation.preDemoSnapshot = takeStoreSnapshot(storage.getState());
            installDemoFirewall();
            generation.firewallInstalled = true;
            setDemoSeeded(false);
            // Live pre-auth path: seed the cheap counting-only residue tracker
            // (diagnostic policy). This is the single mode decision — teardown below
            // inherits it, so the journey never pays the strict per-timer stack cost
            // and is never stranded by the strict zero-residue throw.
            const seedPromise = seedDemoWorld({ residuePolicy: 'diagnostic' });
            generation.seedPromise = seedPromise;
            await seedPromise;

            if (generation.cancelled || generation.teardownStarted || generation.tornDown) return;
            if (demoLifecycleRef.current !== generation) return;
            setDemoSeeded(true);
        })();
        void generation.activationPromise.catch(() => undefined);

        return () => {
            generation.cancelled = true;
            endOnboardingJourneySession();
            void teardownDemoGeneration(generation).catch(() => undefined);
        };
    }, [teardownDemoGeneration]);

    React.useEffect(() => {
        if (progress.currentBeat.act !== 'setup') return;
        if (demoTornDownRef.current || actTwoBoundaryTeardownRef.current) return;
        const teardownPromise = ensureActTwoDemoTeardown();
        actTwoBoundaryTeardownRef.current = teardownPromise;
        void teardownPromise
            .catch(() => undefined)
            .finally(() => {
                if (actTwoBoundaryTeardownRef.current === teardownPromise) {
                    actTwoBoundaryTeardownRef.current = null;
                }
            });
    });

    React.useEffect(() => {
        if (!auth.isAuthenticated || progress.currentBeat.id !== 'S2' || hingeHandledRef.current) return;
        hingeHandledRef.current = true;
        progress.advance();
    }, [auth.isAuthenticated, progress]);

    React.useEffect(() => {
        if (progress.currentBeat.id !== 'S2') {
            hingeHandledRef.current = false;
        }
    }, [progress.currentBeat.id]);

    React.useEffect(() => {
        if (!isPreAuthJourneyConfigStepId(progress.currentBeat.configStepId)) {
            preAuthStepSyncRef.current = null;
            return;
        }

        syncConfigStep({
            syncRef: preAuthStepSyncRef,
            beatId: progress.currentBeat.id,
            targetStepId: progress.currentBeat.configStepId,
            currentStepId: props.preAuthController.stepId,
            goToStep: props.preAuthController.goToStep,
            isControllerAtNextBeat: progress.currentBeat.id === 'S1'
                ? isPreAuthControllerAuthStep
                : undefined,
            advanceJourney: progress.advance,
        });
    }, [
        progress.currentBeat.configStepId,
        progress.currentBeat.id,
        progress.advance,
        props.preAuthController.goToStep,
        props.preAuthController.stepId,
    ]);

    const currentBeatMountsStage = demoSeeded && shouldRenderLiveDemoStage(progress.currentBeat);
    const upcomingStageFrameIds = React.useMemo(
        () => resolveUpcomingStageFrameIds(progress.visibleBeats, progress.currentBeat),
        [progress.currentBeat, progress.visibleBeats],
    );

    React.useEffect(() => {
        // A beat that mounts no stage (the planet-hero openings, and every beat
        // still waiting on demo seeding) has no stage to run the warm policy, so
        // the journey used to sit idle on slide 1 and then pay a cold chunk fetch
        // on the first real stage beat. The host warms from the same beat-ordered
        // list it hands the stage; where a stage IS mounted, that stage owns the
        // mount-vs-import policy over it and this would only re-request a cached
        // import.
        if (currentBeatMountsStage || upcomingStageFrameIds.length === 0) return;
        const surfaceIds = upcomingStageFrameIds
            .map((frameId) => stageFrameById.get(frameId)?.surface)
            .filter((surfaceId): surfaceId is StageSurfaceId => surfaceId !== undefined);
        if (surfaceIds.length === 0) return;
        void preloadStageSurfaces(surfaceIds).catch(() => undefined);
    }, [currentBeatMountsStage, upcomingStageFrameIds]);

    const renderDemoStage = (beat: JourneyBeat): React.ReactElement | null => (
        demoSeeded && shouldRenderLiveDemoStage(beat) ? (
            <DemoStage
                frames={layoutStageFrames}
                activeFrameId={resolveFallbackFrameId(beat)}
                upcomingFrameIds={resolveUpcomingStageFrameIds(progress.visibleBeats, beat)}
                reducedMotion={props.reducedMotion}
            />
        ) : null
    );
    const stage = renderDemoStage(progress.currentBeat);

    let controller = buildDefaultController({
        progress: journeyProgress,
        handleExit: async () => {
            progress.advance();
        },
        advance: advanceJourney,
        skipToSetup: skipToSetupJourney,
        testID,
    });

    const journeyBack = progress.previousBeatId ? progress.back : null;
    // The journey owns Back on config beats so narration and embedded wizard body move together.
    if (progress.currentBeat.configStepId && PRE_AUTH_CONFIG_STEPS.has(progress.currentBeat.configStepId)) {
        controller = adaptPreAuthController(props.preAuthController, journeyBack);
        if (progress.currentBeat.configStepId === 'auth' && props.retentionSummary) {
            controller = {
                ...controller,
                footerHint: (
                    <View style={stylesForHost.preAuthFooter}>
                        <RelayRetentionDisclosure
                            summary={props.retentionSummary}
                            testID={`${testID}-retention-disclosure`}
                        />
                        {controller.footerHint}
                    </View>
                ),
            };
        }
    }

    const renderJourney = (activeController: JourneyConfigControllerSurface): React.ReactElement => (
        <View testID={testID} style={stylesForHost.root}>
            <View testID={`${testID}-navigation-landmark`} role="navigation" style={stylesForHost.bypassNavigation}>
                <Pressable
                    testID={`${testID}-skip-to-content`}
                    accessibilityRole={isNativeSurface ? 'button' : 'link'}
                    accessibilityLabel={t('onboardingJourney.accessibility.skipToContent')}
                    role={isNativeSurface ? 'button' : 'link'}
                    // @ts-expect-error React Native's types omit RNW's anchor forwarding.
                    href={isNativeSurface ? undefined : `#${mainContentTargetId}`}
                    onFocus={() => setBypassFocused(true)}
                    onBlur={() => setBypassFocused(false)}
                    onPress={focusJourneyContent}
                    style={[
                        stylesForHost.bypassControl,
                        { minHeight: bypassMinimumTargetSize },
                        isNativeSurface || isBypassFocused ? stylesForHost.bypassControlVisible : null,
                    ]}
                >
                    <Text style={stylesForHost.bypassControlLabel}>
                        {t('onboardingJourney.accessibility.skipToContent')}
                    </Text>
                </Pressable>
            </View>
            <View
                ref={mainContentRef}
                testID={`${testID}-main-content`}
                nativeID={mainContentTargetId}
                role="main"
                collapsable={isNativeSurface ? false : undefined}
                focusable={!isNativeSurface}
                tabIndex={isNativeSurface ? undefined : -1}
                style={stylesForHost.mainContent}
            >
                {layoutMode === 'story' ? (
                    <StoryScrollerLayout
                        progress={journeyProgress}
                        controller={activeController}
                        renderStage={renderDemoStage}
                        reducedMotion={props.reducedMotion}
                        testID={`${testID}-mobile`}
                    />
                ) : (
                    <SplitStageLayout
                        progress={journeyProgress}
                        controller={activeController}
                        stage={stage}
                        orientation={ONBOARDING_JOURNEY_SPLIT_ORIENTATION}
                        reducedMotion={props.reducedMotion}
                        testID={`${testID}-desktop`}
                    />
                )}
            </View>
        </View>
    );

    if (setupConfigStepId) {
        return (
            <SetupJourneyControllerBridge
                isDesktopShell={props.isDesktopShell}
                configStepId={setupConfigStepId}
                initialSetupAction={pendingSetupIntent?.branch === 'remoteMachine' ? 'remote' : 'local'}
                nextBeatId={progress.nextBeatId}
                currentBeatId={progress.currentBeat.id}
                journeyBack={journeyBack}
                onExit={settleJourneyExit}
                advanceJourney={progress.advance}
                render={renderJourney}
            />
        );
    }

    return renderJourney(controller);
}

const styles = StyleSheet.create(() => ({
    attentionChoices: {
        width: '100%',
        gap: 10,
    },
}));

const hostStylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
    bypassNavigation: {
        position: 'absolute',
        top: 12,
        left: 12,
        zIndex: 100,
    },
    bypassControl: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderWidth: 1,
        borderRadius: 999,
        borderCurve: 'continuous',
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        opacity: 0,
        transform: [{ translateY: -16 }],
    },
    bypassControlVisible: {
        borderColor: theme.colors.text.primary,
        opacity: 1,
        transform: [{ translateY: 0 }],
    },
    bypassControlLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 20,
    },
    mainContent: {
        flex: 1,
        minHeight: 0,
    },
    preAuthFooter: {
        width: '100%',
        gap: 10,
    },
}));
