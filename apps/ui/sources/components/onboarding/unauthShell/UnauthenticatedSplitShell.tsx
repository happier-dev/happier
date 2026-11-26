import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierFieldBoxHeightScope } from '@happier-dev/plugin-ui/presentation';

import { useGlyphFieldTap } from '@/components/atmosphere/glyph/useHomeGlyphField';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { GlassAtmosphereScope } from '@/components/ui/glass/glassRuntimeEnvironment';

import { STEP_FIELD_HEIGHT_PX } from './StepFormParts';
import { WelcomeAtmosphere } from './WelcomeAtmosphere';
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

    /** Shows the compact mobile product mark without turning the step into welcome content. */
    showMobileWordmark?: boolean;

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
    warmStepMotion?: boolean;

    /** The workflow pane's one bottom-right control (the signed-out Updates entry); see `WorkflowPanel`. */
    footerAccessory?: React.ReactNode;

    /** The opening replica is sized to the destination inside the larger presenter window. */
    frameWidth?: number;
    /** An opening presenter supplies the canvas behind its full-screen atmosphere. */
    transparentCanvas?: boolean;
    testID?: string;
}>;

/**
 * The signed-out shell, direction A (owner 2026-11-19): one centred column over the welcome atmosphere (the glyph
 * planet in the step's welcome pose and the living dot field, `WelcomeAtmosphere`) on every width. The wordmark
 * stands top-left, the links are a quiet line bottom-left on a computer and a row under the column on a phone.
 * Step bodies render inside the workflow column as-is; the shell does not inspect their internals.
 */
export const UnauthenticatedSplitShell = React.memo(function UnauthenticatedSplitShell(
    props: UnauthenticatedSplitShellProps,
) {
    const styles = stylesheet;
    const layout = useUnauthShellLayout(props.frameWidth);
    const compact = layout === 'compact';
    const fieldHost = React.useRef<View | null>(null);
    const readWebAtmosphere = React.useCallback(() => {
        const root = fieldHost.current;
        return typeof HTMLElement !== 'undefined' && root instanceof HTMLElement
            ? root.querySelector<HTMLElement>('[data-testid="welcome-atmosphere"]') ?? undefined
            : undefined;
    }, []);
    const { tap, onTouchEnd } = useGlyphFieldTap(fieldHost);
    const [quietColumn, setQuietColumn] = React.useState<Readonly<{ x: number; width: number }> | null>(null);
    const onColumnLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { x, width } = event.nativeEvent.layout;
        if (width <= 0) return;
        setQuietColumn(current => current?.x === x && current.width === width ? current : { x, width });
    }, []);
    const presentation = props.workflowPresentation ?? 'padded';
    const measureColumn = presentation !== 'fullBleed';
    const planetState = props.isWelcomeStep ? 'welcome' : 'deep';
    return (
        <View ref={fieldHost} collapsable={false} testID={props.testID ?? 'unauth-shell'}
            style={[styles.root, !props.transparentCanvas && styles.canvas]} onTouchEnd={onTouchEnd}>
            <WelcomeAtmosphere
                state={planetState}
                stepId={props.stepId}
                phone={compact}
                host={fieldHost}
                nativeTap={tap}
                quietColumn={measureColumn ? quietColumn : null}
            />
            {/* The column's Elements (choices, the command line, wells and pills) stand on that atmosphere: glass. */}
            <GlassAtmosphereScope behind="band">
            <WorkflowPanel
                variant={compact ? 'mobile' : 'desktop'}
                isWelcomeStep={props.isWelcomeStep}
                planetState={planetState}
                showMobileWordmark={props.showMobileWordmark}
                onBack={props.onBack}
                transitionKey={props.stepId}
                warmStepMotion={props.warmStepMotion}
                presentation={presentation}
                onColumnLayout={measureColumn ? onColumnLayout : undefined}
                webAtmosphere={readWebAtmosphere}
                footerAccessory={props.footerAccessory}
            >
                {/*
                  * The workflow is one narrow column on every device, so its
                  * states take the narrow-column step: readable title, and
                  * actions as wide as the column like every other choice here.
                  */}
                <SurfaceStateSizeProvider size="phone">
                    {/* Every field of every step stands at one height, the step's call to action's. */}
                    <HappierFieldBoxHeightScope heightPx={STEP_FIELD_HEIGHT_PX}>
                        {props.children}
                    </HappierFieldBoxHeightScope>
                </SurfaceStateSizeProvider>
            </WorkflowPanel>
            </GlassAtmosphereScope>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
    },
    canvas: {
        backgroundColor: theme.colors.background.canvas,
    },
}));
