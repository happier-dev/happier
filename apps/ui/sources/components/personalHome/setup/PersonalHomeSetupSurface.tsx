import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { presentActiveCliAcquisition } from '@/components/systemTasks/cliAcquisitionPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { Typography } from '@/constants/Typography';
import { LoadingPlanetSlot } from '@/components/atmosphere/moments/homeLoadingMoment';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { t } from '@/text';

import type { PersonalHomeBootstrapSnapshot } from '../bootstrap/personalHomeBootstrapTypes';
import {
    PersonalHomeExistingRuntimeDecision,
    PersonalHomeSignedInHomeDecision,
    PersonalHomeUseAnotherHomeAction,
} from './PersonalHomeExistingRuntimeDecision';
import { PersonalHomeDiagnosticDetails } from './PersonalHomeDiagnosticDetails';
import { derivePersonalHomeSetupProgress } from './personalHomeSetupProgress';
import { presentPersonalHomeSetup } from './personalHomeSetupPresentation';

const CONTENT_MAX_WIDTH = 520;
/** The mark's room when no Loading host places the planet in it (the former setup mark's size). */
const MARK_FALLBACK_SIZE = 76;
const RECOVERY_MAX_WIDTH = 420;

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { flexGrow: 1, paddingHorizontal: theme.space.s32, paddingVertical: theme.space.s40, alignItems: 'center' },
    // Auto margins centre the composition while keeping BOTH overflow edges reachable at compact
    // heights and large text sizes, which `justifyContent: 'center'` alone does not on web.
    centered: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignItems: 'center', marginVertical: 'auto', gap: theme.space.s24 },
    header: { alignItems: 'center', gap: theme.space.s12 },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('display'),
        textAlign: 'center',
    },
    // While setup works, two lines are reserved so a changing status sentence never moves the mark above it.
    status: {
        ...Typography.variant('reading'),
        color: theme.colors.text.secondary,
        maxWidth: 400,
        textAlign: 'center',
    },
    workingStatus: { minHeight: 44 },
    recovery: { width: '100%', maxWidth: RECOVERY_MAX_WIDTH, alignItems: 'center', gap: theme.space.s16 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: theme.space.s10 },
    detailsPanel: { alignSelf: 'stretch' },
}));

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

/**
 * First-run Personal Home setup. Each state of the canonical bootstrap snapshot reads as itself:
 * setup working (the Loading planet in its progress ring), a choice (the question as the heading,
 * its answers as cards), a failure (what did not happen, why in human words, Retry), ready. The one
 * "Technical details" disclosure holds the runtime's own words and reason code.
 */
export const PersonalHomeSetupSurface = React.memo(function PersonalHomeSetupSurface(props: Readonly<{
    snapshot: PersonalHomeBootstrapSnapshot;
    activeTask?: SystemTaskRunState | null;
    onRetry?: () => void;
    /** A host that shows details elsewhere; without it, Details opens in place. */
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
    const recoveryActionRef = React.useRef<FocusableAction | null>(null);
    const focusedRecoveryStateRef = React.useRef<string | null>(null);
    const progress = derivePersonalHomeSetupProgress(props.snapshot);
    const presentation = presentPersonalHomeSetup(props.snapshot);
    const acquisition = progress.working ? presentActiveCliAcquisition(props.activeTask) : null;
    const showsProgress = presentation.kind === 'working' || presentation.kind === 'ready';
    const failure = presentation.kind === 'failure' ? presentation : null;
    const onFailureRetry = failure?.retry === 'use-existing' ? props.onUseExisting : props.snapshot.action === 'retry' ? props.onRetry : undefined;
    const choice = presentation.kind === 'choice' ? presentation.choice : null;
    const showExistingDecision = (choice === 'existing-runtime' || choice === 'existing-runtime-credentials')
        && props.onUseExisting != null && props.onUseAnotherHome != null;
    const showSignedInDecision = choice === 'signed-in-home'
        && props.snapshot.signedInHomeLabel != null
        && props.onKeepSignedInHome != null
        && props.onCreatePersonalHome != null;
    // A choice is a question, not a fault: only working and failed setup carry Technical details.
    const hasDetails = choice === null && (props.activeTask != null || props.snapshot.detail != null || props.onOpenDetails != null);
    const status = acquisition?.status ?? presentation.status;

    const recoveryFocusState = showSignedInDecision
        ? 'signed-in-home'
        : showExistingDecision
            ? 'existing-runtime'
            : failure && onFailureRetry
                ? `retry:${failure.retry}`
                : null;
    React.useEffect(() => {
        if (recoveryFocusState === null) {
            focusedRecoveryStateRef.current = null;
            return;
        }
        if (focusedRecoveryStateRef.current === recoveryFocusState) return;
        focusedRecoveryStateRef.current = recoveryFocusState;
        focusAction(recoveryActionRef.current);
    }, [recoveryFocusState]);
    const recoveryActionControlRef = React.useCallback((instance: FocusableAction | null) => {
        recoveryActionRef.current = instance;
    }, []);

    const content = (
        <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.centered}>
                <View style={styles.header}>
                    {showsProgress ? (
                        <View
                            testID="personal-home-bootstrap-progress"
                            accessible={progress.working}
                            {...(progress.working ? {
                                accessibilityRole: 'progressbar',
                                accessibilityLabel: t('personalHome.bootstrap.title'),
                                accessibilityValue: { min: 0, max: progress.totalMilestones, now: progress.completedMilestones },
                            } as const : {})}
                        >
                            <CapacityRing ratio={progress.fraction} color={theme.colors.text.secondary} size={MARK_FALLBACK_SIZE}>
                                <LoadingPlanetSlot fallbackSize={MARK_FALLBACK_SIZE} testID="personal-home-bootstrap-mark" />
                            </CapacityRing>
                        </View>
                    ) : null}
                    <Text testID="personal-home-bootstrap-title" style={styles.title} accessibilityRole="header">
                        {presentation.title}
                    </Text>
                    {/* One live sentence: a status while setup works or asks, an alert when it failed. */}
                    <Text
                        testID="personal-home-bootstrap-phase"
                        {...(failure
                            ? { accessibilityRole: 'alert' as const, accessibilityLiveRegion: 'assertive' as const }
                            : { accessibilityLiveRegion: 'polite' as const })}
                        style={[styles.status, showsProgress ? styles.workingStatus : null]}
                    >
                        {status}
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
                            primaryActionControlRef={recoveryActionControlRef}
                            needsRecoveryKey={choice === 'existing-runtime-credentials'}
                            onUseExisting={props.onUseExisting}
                            onUseAnotherHome={props.onUseAnotherHome}
                        />
                    </View>
                ) : null}

                {showSignedInDecision && props.snapshot.signedInHomeLabel != null && props.onKeepSignedInHome && props.onCreatePersonalHome ? (
                    <View style={styles.recovery}>
                        <PersonalHomeSignedInHomeDecision
                            homeLabel={props.snapshot.signedInHomeLabel}
                            primaryActionControlRef={recoveryActionControlRef}
                            onKeepSignedInHome={props.onKeepSignedInHome}
                            onCreatePersonalHome={props.onCreatePersonalHome}
                        />
                    </View>
                ) : null}

                {choice === null && (onFailureRetry || props.onUseAnotherHome || hasDetails) ? (
                    <View testID={failure ? 'personal-home-bootstrap-failure' : undefined} style={styles.recovery}>
                        {onFailureRetry || props.onUseAnotherHome ? (
                            <View style={styles.actions}>
                                {failure && onFailureRetry ? (
                                    <RoundButton
                                        size="normal"
                                        controlRef={recoveryActionControlRef}
                                        testID="personal-home-bootstrap-retry"
                                        accessibilityLabel={failure.retryLabel}
                                        onPress={onFailureRetry}
                                        title={failure.retryLabel}
                                    />
                                ) : null}
                                {/* U10: a failure Retry cannot fix must never trap the user behind the gate. */}
                                {props.onUseAnotherHome ? (
                                    <PersonalHomeUseAnotherHomeAction quiet onUseAnotherHome={props.onUseAnotherHome} />
                                ) : null}
                            </View>
                        ) : null}
                        {hasDetails ? (
                            <PersonalHomeSetupDetails
                                snapshot={props.snapshot}
                                activeTask={props.activeTask}
                                shownSummary={status}
                                onOpenDetails={props.onOpenDetails}
                            />
                        ) : null}
                    </View>
                ) : null}
            </View>
        </ScrollView>
    );
    if (props.backdrop === false) {
        return <View style={styles.root} testID="personal-home-setup-surface">{content}</View>;
    }
    return <PersonalHomeSetupBackdrop testID="personal-home-setup-surface">{content}</PersonalHomeSetupBackdrop>;
});

/**
 * The one Details control: the shared in-place disclosure (`HappierDisclosureToggle` with core's caret, label and
 * focus binding, as a state card's Details), labelled like it. It opens in place unless a host shows details itself.
 */
function PersonalHomeSetupDetails(props: Readonly<{
    snapshot: PersonalHomeBootstrapSnapshot;
    activeTask?: SystemTaskRunState | null;
    shownSummary: string;
    onOpenDetails?: () => void;
}>) {
    const binding = useCoreDisclosureToggleBinding();
    const [open, setOpen] = React.useState(false);
    const { onOpenDetails } = props;
    const toggle = React.useCallback(() => {
        if (onOpenDetails) onOpenDetails();
        else setOpen((value) => !value);
    }, [onOpenDetails]);
    const label = t('approvals.technicalDetails');
    return (
        <>
            <HappierDisclosureToggle
                testID="personal-home-bootstrap-details"
                label={label}
                open={open}
                onPress={toggle}
                align="center"
                caret={binding.renderCaret(open)}
                renderLabel={binding.renderLabel}
                focusColor={binding.focusColor}
            />
            {open ? (
                <View testID="personal-home-bootstrap-details-panel" style={styles.detailsPanel}>
                    <PersonalHomeDiagnosticDetails
                        detail={props.snapshot.detail}
                        activeTask={props.activeTask}
                        shownSummary={props.shownSummary}
                        align="center"
                    />
                </View>
            ) : null}
        </>
    );
}

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
