import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';

import { BrandPanel } from './BrandPanel';
import { StagePane } from './StagePane';
import { WorkflowPanel, type WorkflowPanelPresentation } from './WorkflowPanel';
import { useUnauthShellLayout } from './useUnauthShellLayout';
import type { RelayRetentionDisclosureState } from './RelayRetentionDisclosure';

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

    /** Shows the compact mobile product mark without turning the step into welcome content. */
    showMobileWordmark?: boolean;

    /** Compact server-owned retention disclosure shown above the welcome footer links. */
    retentionDisclosure?: RelayRetentionDisclosureState | null;

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
     * prelude. Records the timestamp in device history through
     * `useApplyBrandHeroSeen()` from this folder. The shell re-renders into
     * `mobile-workflow` after that history changes.
     * No wizard/route dispatch is required for this prelude.
     */
    onBrandHeroGetStarted: () => void;

    /**
     * Back navigation callback. If undefined, no back chevron is rendered.
     */
    onBack?: () => void;

    /**
     * Controls the workflow pane's mobile padding. Use `fullBleed` only for
     * camera/scanner-style steps that own their own overlay controls and need
     * to fill the entire native viewport. Normal form/list steps stay padded.
     */
    workflowPresentation?: UnauthenticatedWorkflowPresentation;

    /** The workflow pane's one bottom-right control (the signed-out Updates entry); see `WorkflowPanel`. */
    footerAccessory?: React.ReactNode;

    testID?: string;
}>;

/**
 * Unified pre-auth shell for the Happier app. Owns the chrome around all
 * unauthenticated content:
 *
 * - **Desktop** (width > 720px): a split with a persistent StagePane (planet
 *   + brand) on the left and the swappable WorkflowPanel on the right.
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

    const isSplit = layout === 'split';
    // Keep the workflow in the same child slot across the breakpoint: its
    // recovery forms and in-progress authentication must not remount.
    return (
        <View
            testID={props.testID ?? (isSplit ? 'unauth-shell-split' : 'unauth-shell-mobile-workflow')}
            style={isSplit ? styles.splitRoot : styles.mobileOnlyRoot}
        >
            {isSplit ? <StagePane /> : null}
            <WorkflowPanel
                variant={isSplit ? 'desktop' : 'mobile'}
                isWelcomeStep={props.isWelcomeStep}
                showMobileWordmark={props.showMobileWordmark}
                retentionDisclosure={props.retentionDisclosure}
                onOpenRelayCustomFlow={props.onOpenRelayCustomFlow}
                onBack={props.onBack}
                transitionKey={props.stepId}
                presentation={props.workflowPresentation ?? 'padded'}
                footerAccessory={props.footerAccessory}
            >
                {/*
                  * The workflow is one narrow column on every device, so its
                  * states take the narrow-column step: readable title, and
                  * actions as wide as the column like every other choice here.
                  */}
                <SurfaceStateSizeProvider size="phone">
                    {props.children}
                </SurfaceStateSizeProvider>
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
