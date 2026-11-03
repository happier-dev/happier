import * as React from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { useAtmosphereMoment } from '@/components/atmosphere/atmosphereMoments';
import { useHomeLoadingMoment } from '@/components/atmosphere/moments/homeLoadingMoment';
import { PersonalHomeSetupBackdrop, PersonalHomeSetupSurface } from '../setup/PersonalHomeSetupSurface';
import { derivePersonalHomeSetupProgress } from '../setup/personalHomeSetupProgress';
import { PersonalHomeRecoveryStrip } from './PersonalHomeRecoveryStrip';
import { usePersonalHomeSetupReveal } from './PersonalHomeSetupReveal';
import { isPersonalHomeBootstrapRuntimeHost } from '@/utils/platform/personalHomeBootstrapHost';
import type {
    PersonalHomeBootstrapOperation,
    PersonalHomeBootstrapSnapshot,
    PersonalHomeFacts,
} from './personalHomeBootstrapTypes';
import {
    usePersonalHomeBootstrapController,
    type PersonalHomeBootstrapOperationRunner,
} from './usePersonalHomeBootstrapController';

export type PersonalHomeBootReadiness = Readonly<{
    /** False when this Home bypasses bootstrap, even in an eligible Tauri main window. */
    active: boolean;
    kind: 'starting' | 'ready';
    /** True only after this Home's endpoint, identity, auth and signup state are verified. */
    homeReady: boolean;
}>;

const BOOT_BYPASSED: PersonalHomeBootReadiness = Object.freeze({ active: false, kind: 'ready', homeReady: true });
const BOOT_STARTING: PersonalHomeBootReadiness = Object.freeze({ active: true, kind: 'starting', homeReady: false });
const BOOT_READY: PersonalHomeBootReadiness = Object.freeze({ active: true, kind: 'ready', homeReady: true });
const PersonalHomeBootReadinessContext = React.createContext<PersonalHomeBootReadiness>(BOOT_BYPASSED);

/** The bootstrap owner's per-surface readiness, without a second daemon or Home probe. */
export function usePersonalHomeBootReadiness(): PersonalHomeBootReadiness {
    return React.useContext(PersonalHomeBootReadinessContext);
}

type PersonalHomeBootstrapPresentation = Readonly<{
    gating: boolean;
    setupProps: React.ComponentProps<typeof PersonalHomeSetupSurface>;
    setupSurface?: PersonalHomeBootstrapGateProps['setupSurface'];
}>;
const PersonalHomeBootstrapPresentationContext = React.createContext<PersonalHomeBootstrapPresentation | null>(null);

/** The mounted bootstrap owner, not Tauri host eligibility, decides who owns signed-out Home. */
export function usePersonalHomeBootstrapActive(): boolean {
    return React.useContext(PersonalHomeBootReadinessContext).active;
}

/** Home's content boundary; the shell and other routes retain their own viewport. */
export function PersonalHomeBootstrapContent(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const presentation = React.useContext(PersonalHomeBootstrapPresentationContext);
    const gating = presentation?.gating === true;
    const snapshot = presentation?.setupProps.snapshot ?? null;
    const reducedMotion = useReducedMotionPreference();
    const { theme } = useUnistyles();
    // The frame the user last read: kept while it lifts off the released shell. A frame that only
    // ever said "checking" is not held, so a fast start shows no setup at all.
    const [held, setHeld] = React.useState<Readonly<{ snapshot: PersonalHomeBootstrapSnapshot | null; departing: boolean }>>(
        { snapshot: null, departing: false });
    if (gating) {
        const next = snapshot?.phase !== 'checking' ? snapshot : held.snapshot;
        if (next !== held.snapshot || held.departing) setHeld({ snapshot: next, departing: false });
    } else if (held.snapshot && !held.departing) {
        setHeld({ snapshot: held.snapshot, departing: true });
    }
    const handleRevealSettled = React.useCallback(() => setHeld({ snapshot: null, departing: false }), []);
    const departing = !gating && held.departing;
    const revealStyle = usePersonalHomeSetupReveal(departing, handleRevealSettled);

    const frameSnapshot = gating ? snapshot : departing ? held.snapshot : null;
    const setupProps = presentation && frameSnapshot ? { ...presentation.setupProps, snapshot: frameSnapshot } : null;
    const customSurface = presentation?.setupSurface;
    const setupSurface = setupProps
        ? customSurface ? customSurface(setupProps) : <PersonalHomeSetupSurface {...setupProps} backdrop={false} />
        : null;

    // Loading (plan R-11): the cloud gathers in the setup's mark, between the setup's page and its copy,
    // and keeps resolving onto Home's planet after the frame lifts. Home below reports when it is ready.
    const rootRef = React.useRef<View>(null);
    const [pane, setPane] = React.useState({ width: 0, height: 0 });
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setPane(current => current.width === width && current.height === height ? current : { width, height });
    }, []);
    const working = frameSnapshot ? derivePersonalHomeSetupProgress(frameSnapshot).working : true;
    const loadingMoment = useAtmosphereMoment('loading');
    const moment = useHomeLoadingMoment({
        waiting: gating && loadingMoment.on, start: 'first-wait', paused: gating && !working, reducedMotion,
        // Failure and recovery have their own glyph and copy to read; the cloud does not stay behind them.
        abort: gating && frameSnapshot?.phase === 'blocked',
        theme: theme.dark ? 'dark' : 'light', pane, rootRef,
    });
    return <>{moment.provide(
        <View ref={rootRef} style={{ flex: 1 }} onLayout={onLayout} collapsable={false}>
            <View
                testID="personal-home-bootstrap-backdrop"
                style={{ flex: 1 }}
                pointerEvents={gating ? 'none' : 'auto'}
                accessibilityElementsHidden={gating}
                importantForAccessibility={gating ? 'no-hide-descendants' : 'auto'}
                {...(Platform.OS === 'web' && gating ? { inert: true } : {})}
            >
                {props.children}
            </View>
            {setupSurface && !customSurface ? (
                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, revealStyle]}>
                    <PersonalHomeSetupBackdrop />
                </Animated.View>
            ) : null}
            {moment.layer}
            {setupSurface ? (
                <Animated.View
                    // The departing frame never takes input: the shell beneath is already interactive.
                    testID={departing ? 'personal-home-setup-reveal' : undefined}
                    pointerEvents={departing ? 'none' : 'auto'}
                    accessibilityElementsHidden={departing}
                    importantForAccessibility={departing ? 'no-hide-descendants' : 'auto'}
                    style={[StyleSheet.absoluteFill, revealStyle]}
                >
                    {setupSurface}
                </Animated.View>
            ) : null}
        </View>,
    )}</>;
}

export type PersonalHomeBootstrapGateProps = Readonly<{
    children: React.ReactNode;
    /** Fact collection is supplied by the runtime/profile/auth owners. */
    readFacts?: () => Promise<PersonalHomeFacts>;
    /** Live progress can arrive before the first authoritative facts read settles. */
    activeTask?: PersonalHomeFacts['activeTask'];
    operations?: Partial<Record<PersonalHomeBootstrapOperation, PersonalHomeBootstrapOperationRunner>>;
    initialFacts?: PersonalHomeFacts | null;
    isDesktopHost?: boolean;
    isDesktopMainWindow?: boolean;
    /** Explicit recovery/callback routes must remain reachable before setup completes. */
    bypass?: boolean;
    onUseExisting?: () => void;
    useExistingRuntimeOperation?: PersonalHomeBootstrapOperationRunner;
    onUseAnotherHome?: () => void;
    /** R10 D4: keep the Home the user is already signed in to, making that selection explicit. */
    onKeepSignedInHome?: (serverId: string) => void | Promise<void>;
    /** S18: sign in to an existing local Home whose credentials this app cannot verify. */
    onSignInToExistingRuntime?: () => void;
    onOpenDetails?: () => void;
    /** Releases a one-shot creation request after the lifecycle owner finishes. */
    onReady?: () => void;
    setupSurface?: (props: React.ComponentProps<typeof PersonalHomeSetupSurface>) => React.ReactNode;
}>;

function passThroughFacts(): Promise<PersonalHomeFacts> {
    return Promise.resolve({
        hostIsDesktop: false,
        isDesktopMainWindow: false,
        explicitlySelectedOtherHome: false,
        completedPersonalHomeProfile: null,
        candidateLocalProfile: null,
        relayRuntime: null,
        localHomeReachability: 'unknown',
        localHomeIdentity: null,
        localHomeAuth: 'unknown',
        anonymousSignup: 'unknown',
        daemon: null,
        activeTask: null,
    });
}

/**
 * Desktop main-window-only bootstrap lifecycle. It projects setup into Home content while the
 * shell/navigation stays mounted. Overlay/callback windows and mobile/web hosts bypass setup.
 */
export function PersonalHomeBootstrapGate(props: PersonalHomeBootstrapGateProps): React.ReactElement {
    const runtimeHost = isPersonalHomeBootstrapRuntimeHost();
    const isDesktop = props.isDesktopHost ?? runtimeHost;
    const isMainWindow = props.isDesktopMainWindow ?? runtimeHost;
    const enabled = isDesktop && isMainWindow && props.bypass !== true && props.readFacts != null;
    // R10 D4: "Set up a Personal Home" is the user's answer for this app session. It releases the
    // signed-in-Home question so the ordinary bootstrap (with its progress) runs; once a Personal
    // Home runtime exists the facts themselves stop asking.
    const personalHomeChosenRef = React.useRef(false);
    const sourceReadFacts = props.readFacts;
    const readFacts = React.useMemo(() => {
        if (!sourceReadFacts) return passThroughFacts;
        return async (): Promise<PersonalHomeFacts> => {
            const facts = await sourceReadFacts();
            return personalHomeChosenRef.current && facts.signedInOtherHome
                ? { ...facts, signedInOtherHome: null }
                : facts;
        };
    }, [sourceReadFacts]);
    const controller = usePersonalHomeBootstrapController({
        readFacts,
        operations: props.operations,
        initialFacts: props.initialFacts,
        enabled,
    });
    const existingRuntimeNeedsSignIn = controller.snapshot.detail?.code === 'existing_runtime_credentials';
    const onReady = props.onReady;
    React.useEffect(() => {
        if (enabled && controller.snapshot.phase === 'ready' && !controller.isOperating) onReady?.();
    }, [enabled, controller.snapshot.phase, controller.isOperating, onReady]);
    const onSignInToExistingRuntime = props.onSignInToExistingRuntime;
    const handleUseExisting = React.useCallback(() => {
        if (existingRuntimeNeedsSignIn && onSignInToExistingRuntime) {
            onSignInToExistingRuntime();
            return;
        }
        if (props.useExistingRuntimeOperation) {
            void controller.execute(props.useExistingRuntimeOperation);
            return;
        }
        props.onUseExisting?.();
    }, [controller.execute, existingRuntimeNeedsSignIn, onSignInToExistingRuntime, props.onUseExisting, props.useExistingRuntimeOperation]);
    const signedInHomeServerId = controller.facts?.signedInOtherHome?.serverId ?? null;
    const onKeepSignedInHome = props.onKeepSignedInHome;
    const handleKeepSignedInHome = React.useCallback(() => {
        if (!signedInHomeServerId || !onKeepSignedInHome) return;
        void Promise.resolve(onKeepSignedInHome(signedInHomeServerId)).then(controller.refresh);
    }, [controller.refresh, onKeepSignedInHome, signedInHomeServerId]);
    const handleCreatePersonalHome = React.useCallback(() => {
        personalHomeChosenRef.current = true;
        controller.refresh();
    }, [controller.refresh]);

    const gating = enabled && controller.snapshot.shouldGateShell;

    const factTask = controller.facts?.activeTask ?? null;
    // Keep completed task diagnostics after live work ends, but never revive stale progress
    // from an earlier facts read when the subscribed runtime explicitly reports no task.
    const activeTask = props.activeTask ?? (props.activeTask === undefined || factTask?.result ? factTask : null);
    const setupProps: React.ComponentProps<typeof PersonalHomeSetupSurface> = {
        snapshot: controller.snapshot,
        activeTask,
        onRetry: controller.retry,
        onOpenDetails: props.onOpenDetails,
        onUseExisting: props.useExistingRuntimeOperation || props.onUseExisting
            ? handleUseExisting
            : undefined,
        onUseAnotherHome: props.onUseAnotherHome,
        ...(props.onKeepSignedInHome
            ? { onKeepSignedInHome: handleKeepSignedInHome, onCreatePersonalHome: handleCreatePersonalHome }
            : {}),
    };
    // Recovery after Home readiness stays secondary; pre-ready setup belongs only to Home content.
    const showPostShellPending = enabled
        && controller.error == null
        && controller.isOperating && controller.snapshot.homeReady && controller.snapshot.shouldGateShell === false;
    const showPostShellRecovery = enabled
        && controller.error != null
        && controller.snapshot.homeReady
        && controller.snapshot.shouldGateShell === false;
    return (
        <PersonalHomeBootReadinessContext.Provider value={!enabled ? BOOT_BYPASSED : controller.snapshot.homeReady ? BOOT_READY : BOOT_STARTING}>
            <PersonalHomeBootstrapPresentationContext.Provider value={{ gating, setupProps, setupSurface: props.setupSurface }}>
                <View style={{ flex: 1 }}>
                    {props.children}
                    {showPostShellPending ? (
                        <PersonalHomeRecoveryStrip
                            pending
                            kind={controller.facts?.completedPersonalHomeProfile ? 'computer' : 'profile'}
                        />
                    ) : null}
                    {showPostShellRecovery ? (
                        <PersonalHomeRecoveryStrip
                            kind={controller.facts?.completedPersonalHomeProfile ? 'computer' : 'profile'}
                            activeTask={activeTask}
                            detail={controller.snapshot.detail}
                            onOpenDetails={props.onOpenDetails}
                            onRetry={controller.retry}
                        />
                    ) : null}
                </View>
            </PersonalHomeBootstrapPresentationContext.Provider>
        </PersonalHomeBootReadinessContext.Provider>
    );
}
