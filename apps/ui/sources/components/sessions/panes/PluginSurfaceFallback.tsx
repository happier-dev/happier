import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonRows } from '@happier-dev/plugin-ui/presentation';
import { CollectionLoadingRows } from '@happier-dev/plugin-ui/components';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { PluginSurfacePageHeaderContext } from '@/components/plugins/shared/pluginSurfaceInteractionAvailability';
import { usePublishPluginSurfaceStateTitle } from '@/components/plugins/shared/pluginSurfaceStateTitle';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { usePageSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { useClaimedHostFailureNotice } from '@/components/ui/surfaces/claimableSurfaceNotice';
import {
    SurfaceStateCard,
    type SurfaceStateAction,
    type SurfaceStateAccessibilitySemantics,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    isPluginSurfaceCauseOutsidePlugin,
    resolvePluginSurfaceStatePresentation,
    type PluginSurfacePresentationState,
    type PluginSurfaceStatePresentation,
} from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

type PluginSurfaceFallbackState = Extract<PluginSurfacePresentationState, 'loading' | 'unavailable'>;

type PluginSurfaceFallbackPresentationOptions = Readonly<{
    state?: PluginSurfaceFallbackState;
    reasonCode?: string | null;
    reason?: string;
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
    const reason = options.reason ?? card.reason;
    return [
        { id: 'structured-unavailable-title', text: card.title, format: 'plain' },
        ...(reason ? [{ id: 'structured-unavailable-reason', text: reason, format: 'plain' as const }] : []),
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
 * - an Account acquisition refusal joins Sync's existing Availability queue
 *   before retrying the optional renderer-local mount.
 *
 * At most one action is returned, so a card never competes with itself.
 */
export function resolvePluginSurfaceStateAction(input: Readonly<{
    recoveryAction: PluginSurfaceStatePresentation['recoveryAction'];
    onRetry?: () => void;
    manageAction?: SurfaceStateAction;
}>): SurfaceStateAction | undefined {
    const semantic = input.recoveryAction;
    if (semantic?.kind === 'retry' && semantic.retryTarget === 'accountAvailability') {
        return { label: semantic.label, onPress: () => {
            void getSyncSingleton().refreshPluginAccountAvailability()
                .then(() => input.onRetry?.())
                // The acquisition owner publishes the typed failed state.
                .catch(() => {});
        } };
    }
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
    /** Content-free host cause, disclosed only in Details. */
    diagnosticDetail?: string | null;
    /** Already-localized declaration text; never an untrusted runtime diagnostic. */
    reason?: string;
    /** Caller-owned plugin management route; shown only when management is the fix. */
    action?: SurfaceStateAction;
    /** Host-owned retry of the failing phase; shown only for transient reasons. */
    onRetry?: () => void;
    /** Dynamic mount states announce through the shared surface-state owner. */
    accessibilitySemantics?: SurfaceStateAccessibilitySemantics;
    /** Glyph-only decoration; semantic title and reason remain the shared owner's strings. */
    renderText?: (field: 'title' | 'reason', text: string) => React.ReactNode;
    /** The plugin's display name, so a whole-page card says which plugin failed. */
    subjectName?: string;
}>): React.ReactElement {
    const presentation = resolvePluginSurfaceStatePresentation({
        state: props.state ?? 'unavailable',
        reasonCode: props.reasonCode,
        subjectName: props.subjectName,
    });
    // On a plugin page route that has loaded nothing, the page keeps its identity (title, mark, the
    // route's Back) above the state, in the page column the loaded page will use, like the offline
    // state (`PluginSurfaceInteractionBoundary`). Mounted content resets this to null.
    const pageIdentity = React.useContext(PluginSurfacePageHeaderContext);
    const pageHeader = pageIdentity?.header;
    // A page route that loaded nothing is a page-level state: it takes the page step (and its failed scene).
    const pageStateSize = usePageSurfaceStateSize();
    const card = presentation.card;
    if (!card) {
        throw new Error('plugin_surface_unavailable_presentation_missing_card');
    }
    // The host's line about this body (a widget's Machine notice) and this failure are one failure, said once.
    const hostNotice = useClaimedHostFailureNotice(card.kind !== 'loading', isPluginSurfaceCauseOutsidePlugin(props.reasonCode));
    const title = hostNotice?.sentence ?? card.title;
    usePublishPluginSurfaceStateTitle(card.kind === 'loading' ? null : title);
    const action = card.kind === 'loading' ? undefined : hostNotice && hostNotice.action !== undefined
        ? hostNotice.action ?? undefined : resolvePluginSurfaceStateAction({
            recoveryAction: presentation.recoveryAction, onRetry: props.onRetry, manageAction: props.action,
        });
    const commands = useCurrentUiContextLocalCommands(action ? [{ key: 'recovery', title: action.label,
        invoke: action.onPress }] : [], { contextKey: props.testID, unbound: 'local' });
    if (card.kind === 'loading') {
        const skeleton = (
            <PluginSurfaceLoadingSkeleton
                testID={props.testID}
                accessibilityLabel={card.title}
                diagnosticCode={presentation.diagnosticCode}
                shape={pageIdentity?.loadingFrame === 'collection' ? 'collection' : 'list'}
            />
        );
        if (!pageHeader) return skeleton;
        // A Collection page fills its content area under its toolbar; every other page sits in the page column.
        return pageIdentity?.loadingFrame === 'collection'
            ? <View style={{ flex: 1 }}>{pageHeader}{skeleton}</View>
            : <PageFrame content="column" style={{ flex: 1 }}>{pageHeader}{skeleton}</PageFrame>;
    }
    return (
        <>
        {pageHeader}
        <SurfaceStateCard
            testID={props.testID}
            kind={hostNotice ? 'unavailable' : card.kind}
            size={hostNotice ? 'line' : pageHeader ? pageStateSize : undefined}
            title={title}
            titleContent={props.renderText?.('title', title)}
            reason={hostNotice ? undefined : props.reason ?? card.reason}
            reasonContent={!hostNotice && (props.reason ?? card.reason) ? props.renderText?.('reason', (props.reason ?? card.reason)!) : undefined}
            diagnosticCode={presentation.diagnosticCode}
            diagnosticDetail={props.diagnosticDetail}
            action={action ? { ...action, onPress: () => { void commands.invoke('recovery'); } } : undefined}
            accessibilitySemantics={props.accessibilitySemantics ?? card.accessibilitySemantics}
        />
        </>
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
    /** `collection`: the rows of the Collection page that is coming, in its table frame; `list`: a generic list. */
    shape: 'list' | 'collection';
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    const reducedMotion = useReducedMotionPreference();
    return (
        <View testID={props.testID} style={{ flex: 1, paddingTop: props.shape === 'collection' ? 0 : pluginTheme.spacing.small }}>
            {props.shape === 'collection' ? (
                <CollectionLoadingRows
                    testID={`${props.testID}-loading-skeleton`}
                    theme={pluginTheme}
                    accessibilityLabel={props.accessibilityLabel}
                    reducedMotion={reducedMotion}
                />
            ) : (
                <HappierSkeletonRows
                    testID={`${props.testID}-loading-skeleton`}
                    rows={LOADING_SKELETON_ROWS}
                    theme={pluginTheme}
                    accessibilityLabel={props.accessibilityLabel}
                    reducedMotion={reducedMotion}
                />
            )}
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
