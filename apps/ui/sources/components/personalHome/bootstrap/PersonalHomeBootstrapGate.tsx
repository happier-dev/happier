import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { PersonalHomeSetupSurface } from '../setup/PersonalHomeSetupSurface';
import { PersonalHomeRecoveryStrip } from './PersonalHomeRecoveryStrip';
import { PersonalHomeSetupReveal } from './PersonalHomeSetupReveal';
import { isPersonalHomeBootstrapRuntimeHost } from './personalHomeBootstrapHost';
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
    kind: 'starting' | 'ready';
    /** True only after this Home's endpoint, identity, auth and signup state are verified. */
    homeReady: boolean;
}>;

const BOOT_STARTING: PersonalHomeBootReadiness = Object.freeze({ kind: 'starting', homeReady: false });
const BOOT_READY: PersonalHomeBootReadiness = Object.freeze({ kind: 'ready', homeReady: true });
const PersonalHomeBootReadinessContext = React.createContext<PersonalHomeBootReadiness>(BOOT_READY);

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

/** Home's content boundary; the shell and other routes retain their own viewport. */
export function PersonalHomeBootstrapContent(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const presentation = React.useContext(PersonalHomeBootstrapPresentationContext);
    const gating = presentation?.gating === true;
    const snapshot = presentation?.setupProps.snapshot ?? null;
    const reducedMotion = useReducedMotionPreference();
    const departingSnapshotRef = React.useRef<PersonalHomeBootstrapSnapshot | null>(null);
    const [revealSnapshot, setRevealSnapshot] = React.useState<PersonalHomeBootstrapSnapshot | null>(null);
    const handleRevealSettled = React.useCallback(() => setRevealSnapshot(null), []);

    React.useEffect(() => {
        if (gating) {
            if (snapshot?.phase !== 'checking') departingSnapshotRef.current = snapshot;
            setRevealSnapshot((current) => current === null ? current : null);
            return;
        }
        const departing = departingSnapshotRef.current;
        departingSnapshotRef.current = null;
        if (!departing || reducedMotion) return;
        setRevealSnapshot(departing);
    }, [gating, reducedMotion, snapshot]);

    const setupProps = presentation ? {
        ...presentation.setupProps,
        snapshot: gating ? presentation.setupProps.snapshot : revealSnapshot ?? presentation.setupProps.snapshot,
    } : null;
    const setupSurface = setupProps && (gating || revealSnapshot !== null)
        ? presentation?.setupSurface ? presentation.setupSurface(setupProps) : <PersonalHomeSetupSurface {...setupProps} />
        : null;
    return (
        <View style={{ flex: 1 }}>
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
            {gating ? <View style={StyleSheet.absoluteFill}>{setupSurface}</View> : null}
            {!gating && revealSnapshot ? (
                <PersonalHomeSetupReveal onSettled={handleRevealSettled}>
                    {setupSurface}
                </PersonalHomeSetupReveal>
            ) : null}
        </View>
    );
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
        <PersonalHomeBootReadinessContext.Provider value={!enabled || controller.snapshot.homeReady ? BOOT_READY : BOOT_STARTING}>
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
