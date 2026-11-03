import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { presentActiveCliAcquisition, resolveCliAcquisitionFailureMessage } from '@/components/systemTasks/cliAcquisitionPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { Typography } from '@/constants/Typography';
import { LoadingPlanetSlot } from '@/components/atmosphere/moments/homeLoadingMoment';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { t, tLoose } from '@/text';

import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';
import {
    PersonalHomeExistingRuntimeDecision,
    PersonalHomeSignedInHomeDecision,
    PersonalHomeUseAnotherHomeAction,
} from './PersonalHomeExistingRuntimeDecision';
import { PersonalHomeSetupFailure } from './PersonalHomeSetupFailure';
import { PersonalHomeDiagnosticDetails } from './PersonalHomeDiagnosticDetails';
import { derivePersonalHomeSetupProgress } from './personalHomeSetupProgress';

const CONTENT_MAX_WIDTH = 520;
/** The mark's room when no Loading host places the planet in it (the former setup mark's size). */
const MARK_FALLBACK_SIZE = 76;
const RECOVERY_MAX_WIDTH = 420;
/** Failure's semantic glyph, centred in the ring where the planet would stand. */
const FAILURE_GLYPH_SIZE = 28;

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1 },
    failureMark: { width: MARK_FALLBACK_SIZE, height: MARK_FALLBACK_SIZE, alignItems: 'center', justifyContent: 'center' },
    scroll: { flex: 1 },
    scrollContent: { flexGrow: 1, paddingHorizontal: theme.space.s32, paddingVertical: theme.space.s40, alignItems: 'center' },
    // Auto margins centre the composition while keeping BOTH overflow edges reachable at compact
    // heights and large text sizes, which `justifyContent: 'center'` alone does not on web.
    centered: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignItems: 'center', marginVertical: 'auto', gap: theme.space.s24 },
    header: { alignItems: 'center', gap: theme.space.s16 },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('display'),
        textAlign: 'center',
    },
    // Two lines of height are reserved so a changing status sentence never moves the mark above it.
    status: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
        minHeight: 44,
        maxWidth: 380,
        textAlign: 'center',
    },
    recovery: { width: '100%', maxWidth: RECOVERY_MAX_WIDTH, alignItems: 'center' },
    quietActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: theme.space.s4 },
    detailsButton: { alignSelf: 'center', paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s10, justifyContent: 'center' },
    detailsText: {  color: theme.colors.text.secondary, ...Typography.variant('label', 'semiBold') },
    details: { width: '100%', maxWidth: RECOVERY_MAX_WIDTH },
}));

/**
 * A blocked snapshot already carries the specific, actionable reason as a stable
 * `code`, so recoverable states stop reading identically and the erased Home stops
 * reading as a reassurance. Only translated copy keyed by that code is promoted to
 * primary status: `detail.message` is diagnostic text that may carry credentials and
 * is sanitized before it is shown, and only inside Details. A code with no key falls
 * back to the generic sentence rather than leaking the raw message.
 */
function blockedStatusCopy(snapshot: PersonalHomeBootstrapSnapshot): string | null {
    const code = snapshot.detail?.code?.trim();
    if (!code) return null;
    const acquisitionFailure = resolveCliAcquisitionFailureMessage(code);
    if (acquisitionFailure) return acquisitionFailure;
    const key = `personalHome.bootstrap.blocked.${code}`;
    const value = tLoose(key);
    return typeof value === 'string' && value !== key ? value : null;
}

/** State-specific replacement for the generic failure body, when one exists. */
function blockedFailureBodyCopy(snapshot: PersonalHomeBootstrapSnapshot): string | null {
    const code = snapshot.detail?.code?.trim();
    if (!code) return null;
    const key = `personalHome.bootstrap.blockedBody.${code}`;
    const value = tLoose(key);
    return typeof value === 'string' && value !== key ? value : null;
}

function phaseCopy(snapshot: PersonalHomeBootstrapSnapshot): string {
    switch (snapshot.phase) {
        case 'checking': return t('personalHome.bootstrap.checkingStatus');
        case 'ensuring-home': return t('personalHome.bootstrap.ensuringHomeStatus');
        case 'preparing-computer': return t('personalHome.bootstrap.preparingComputerStatus');
        case 'blocked':
            if (snapshot.action === 'choose-signed-in-home') return t('personalHome.bootstrap.signedInHome.status');
            return blockedStatusCopy(snapshot) ?? t('personalHome.bootstrap.blockedStatus');
        case 'ready': return t('personalHome.bootstrap.readyStatus');
    }
}

/**
 * Anything this surface may move focus to: the portable focus handle a control
 * exposes through `controlRef`, or a raw view instance rendered here.
 */
type FocusableAction = Readonly<{ focus?: () => void }>;

function focusAction(target: FocusableAction | null): void {
    const focus = target?.focus;
    if (typeof focus === 'function') {
        try {
            focus.call(target);
        } catch {
            // Some native/test hosts expose a ref without a usable focus handle.
        }
    }
}

export const PersonalHomeSetupSurface = React.memo(function PersonalHomeSetupSurface(props: Readonly<{
    snapshot: PersonalHomeBootstrapSnapshot;
    activeTask?: SystemTaskRunState | null;
    onRetry?: () => void;
    onOpenDetails?: () => void;
    onUseExisting?: () => void;
    onUseAnotherHome?: () => void;
    onKeepSignedInHome?: () => void;
    onCreatePersonalHome?: () => void;
    /**
     * False when the host draws the surface's page itself (`PersonalHomeSetupBackdrop`) so the Loading
     * planet can stand between that page and this copy.
     */
    backdrop?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const retryRef = React.useRef<FocusableAction | null>(null);
    const detailsRef = React.useRef<React.ElementRef<typeof Pressable>>(null);
    const useExistingRef = React.useRef<FocusableAction | null>(null);
    const failureDetailsRef = React.useRef<FocusableAction | null>(null);
    const focusedRecoveryStateRef = React.useRef<string | null>(null);
    const progress = derivePersonalHomeSetupProgress(props.snapshot);
    const hasFailure = props.snapshot.phase === 'blocked';
    const acquisition = progress.working ? presentActiveCliAcquisition(props.activeTask) : null;
    const failedTask = props.activeTask?.result;
    const acquisitionFailure = hasFailure && props.snapshot.detail?.code === 'bootstrap_operation_failed'
        && failedTask && !failedTask.ok
        ? resolveCliAcquisitionFailureMessage(failedTask.error.code)
        : undefined;
    const showExistingDecision = props.snapshot.action === 'choose-existing-runtime';
    const signedInHomeLabel = props.snapshot.action === 'choose-signed-in-home' ? props.snapshot.signedInHomeLabel : undefined;
    const showSignedInDecision = signedInHomeLabel != null
        && props.onKeepSignedInHome != null
        && props.onCreatePersonalHome != null;
    const showFailure = hasFailure
        && props.snapshot.action !== 'choose-signed-in-home'
        && (!showExistingDecision || props.snapshot.detail?.retryable === true);
    // The status line above already names the reason. The card body stays the generic
    // guidance unless this state contradicts it — the erased Home must not be told its
    // completed setup work is safe.
    const blockedBody = hasFailure ? blockedFailureBodyCopy(props.snapshot) : null;
    // With no state-specific reason, the status and the failure body are one message: say it once.
    const genericFailure = showFailure && !acquisitionFailure && !blockedBody && blockedStatusCopy(props.snapshot) === null;
    const hasLocalDetails = props.activeTask != null || props.snapshot.detail != null;
    const showDetails = detailsOpen && hasLocalDetails;
    const toggleDetails = React.useCallback(() => setDetailsOpen((value) => !value), []);
    const failureDetailsAction = props.onOpenDetails ?? (hasLocalDetails ? toggleDetails : undefined);
    const recoveryFocusState = showSignedInDecision
        ? 'signed-in-home'
        : showExistingDecision && props.onUseExisting && props.onUseAnotherHome
        ? 'existing-runtime'
        : hasFailure && props.snapshot.action === 'retry' && props.onRetry
            ? 'retry'
            : hasFailure && failureDetailsAction
                ? 'details'
                : null;

    React.useEffect(() => {
        if (recoveryFocusState === null) {
            focusedRecoveryStateRef.current = null;
            return;
        }
        if (focusedRecoveryStateRef.current === recoveryFocusState) return;
        focusedRecoveryStateRef.current = recoveryFocusState;
        if (recoveryFocusState === 'existing-runtime' || recoveryFocusState === 'signed-in-home') {
            focusAction(useExistingRef.current);
        } else if (recoveryFocusState === 'retry') {
            focusAction(retryRef.current);
        } else {
            focusAction(failureDetailsRef.current ?? detailsRef.current);
        }
    }, [recoveryFocusState]);

    const detailsHitArea = useHappierHitArea({ restingStyle: () => null });
    const detailsToggle = (
        <Pressable
            ref={detailsRef}
            testID="personal-home-bootstrap-details-toggle"
            accessibilityRole="button"
            accessibilityLabel={t('common.details')}
            accessibilityState={{ expanded: detailsOpen }}
            onPress={toggleDetails}
            hitSlop={detailsHitArea.hitSlop}
            onLayout={detailsHitArea.onLayout}
            style={styles.detailsButton}
        >
            {detailsHitArea.frame}
            <Text style={styles.detailsText}>{detailsOpen ? t('common.collapse') : t('common.details')}</Text>
        </Pressable>
    );
    const detailsPanel = (
        <View style={styles.details} testID="personal-home-bootstrap-details-panel">
            <PersonalHomeDiagnosticDetails detail={props.snapshot.detail} activeTask={props.activeTask} />
        </View>
    );

    const content = (
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                contentInsetAdjustmentBehavior="automatic"
                keyboardShouldPersistTaps="handled"
            >
                <View style={styles.centered}>
                    <View style={styles.header}>
                        <View
                            testID="personal-home-bootstrap-progress"
                            accessible
                            accessibilityRole="progressbar"
                            accessibilityLabel={t('personalHome.bootstrap.title')}
                            accessibilityValue={{ min: 0, max: progress.totalMilestones, now: progress.completedMilestones }}
                        >
                            <CapacityRing ratio={progress.fraction} color={theme.colors.text.secondary} size={MARK_FALLBACK_SIZE}>
                                {hasFailure ? (
                                    <View style={styles.failureMark} testID="personal-home-bootstrap-failure-mark">
                                        <Icon name="warning-circle" size={FAILURE_GLYPH_SIZE} color={theme.colors.text.secondary} />
                                    </View>
                                ) : (
                                    <LoadingPlanetSlot fallbackSize={MARK_FALLBACK_SIZE} testID="personal-home-bootstrap-mark" />
                                )}
                            </CapacityRing>
                        </View>
                        <Text style={styles.title} accessibilityRole="header">
                            {t('personalHome.bootstrap.title')}
                        </Text>
                        <Text
                            testID="personal-home-bootstrap-phase"
                            accessibilityLiveRegion="polite"
                            style={styles.status}
                        >
                            {genericFailure ? t('personalHome.bootstrap.failureBody') : acquisitionFailure ?? acquisition?.status ?? phaseCopy(props.snapshot)}
                        </Text>
                        {acquisition?.downloadProgress ? (
                            <Text testID="personal-home-bootstrap-download-progress" style={styles.status}>
                                {acquisition.downloadProgress}
                            </Text>
                        ) : null}
                    </View>

                    {showExistingDecision && props.onUseExisting && props.onUseAnotherHome ? (
                        <View style={styles.recovery}>
                            <PersonalHomeExistingRuntimeDecision
                                primaryActionControlRef={(instance) => { useExistingRef.current = instance; }}
                                needsRecoveryKey={props.snapshot.detail?.code === 'existing_runtime_credentials'}
                                onUseExisting={props.onUseExisting}
                                onUseAnotherHome={props.onUseAnotherHome}
                                details={hasLocalDetails ? (
                                    <>
                                        {detailsToggle}
                                        {showDetails ? detailsPanel : null}
                                    </>
                                ) : undefined}
                            />
                        </View>
                    ) : null}

                    {showSignedInDecision && signedInHomeLabel && props.onKeepSignedInHome != null && props.onCreatePersonalHome != null ? (
                        <View style={styles.recovery}>
                            <PersonalHomeSignedInHomeDecision
                                homeLabel={signedInHomeLabel}
                                primaryActionControlRef={(instance) => { useExistingRef.current = instance; }}
                                onKeepSignedInHome={props.onKeepSignedInHome}
                                onCreatePersonalHome={props.onCreatePersonalHome}
                            />
                        </View>
                    ) : null}

                    {showFailure ? (
                        <View style={styles.recovery}>
                            <PersonalHomeSetupFailure
                                retryControlRef={(instance) => { retryRef.current = instance; }}
                                detailsControlRef={(instance) => { failureDetailsRef.current = instance; }}
                                {...(genericFailure ? { body: null } : blockedBody ? { body: blockedBody } : {})}
                                onRetry={props.snapshot.action === 'retry' ? props.onRetry : undefined}
                                onOpenDetails={failureDetailsAction}
                            >
                                {/* U10: a failure Retry cannot fix must never trap the user behind the gate. */}
                                {!showExistingDecision && props.onUseAnotherHome ? (
                                    <PersonalHomeUseAnotherHomeAction quiet onUseAnotherHome={props.onUseAnotherHome} />
                                ) : null}
                            </PersonalHomeSetupFailure>
                        </View>
                    ) : null}

                    {!showExistingDecision && !hasFailure && (props.onUseAnotherHome || hasLocalDetails) ? (
                        <View style={styles.quietActions}>
                            {props.onUseAnotherHome ? (
                                <PersonalHomeUseAnotherHomeAction quiet onUseAnotherHome={props.onUseAnotherHome} />
                            ) : null}
                            {hasLocalDetails ? detailsToggle : null}
                        </View>
                    ) : null}
                    {showDetails && !showExistingDecision ? detailsPanel : null}
                </View>
            </ScrollView>
    );
    if (props.backdrop === false) {
        return <View style={styles.root} testID="personal-home-setup-surface">{content}</View>;
    }
    return <PersonalHomeSetupBackdrop testID="personal-home-setup-surface">{content}</PersonalHomeSetupBackdrop>;
});

/** The setup surface's page: the glass the setup copy and the Loading planet stand on. */
export function PersonalHomeSetupBackdrop(props: Readonly<{ testID?: string; children?: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const { blurEnabled, blurIntensity } = useGlassBlurSetting();
    return (
        <GlassSurface
            style={styles.root}
            testID={props.testID}
            enabled={blurEnabled}
            blurIntensity={blurIntensity}
            solidColor={theme.colors.background.canvas}
        >
            {props.children}
        </GlassSurface>
    );
}
