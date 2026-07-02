import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { StepTransitionDirection } from '@/components/ui/motion/StepTransitionFrame';

import { BrandPanel } from './BrandPanel';
import { WorkflowPanel, type WorkflowPanelPresentation } from './WorkflowPanel';
import { useUnauthShellLayout } from './useUnauthShellLayout';

export type UnauthenticatedWorkflowPresentation = WorkflowPanelPresentation;

export type UnauthenticatedSplitShellProps = Readonly<{
    /**
     * The current step body. For dev/ this is whatever
     * `renderOnboardingWizardStepBody` returns; for remote-dev/ this is the
     * route-specific content (extracted NotAuthenticated body, RestoreQrView,
     * etc.).
     */
    children: React.ReactNode;

    /**
     * Identifier of the current step / route. Drives the transition animation
     * key so swaps fade/slide.
     */
    stepId: string;

    /**
     * Whether the current step is the welcome decision screen. Controls
     * rendering of `WelcomeFooterLinks` in the workflow pane.
     */
    isWelcomeStep: boolean;

    /**
     * Whether the one-time mobile brand hero may be shown on this step.
     * Defaults to `isWelcomeStep`. Must be `false` for restore, OAuth
     * callback, mTLS callback, and setup deep links so a fresh-device user
     * never gets a brand prelude in front of an urgent recovery flow.
     */
    allowMobileBrandHero?: boolean;

    /**
     * Callback for "Use your own Relay" in the welcome footer.
     */
    onOpenRelayCustomFlow: () => void;

    /**
     * Callback for the "Get started" button on the mobile brand hero
     * prelude. Must apply `{ brandHeroSeenAt: Date.now() }` to local
     * settings — typically `useApplyBrandHeroSeen()` from this folder. The
     * shell re-renders into `mobile-workflow` after the local setting flips.
     * No wizard/route dispatch is required for this prelude.
     */
    onBrandHeroGetStarted: () => void;

    /**
     * Back navigation callback. If undefined, no back chevron is rendered.
     */
    onBack?: () => void;

    /**
     * Direction of the most recent step transition. Default 'forward'.
     */
    transitionDirection?: StepTransitionDirection;

    /**
     * Controls the workflow pane's mobile padding. Use `fullBleed` only for
     * camera/scanner-style steps that own their own overlay controls and need
     * to fill the entire native viewport. Normal form/list steps stay padded.
     */
    workflowPresentation?: UnauthenticatedWorkflowPresentation;

    testID?: string;
}>;

/**
 * Unified pre-auth shell for the Happier app. Owns the chrome around all
 * unauthenticated content:
 *
 * - **Desktop** (width > 720px): a 50/50 split with a persistent BrandPanel
 *   on the left and a swappable WorkflowPanel on the right.
 * - **Mobile** (width ≤ 720px): either the one-time BrandPanel prelude
 *   (when `brandHeroSeenAt == null` and `allowMobileBrandHero === true`) or
 *   a full-screen WorkflowPanel.
 *
 * Step bodies render inside the workflow pane as-is; the shell does not
 * inspect their internals.
 *
 * See `.project/plans/unified-onboarding-redesign/03-shared-shell.md` for
 * the full contract and `02-design-system.md` for visual values.
 */
export const UnauthenticatedSplitShell = React.memo(function UnauthenticatedSplitShell(
    props: UnauthenticatedSplitShellProps,
) {
    const styles = stylesheet;

    const allowMobileBrandHero = props.allowMobileBrandHero ?? props.isWelcomeStep;
    const layout = useUnauthShellLayout({ allowMobileBrandHero });
    const transitionDirection: StepTransitionDirection = props.transitionDirection ?? 'forward';

    if (layout === 'split') {
        return (
            <View
                testID={props.testID ?? 'unauth-shell-split'}
                style={styles.splitRoot}
            >
                <BrandPanel variant="desktop" />
                <WorkflowPanel
                    variant="desktop"
                    isWelcomeStep={props.isWelcomeStep}
                    onOpenRelayCustomFlow={props.onOpenRelayCustomFlow}
                    onBack={props.onBack}
                    transitionKey={props.stepId}
                    transitionDirection={transitionDirection}
                    presentation={props.workflowPresentation ?? 'padded'}
                >
                    {props.children}
                </WorkflowPanel>
            </View>
        );
    }

    if (layout === 'mobile-hero') {
        return (
            <View
                testID={props.testID ?? 'unauth-shell-mobile-hero'}
                style={styles.mobileOnlyRoot}
            >
                <BrandPanel
                    variant="mobile-hero"
                    onGetStarted={props.onBrandHeroGetStarted}
                />
            </View>
        );
    }

    // layout === 'mobile-workflow'
    return (
        <View
            testID={props.testID ?? 'unauth-shell-mobile-workflow'}
            style={styles.mobileOnlyRoot}
        >
            <WorkflowPanel
                variant="mobile"
                isWelcomeStep={props.isWelcomeStep}
                onOpenRelayCustomFlow={props.onOpenRelayCustomFlow}
                onBack={props.onBack}
                transitionKey={props.stepId}
                transitionDirection={transitionDirection}
                presentation={props.workflowPresentation ?? 'padded'}
            >
                {props.children}
            </WorkflowPanel>
        </View>
    );
});

const stylesheet = StyleSheet.create(() => ({
    splitRoot: {
        flex: 1,
        flexDirection: 'row',
    },
    mobileOnlyRoot: {
        flex: 1,
    },
}));
