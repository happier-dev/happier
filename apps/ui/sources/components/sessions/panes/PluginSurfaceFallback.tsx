import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonRows } from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import {
    SurfaceStateCard,
    type SurfaceStateAction,
    type SurfaceStateAccessibilitySemantics,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    resolvePluginSurfaceStatePresentation,
    type PluginSurfacePresentationState,
    type PluginSurfaceStatePresentation,
} from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

type PluginSurfaceFallbackState = Extract<PluginSurfacePresentationState, 'loading' | 'unavailable'>;

type PluginSurfaceFallbackPresentationOptions = Readonly<{
    state?: PluginSurfaceFallbackState;
    reasonCode?: string | null;
}>;

/** Search only the human copy drawn by the unavailable card, never its diagnostic disclosure. */
export function projectPluginSurfaceFallbackFindText(
    options: PluginSurfaceFallbackPresentationOptions = {},
): readonly Readonly<{ id: string; text: string; format: 'plain' }>[] {
    const { card } = resolvePluginSurfaceStatePresentation({
        state: options.state ?? 'unavailable',
        reasonCode: options.reasonCode,
    });
    if (!card || card.kind === 'loading') return [];
    return [
        { id: 'structured-unavailable-title', text: card.title, format: 'plain' },
        ...(card.reason ? [{ id: 'structured-unavailable-reason', text: card.reason, format: 'plain' as const }] : []),
    ];
}

/** Destination-shaped placeholder: enough list rows to read as the page that is coming. */
const LOADING_SKELETON_ROWS = 4;

/**
 * The one action-selection rule for every plugin surface state card. The
 * shared presentation owner classifies the reason; the caller supplies only
 * the callbacks it really owns:
 *
 * - a transient reason gets Retry, and only when `onRetry` is a real host
 *   retry for the failing phase — never a Manage detour;
 * - a configuration reason gets the route-owned management callback under the
 *   semantic label (Manage plugin / Update / Enable);
 * - an unclassified reason gets Retry only when the renderer offers one.
 *
 * At most one action is returned, so a card never competes with itself.
 */
export function resolvePluginSurfaceStateAction(input: Readonly<{
    recoveryAction: PluginSurfaceStatePresentation['recoveryAction'];
    onRetry?: () => void;
    manageAction?: SurfaceStateAction;
}>): SurfaceStateAction | undefined {
    const semantic = input.recoveryAction;
    if (semantic === null) {
        return input.onRetry ? { label: t('common.retry'), onPress: input.onRetry } : undefined;
    }
    if (semantic.kind === 'retry') {
        return input.onRetry ? { label: semantic.label, onPress: input.onRetry } : undefined;
    }
    return input.manageAction
        ? { label: semantic.label, onPress: input.manageAction.onPress }
        : undefined;
}

export function PluginSurfaceFallback(props: Readonly<{
    testID: string;
    /** Factual host-owned phase; terminal unavailability remains the default. */
    state?: PluginSurfaceFallbackState;
    /** Raw host/runtime diagnostic; the shared presentation owner localizes it. */
    reasonCode?: string | null;
    /** Caller-owned plugin management route; shown only when management is the fix. */
    action?: SurfaceStateAction;
    /** Host-owned retry of the failing phase; shown only for transient reasons. */
    onRetry?: () => void;
    /** Dynamic mount states announce through the shared surface-state owner. */
    accessibilitySemantics?: SurfaceStateAccessibilitySemantics;
    /** Glyph-only decoration; semantic title and reason remain the shared owner's strings. */
    renderText?: (field: 'title' | 'reason', text: string) => React.ReactNode;
}>): React.ReactElement {
    const presentation = resolvePluginSurfaceStatePresentation({
        state: props.state ?? 'unavailable',
        reasonCode: props.reasonCode,
    });
    const card = presentation.card;
    if (!card) {
        throw new Error('plugin_surface_unavailable_presentation_missing_card');
    }
    if (card.kind === 'loading') {
        return (
            <PluginSurfaceLoadingSkeleton
                testID={props.testID}
                accessibilityLabel={card.title}
                diagnosticCode={presentation.diagnosticCode}
            />
        );
    }
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind={card.kind}
            title={card.title}
            titleContent={props.renderText?.('title', card.title)}
            reason={card.reason}
            reasonContent={card.reason ? props.renderText?.('reason', card.reason) : undefined}
            diagnosticCode={presentation.diagnosticCode}
            action={resolvePluginSurfaceStateAction({
                recoveryAction: presentation.recoveryAction,
                onRetry: props.onRetry,
                manageAction: props.action,
            })}
            accessibilitySemantics={props.accessibilitySemantics ?? card.accessibilitySemantics}
        />
    );
}

/**
 * Loading is not a problem to explain: the placeholder takes the shape of the
 * list the plugin page will draw, with no copy and no action, and is announced
 * once as a busy region. Its reason stays on the testID marker for QA only.
 */
function PluginSurfaceLoadingSkeleton(props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    diagnosticCode: string | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const reducedMotion = useReducedMotionPreference();
    return (
        <View testID={props.testID} style={{ flex: 1, paddingTop: pluginTheme.spacing.small }}>
            <HappierSkeletonRows
                testID={`${props.testID}-loading-skeleton`}
                rows={LOADING_SKELETON_ROWS}
                theme={pluginTheme}
                accessibilityLabel={props.accessibilityLabel}
                reducedMotion={reducedMotion}
            />
            {props.diagnosticCode ? (
                <View
                    testID={`${props.testID}-diagnostic-${props.diagnosticCode}`}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={{ width: 0, height: 0 }}
                />
            ) : null}
        </View>
    );
}
