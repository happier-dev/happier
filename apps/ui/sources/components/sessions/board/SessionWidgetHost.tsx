import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { formatHappierAsOfTime, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type {
    SessionBoardItemWidth,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';
import { getSessionBoardWidgetFootprintV1, resolveSessionBoardWidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { WidgetFrame, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { WidgetFrameBodyCaptionContext, WidgetFrameBodyMetaContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { focusNativeAccessibilityTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import {
    HostedHtmlSurfaceAdapter,
    type CallerHostedHtmlRuntime,
} from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    resolveSessionBoardMountMode,
    sessionBoardSourceRequiresExclusiveMount,
    type SessionBoardExecutableCurrentness,
    type SessionBoardItemProjection,
    type SessionBoardMountHost,
} from '@/sync/domains/session/board';

import { SessionBoardDeclarativeContent } from './SessionBoardDeclarativeContent';
import { SessionWalkthroughWidgetContent } from './SessionWalkthroughWidgetContent';
import { UnavailableInstalledWidget } from '@/components/widgets/InstalledWidgetSurface';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { useSessionWidgetSurface, useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { readSessionWidgetProvidedContext } from '@/components/widgets/surface/sessionWidgetContext';
import { useWidgetDefinitionFlows, type WidgetDefinitionSessionItem } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { runWidgetDefinitionCommand } from '@/components/widgets/definitions/widgetDefinitionCommands';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { WidgetSnapshotCaptureContext } from '@/components/widgets/definitions/widgetSnapshotCapture';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { WIDGET_MENU_MAX_HEIGHT_PX } from '@/components/widgets/frame/widgetFrameMenu';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { resolveWidgetSizeChoicesV1, canPromoteSessionWidgetDefinitionSourceV1, projectWidgetDefinitionPromotionBindingsV1, type WidgetInputBindingsV1, type WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { renderWidgetSizeMenuSection, stepWidgetSizeControl, type WidgetSizeControl } from '@/components/widgets/frame/WidgetSizeControl';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { useActiveServerAccountScope, useActiveServerAccountScopeLifetime, useUser } from '@/sync/domains/state/storage';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { resolveBoardWidgetProvenance } from '@/components/widgets/boardWidgetProvenance';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { SessionBoardHostActionBinding } from './sessionBoardHostActions';
import {
    resolveSessionBoardItemPresentation,
    resolveSessionBoardItemTitle,
    type SessionBoardItemActionKind,
    type SessionBoardSourceAvailabilityResolver,
} from './sessionBoardItemPresentation';
import {
    resolveSessionBoardItemHeight,
    resolveSessionBoardReplyHeight,
    type SessionBoardHeightBounds,
} from './sessionBoardItemHeight';
import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityTargetFeedback, useSessionSurfaceEntityDrag, type SessionSurfaceEntityBinding } from './SessionSurfaceEntityDrag';
import { buildSessionBoardItemActions, type SessionBoardItemMenuInput } from './sessionBoardItemMenu';
import { SessionVisualCopyPanel } from './SessionVisualCopyPanel';
import { SessionVisualNetworkPanel } from './SessionVisualNetworkPanel';
import { readSessionVisualNetworkChoice, type SessionVisualNetworkChoice } from './sessionBoardVisualNetwork';
import { WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';

/**
 * The ONE durable Board item shell.
 *
 * It owns the item's title, provenance, frame, height and typed states, derives
 * whether this placement is the executable mount, and then hands rendering to the
 * incumbent renderer for the item's source. It never renders surface content
 * itself and never branches per host: Details, focused Details, the compact
 * sidebar, inline transcript references, the mobile Cockpit and the Companion all
 * mount this component through one of the three presentations below.
 *
 * Protocol and persistence say `item`; `widget` is the word people see.
 */

export type SessionWidgetDensity =
    /** The spacious Board grid. */
    | 'full'
    /** The one-column sidebar monitor/navigator. */
    | 'compact'
    /** An inert reference: inline transcript results and non-primary placements. */
    | 'preview';

export type SessionWidgetHostProps = Readonly<{
    entityDrag?: SessionSurfaceEntityBinding;
    /** Publishes the title this card shows (null, with the title it held, when it leaves) to the Board's drag descriptions. */
    onDisplayTitle?: (title: string | null, previous?: string) => void;
    sessionId: string;
    serverId?: string | null;
    /** Exact Session projection captured by the route/shell owner. */
    session?: Session;
    item: SessionBoardItemProjection;
    host: SessionBoardMountHost;
    /** The locally derived executable placement for this item, or `null`. */
    primaryHost: SessionBoardMountHost | null;
    density: SessionWidgetDensity;
    /** Lane 04 `editSessionRecords`. Actions the person cannot perform are absent, not disabled. */
    canEdit: boolean;
    /**
     * Exact Board-record/access/reachability proof for executable sources.
     * Stale retained bytes remain visible, but never keep Host API authority.
     */
    executableCurrentness: SessionBoardExecutableCurrentness;
    /** Shared layout width intent, reported to assistive technology; the grid applies it. */
    width?: SessionBoardItemWidth;
    /**
     * The host's own measured height range. A transcript reply (`frame: 'reply'`) has none: the
     * item's declared height policy decides alone there.
     */
    heightBounds?: SessionBoardHeightBounds;
    /**
     * The mounted surface decides, from its own scroll geometry, that this card
     * is far enough outside the viewport that its body is not worth building
     * yet. Card chrome — title, menu, accessibility identity — always renders;
     * only the document, hosted surface or plugin frame waits.
     */
    deferBody?: boolean;
    /** Bounded renderer height report for an `auto` item, when the host measured one. */
    reportedHeight?: number | null;
    onIntrinsicHeightChange?: (height: number) => void;
    /**
     * The canonical expanded route for this item. Card geometry no longer bounds
     * the content, so a long or read-only note is fully readable and selectable
     * instead of being clipped or truncated.
     */
    expanded?: boolean;
    actionBinding?: SessionBoardHostActionBinding | null;
    resolveSourceAvailability?: SessionBoardSourceAvailabilityResolver;
    /** Exact Session-scoped plugin projection/currentness for executable items. */
    pluginRuntime?: SessionPluginRuntimeState;
    /** PEP-owned caller-HTML authority/bridge binding for this exact Session. */
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime;
    /** Hand this item to the placement that can run it. */
    onOpenHere?: () => void;
    /** Delete the shared record and every placement, through the shared Board Action. */
    onRemove?: () => void;
    onManagePlugin?: () => void;
    onPrepareEncryption?: () => void;
    /** Inline rename; commits on Enter/blur, Escape restores. Full density only. */
    onRename?: (title: string) => void | Promise<void>;
    /**
     * A configured widget's Edit inputs… and in-card repair (lab `dashboards` dbind E): this copy's
     * new bindings, through the Board's item owner. Editors only.
     */
    onSetInputs?: (bindings: WidgetInputBindingsV1) => Promise<WidgetSetupSubmitResult>;
    /** Edit content in place when the mounted Board controller publishes a real editor handler. */
    onEdit?: () => void;
    /** An HTML visual's network access (none, exact sites, any site), through the Board's item update. Editors only. */
    onSetNetwork?: (network: SessionVisualNetworkChoice) => Promise<WidgetSetupSubmitResult>;
    /** Persist one semantic Board width. Full density only. */
    onResize?: (width: SessionBoardItemWidth) => void;
    /** Persist one anchored move within the current Board view. */
    onMove?: (direction: 'before' | 'after') => void;
    /** There is a sibling to anchor against. At a view's end the direction is omitted. */
    canMoveBefore?: boolean;
    canMoveAfter?: boolean;
    /** Other shared Board views available to the same semantic move operation. */
    moveDestinations?: readonly Readonly<{ id: string; title: string }>[];
    onMoveToView?: (viewId: string) => void;
    /**
     * Persist one semantic height intent. Height belongs to the item, not the
     * placement, so the same content keeps a coherent vertical intent on every
     * Board view. Never a pixel value.
     */
    onSetHeight?: (height: SessionSurfaceItemV1['height']) => void;
    /** Add this existing shared item to the viewer's local Companion and reveal it. */
    onAddToCompanion?: () => void;
    /** Remove only the viewer-local Companion reference. */
    onRemoveFromCompanion?: () => void;
    /** Open the canonical expanded/full-content route for this item. */
    onReadFull?: () => void;
    /** Drop this view's placement. The shared item record survives. */
    /** Places this same item on the Board (a transcript reply offers it while the Board places it nowhere). */
    onPinToBoard?: () => void;
    onUnpin?: () => void;
    /** Exact one-shot focus handoff after this item replaces its editor. */
    focusHeadingRequestId?: number;
    onHeadingFocusHandled?: (requestId: number) => void;
    /** Host-specific truthful navigation label (for example, Open in Details). */
    openActionLabel?: string;
    /**
     * `section` places the item in the Companion column (lab F1) with the Companion's metrics; the
     * header stays quiet (widgets-polish): no mark says where the record lives.
     * `reply` places it in a transcript reply: borderless on the thread, on the reply's left edge,
     * its body exactly as tall as the item's declared policy says (never a nested scroll).
     */
    frame?: 'card' | 'section' | 'reply';
    /**
     * Card or plain, already resolved by the placement (the item's override, else the surface's
     * Appearance default). Absent: the placement's default (Board card, Companion plain).
     */
    frameStyle?: WidgetFrameStyle;
    /** The item just arrived while the viewer was looking: the frame's one-shot ring. */
    fresh?: boolean;
    /**
     * The Board's shared per-placement frame override and the Board's Appearance default, for the
     * ⋯ menu's Show/Hide frame. Present only where the viewer may edit the Board layout.
     */
    frameOverride?: SessionBoardItemMenuInput['frame'];
    /** A placement's own controls (reorder, its item menu), drawn at the end of the header line. */
    headerAccessory?: React.ReactNode;
    /**
     * A read-only monitor card (the compact sidebar) is itself the way onto the Board: the whole
     * card opens the item where it is edited.
     */
    onPressCard?: () => void;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    titleWrap: {
        flexShrink: 1,
        minWidth: 0,
    },
    // The frame's title and source steps (the same as every widget frame), drawn here because the
    // Board's title is also a rename field and a drag handle.
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.primary,
    },
    // The card's own region, laid over it without drawing or taking input: a real rectangle for Post a snapshot to open from
    // (the popover measurer rejects zero-size anchors).
    cardRegion: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    provenanceStack: { minWidth: 0, flexShrink: 1 },
    provenance: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
    body: {
        minHeight: 0,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
        paddingTop: theme.space.s10,
    },
}));

/**
 * A widget's source line. For an installed surface it names the real plugin and
 * contribution, so two plugin widgets on one Board stay distinguishable while
 * loading, updating and unavailable — see `widgetPresentation`.
 */
function itemProvenance(
    item: SessionBoardItemProjection,
    runtime: SessionPluginRuntimeState | undefined,
    viewerAccountId: string | undefined,
    posterDisplayName: string | null,
): ReturnType<typeof resolveBoardWidgetProvenance> | null {
    if (item.state.kind !== 'ready') return null;
    return resolveBoardWidgetProvenance(
        item.state.item.source,
        runtime?.pluginUiProjection ?? null,
        { snapshot: item.state.item.snapshot, viewerAccountId, posterDisplayName },
    );
}

function actionLabel(kind: SessionBoardItemActionKind): string {
    switch (kind) {
        case 'remove':
            return t('sessionBoard.item.actions.remove');
        case 'openHere':
            return t('sessionBoard.item.actions.openHere');
        case 'managePlugin':
            return t('sessionBoard.item.actions.managePlugin');
        case 'prepareEncryption':
            return t('sessionBoard.item.actions.prepareEncryption');
    }
}

export function SessionWidgetHost(props: SessionWidgetHostProps): React.ReactElement {
    const viewerScope = useActiveServerAccountScope();
    const viewerLifetime = useActiveServerAccountScopeLifetime();
    const appRuntime = useAppShellPluginUiProjection();
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const testID = props.testID ?? `session-board-item-${props.item.itemId}`;
    const [bodyCaption, setBodyCaption] = React.useState<string | null>(null);
    const [bodyMeta, setBodyMeta] = React.useState<React.ReactNode>(null);
    const [hostedFrameReportedHeight, setHostedFrameReportedHeight] = React.useState<number | null>(props.reportedHeight ?? null);
    const measuredHeightRef = React.useRef<number | null>(null);
    const onReportIntrinsicHeight = React.useCallback((height: number) => {
        if (!Number.isFinite(height) || height <= 0 || measuredHeightRef.current === height) return;
        measuredHeightRef.current = height;
        setHostedFrameReportedHeight(height);
        props.onIntrinsicHeightChange?.(height);
    }, [props.onIntrinsicHeightChange]);
    const onDeclarativeLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = Math.ceil(event.nativeEvent.layout.height);
        onReportIntrinsicHeight(height);
    }, [onReportIntrinsicHeight]);
    React.useLayoutEffect(() => {
        measuredHeightRef.current = null;
        setHostedFrameReportedHeight(props.reportedHeight ?? null);
    }, [props.item.itemId, props.item.revision]);
    const headingRef = React.useRef<Readonly<{ focus?: () => void }> | null>(null);
    const handledHeadingFocusRequestRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        const requestId = props.focusHeadingRequestId;
        if (requestId === undefined || handledHeadingFocusRequestRef.current === requestId) return;
        const target = headingRef.current;
        if (!target) return;
        handledHeadingFocusRequestRef.current = requestId;
        target.focus?.();
        focusNativeAccessibilityTarget(target as FocusReturnTarget);
        props.onHeadingFocusHandled?.(requestId);
    }, [props.focusHeadingRequestId, props.onHeadingFocusHandled]);
    const state = props.item.state;
    const mountMode = resolveSessionBoardMountMode({
        host: props.host,
        primaryHost: props.primaryHost,
        state,
    });
    const canOpenElsewhere = props.onOpenHere !== undefined;
    const embeddedPresentation = props.expanded === true ? 'fill' as const : 'content' as const;
    // This resolver proves renderer presence only. Both executable bodies and
    // inert widget references delegate exact-target admission to WidgetSurface.
    const presentation = resolveSessionBoardItemPresentation({
        state,
        // `density` is visual chrome; whether this placement runs the item is answered
        // once by `resolveSessionBoardMountMode`. A second rule here made the compact
        // sidebar inert even when it was the elected primary host.
        mountMode,
        canEdit: props.canEdit,
        canOpenElsewhere,
        // The one embedded presentation this host will mount, from the live `expanded` fact
        // it owns — so renderer admission and the mount agree on the same presentation.
        embeddedPresentation,
        ...(props.resolveSourceAvailability
            ? { resolveSourceAvailability: props.resolveSourceAvailability }
            : {}),
    });

    // A configured widget's inputs: Edit inputs… in the menu and the card's repair line open the
    // same step, for this copy only. The Board fills "This session" with its own Session.
    const widgetInstance = state.kind === 'ready' && state.item.source.kind === 'widget' ? state.item.source.instance : null;
    const installedDescriptor = React.useMemo(
        () => (widgetInstance ? readWidgetDescriptor(appRuntime.pluginUiProjection, widgetInstance.definition) : null),
        [appRuntime.pluginUiProjection, widgetInstance],
    );
    const boardSurface = useSessionWidgetSurface({ owner: 'sessionBoard', serverId: props.serverId, sessionId: props.sessionId, session: props.session ?? null });
    const widgetDescriptor = useWidgetInstanceDescriptor(boardSurface.scope, widgetInstance, installedDescriptor);
    // A widget card is named by the shared widget-name owner (its own name, else its definition's title) so an
    // installed surface never shows its local id; the stored title is the fallback for every other source.
    const title = widgetInstance ? resolveWidgetInstanceTitle(widgetInstance, widgetDescriptor, { fallbackTitle: resolveSessionBoardItemTitle(state) })
        : resolveSessionBoardItemTitle(state);
    // The title this card shows is the one name the Board uses for it: the carried ghost and every drop place that
    // describes it read it from here.
    const onDisplayTitle = React.useRef(props.onDisplayTitle);
    onDisplayTitle.current = props.onDisplayTitle;
    React.useEffect(() => {
        onDisplayTitle.current?.(title);
        return () => onDisplayTitle.current?.(null, title);
    }, [title]);
    const entityDrag = useSessionSurfaceEntityDrag(props.entityDrag ?? null);
    const [hostWidth, setHostWidth] = React.useState(0);
    const narrow = hostWidth > 0 && hostWidth < NARROW_CARD_WIDTH_PX;
    const onHostLayout = React.useCallback((event: LayoutChangeEvent) => {
        setHostWidth(Math.round(event.nativeEvent.layout.width));
        entityDrag.onLayout();
    }, [entityDrag]);
    const sameHome = !!viewerScope && (!props.serverId || areServerProfileIdentifiersEquivalent(viewerScope.serverId, props.serverId));
    const posterId = sameHome && state.kind === 'ready' ? state.item.snapshot?.postedByAccountId : undefined;
    const cachedPoster = useUser(posterId);
    // Shared viewers need not be friends with the author. Reuse the captured-Home people
    // reader used by Discussions, including its unavailable-profile and retirement handling.
    const posterProfiles = useDiscussionParticipantProfiles({
        scope: viewerScope ?? { serverId: '', accountId: '' },
        roster: null,
        accountIds: posterId ? [posterId] : [],
        enabled: !!posterId && cachedPoster === undefined && posterId !== viewerScope?.accountId,
        accountLifetime: viewerLifetime,
    });
    const poster = cachedPoster ?? posterProfiles.accounts.get(posterId ?? '')?.profile;
    const provenance = itemProvenance(props.item, props.pluginRuntime, sameHome ? viewerScope?.accountId : undefined,
        poster ? formatAccountDisplayName(poster) : null);
    // One header grammar at every density (F1): mark · title · source · meta · controls.
    const section = props.frame === 'section';
    const reply = props.frame === 'reply';
    // The monitor card opens on the Board from its heading (kind + title). Only the heading presses:
    // the card also holds its own menu and body controls, and a pressable card around them would
    // nest one button inside another.
    const onPressCard = props.onPressCard;
    const TitleFrame = (onPressCard ? Pressable : View) as React.ComponentType<React.ComponentProps<typeof Pressable>>;
    const titleFrameProps = onPressCard ? {
        testID: `${testID}-open`,
        onPress: onPressCard,
        accessibilityRole: 'button' as const,
        accessibilityLabel: provenance ? `${title}, ${provenance.label}` : title,
    } : {};
    const hostedHtmlTarget = React.useMemo(() => ({
        kind: 'session' as const,
        sessionId: props.sessionId,
    }), [props.sessionId]);

    const renameEnabled = props.density === 'full' && props.canEdit && props.onRename !== undefined;
    const onRename = props.onRename;
    const rename = useWidgetFrameRename({
        title,
        testID,
        // An empty or unchanged title keeps the one it had.
        ...(renameEnabled ? { onRename: (next: string) => { if (next.length > 0 && next !== title) return onRename?.(next); } } : {}),
    });
    const beginRename = rename.begin;

    const inputs = useWidgetInputsEditor({
        instance: widgetInstance,
        candidate: widgetDescriptor,
        scope: boardSurface.scope,
        context: boardSurface.context,
        audience: 'shared',
        ...(props.canEdit && props.onSetInputs ? { setInputs: props.onSetInputs } : {}),
        testID,
    });

    // About this widget, Save as your widget and Post a snapshot (lab dagent G2/G3, dscope VS): one shared owner. They open
    // on this card (`card`); only Edit inputs anchors at the ⋯.
    const readyItem = state.kind === 'ready' ? state.item : null;
    const cardRegionRef = React.useRef<View>(null);
    const card = React.useMemo(() => ({
        anchorRef: cardRegionRef,
        // Web scrolls the card to the top of the pane so a flow opens downward over its own card.
        reveal: () => {
            const node: unknown = cardRegionRef.current;
            if (Platform.OS === 'web' && typeof HTMLElement !== 'undefined' && node instanceof HTMLElement) node.scrollIntoView({ block: 'start' });
        },
    }), []);
    const [copyFlow, setCopyFlow] = React.useState<'save' | 'share' | null>(null);
    const [networkFlow, setNetworkFlow] = React.useState(false);
    const closeNetworkFlow = React.useCallback(() => setNetworkFlow(false), []);
    const onSetNetwork = props.onSetNetwork;
    const editNetwork = React.useMemo(() => props.canEdit && onSetNetwork && readyItem && readSessionVisualNetworkChoice(readyItem) !== null
        ? () => { card.reveal(); setNetworkFlow(true); } : undefined, [card, onSetNetwork, props.canEdit, readyItem]);
    const closeCopyFlow = React.useCallback(() => setCopyFlow(null), []);
    const copyAccount = boardSurface.scope && viewerScope?.serverId === boardSurface.scope.serverId ? viewerScope : null;
    const copyable = Boolean(readyItem && canPromoteSessionWidgetDefinitionSourceV1(readyItem.source) && copyAccount);
    const saveHtml = React.useMemo(() => copyable && readyItem?.source.kind === 'hostedHtml' ? () => { card.reveal(); setCopyFlow('save'); } : undefined, [card, copyable, readyItem?.source.kind]);
    const shareVisual = React.useMemo(() => copyable ? () => { card.reveal(); setCopyFlow('share'); } : undefined, [card, copyable]);
    // The source's own mark (a widget's glyph), the same on the card and in its flows.
    const itemMark = widgetDescriptor?.icon ?? sessionWidgetMark(state);
    const sessionItem = React.useMemo((): WidgetDefinitionSessionItem | null => {
        if (!readyItem || props.density === 'preview') return null;
        const fields = widgetDescriptor?.inputs?.fields ?? [];
        const bindings = readyItem.source.kind === 'widget' ? readyItem.source.instance.bindings : {};
        const promoted = projectWidgetDefinitionPromotionBindingsV1(widgetDescriptor ?? {}, bindings);
        return {
            itemId: props.item.itemId,
            title,
            savable: canPromoteSessionWidgetDefinitionSourceV1(readyItem.source),
            canEdit: props.canEdit,
            converted: Object.entries(promoted).flatMap(([path, binding]) => (binding.kind === 'value' ? [] : [{
                path, title: fields.find((field) => field.path === path)?.title ?? path, becomes: binding.kind,
            }])),
            sourceLabel: widgetDescriptor?.pluginName ?? title,
            mark: itemMark,
            renderPreview: () => readyItem.source.kind === 'declarative'
                ? <SessionBoardDeclarativeContent testID={`${testID}.save.document`} document={readyItem.source.document}
                    snapshot={readyItem.snapshot !== undefined} actionBinding={null} />
                : readyItem.source.kind === 'widget' && boardSurface.scope && props.item.revision
                    ? <WidgetSurface scope={boardSurface.scope} providedContext={readSessionWidgetProvidedContext({ serverId: boardSurface.scope.serverId, sessionId: props.sessionId, session: props.session })}
                        instance={readyItem.source.instance} descriptor={widgetDescriptor} appRuntime={appRuntime} presentation="content"
                        recordRevision={props.item.revision} testID={`${testID}.save.widget`} /> : null,
        };
    }, [props.canEdit, props.density, props.item.itemId, props.item.revision, props.sessionId, readyItem, title, widgetDescriptor, appRuntime, boardSurface.scope, testID, itemMark]);
    const definitionFlows = useWidgetDefinitionFlows({
        instance: widgetInstance,
        scope: boardSurface.scope,
        anchorRef: inputs.anchorRef,
        card,
        editInputs: inputs.editInputs,
        sessionItem,
        providedContext: boardSurface.scope ? readSessionWidgetProvidedContext({ serverId: boardSurface.scope.serverId, sessionId: props.sessionId, session: props.session }) : {},
        testID,
    });

    const nativeWidth = props.width ?? 'medium';
    const nativeHeightSize = state.kind === 'ready' && !section && !reply
        ? state.item.height.mode === 'auto' ? state.item.height.fallback : state.item.height.size : undefined;
    const widgetPresentation = React.useMemo(() => nativeHeightSize ? {
        size: resolveSessionBoardWidgetSizeV1(nativeWidth, { mode: 'fixed', size: nativeHeightSize }),
        footprint: getSessionBoardWidgetFootprintV1(nativeWidth, { mode: 'fixed', size: nativeHeightSize }),
    } : undefined, [nativeWidth, nativeHeightSize]);

    // The menu is the card's published operation set, built the same way the
    // Companion builds its own: one entry per handler that genuinely exists.
    const [sizeBusy, setSizeBusy] = React.useState(false);
    const sizeChoices = resolveWidgetSizeChoicesV1('sessionBoard', widgetDescriptor?.sizeDeclaration);
    const sizeControl: WidgetSizeControl | undefined = props.density === 'full' && props.canEdit && widgetInstance && widgetDescriptor && props.onResize && boardSurface.scope && sizeChoices.defaultSize ? {
        surface: 'sessionBoard', sizes: sizeChoices.sizes,
        size: widgetPresentation?.size,
        disabled: sizeBusy,
        onSet: (size: WidgetSizeV1) => {
            if (sizeBusy || !boardSurface.scope || !widgetInstance) return;
            setSizeBusy(true);
            void runWidgetDefinitionCommand('widgets.item.size.set', {
                ref: { surface: boardSurface.scope, instanceId: widgetInstance.id }, size,
            }, boardSurface.scope).then(outcome => {
                if (outcome.kind === 'refused') publishPresentationNotice({
                    key: `${props.sessionId}:${widgetInstance.id}:size`, severity: 'error', message: t('widgetAdd.saveFailed'),
                });
                if (outcome.kind === 'approvalPending') publishPresentationNotice({
                    key: `${props.sessionId}:${widgetInstance.id}:size`, severity: 'info', message: t('widgetAdd.areaApprovalPending'),
                });
            }).finally(() => setSizeBusy(false));
        },
    } : undefined;
    const itemActions = React.useMemo(() => buildSessionBoardItemActions({
        density: props.density,
        canEdit: props.canEdit,
        item: state.kind === 'ready' ? state.item : null,
        width: props.width,
        onReadFull: props.onReadFull,
        onEdit: props.onEdit,
        // Pressing the title opens the same editor for a pointer; this is how a
        // keyboard and a screen reader reach rename at all.
        onRename: renameEnabled ? beginRename : undefined,
        editInputs: inputs.editInputs,
        definition: { onAbout: definitionFlows.about, onAddTo: definitionFlows.addTo, onSaveAsYours: definitionFlows.saveAsYours, onPostSnapshot: definitionFlows.postSnapshot },
        onEditNetwork: editNetwork,
        visualCopy: { onSaveArtifact: saveHtml, onShare: shareVisual },
        onMove: props.onMove,
        canMoveBefore: props.canMoveBefore,
        canMoveAfter: props.canMoveAfter,
        moveDestinations: props.moveDestinations,
        onMoveToView: props.onMoveToView,
        onResize: props.onResize,
        sizeControl,
        reportedHeight: props.reportedHeight ?? hostedFrameReportedHeight,
        onSetHeight: props.onSetHeight,
        onAddToCompanion: props.onAddToCompanion,
        onRemoveFromCompanion: props.onRemoveFromCompanion,
        onPinToBoard: props.onPinToBoard,
        onUnpin: props.onUnpin,
        // Removal belongs with the other card operations, marked destructive and
        // last, rather than as the one control drawn louder than every
        // constructive one beneath every card.
        onRemove: props.onRemove,
        frame: props.frameOverride,
    }), [
        beginRename,
        inputs.editInputs,
        definitionFlows.about,
        definitionFlows.addTo,
        definitionFlows.saveAsYours,
        definitionFlows.postSnapshot,
        saveHtml,
        shareVisual,
        editNetwork,
        props.canEdit,
        props.canMoveAfter,
        props.canMoveBefore,
        props.density,
        props.moveDestinations,
        props.onEdit,
        props.onMove,
        props.onMoveToView,
        props.onReadFull,
        props.onRemove,
        props.onResize,
        sizeControl,
        props.reportedHeight,
        hostedFrameReportedHeight,
        props.onSetHeight,
        props.onAddToCompanion,
        props.onRemoveFromCompanion,
        props.onPinToBoard,
        props.onUnpin,
        props.frameOverride,
        props.width,
        renameEnabled,
        state,
    ]);

    const runAction = React.useCallback((kind: SessionBoardItemActionKind | 'openHere' | null) => {
        switch (kind) {
            case 'remove':
                props.onRemove?.();
                return;
            case 'openHere':
                props.onOpenHere?.();
                return;
            case 'managePlugin':
                props.onManagePlugin?.();
                return;
            case 'prepareEncryption':
                props.onPrepareEncryption?.();
                return;
            case null:
                return;
        }
    }, [props]);

    const stateActions = presentation.kind === 'state'
        ? presentation.card.actionKinds.flatMap((kind) => {
            // Keep destructive removal in the existing menu when that menu is available.
            // Locked/missing records and inert previews retain their state-owned recovery.
            if (kind === 'remove' && itemActions.some((action) => action.id === 'remove')) return [];
            const available = kind === 'remove' ? props.onRemove !== undefined
                : kind === 'managePlugin' ? props.onManagePlugin !== undefined
                    : kind === 'prepareEncryption' ? props.onPrepareEncryption !== undefined
                        : kind === 'openHere' ? props.onOpenHere !== undefined
                            : false;
            return available ? [{
                label: actionLabel(kind),
                onPress: () => runAction(kind),
            }] : [];
        })
        : [];

    // A reply that runs elsewhere keeps no slot for the body it does not draw: the declared height
    // belongs to the live copy, and holding it here left a large empty box around one line.
    const resolvedHeight = state.kind === 'ready' && props.expanded !== true
        && !(reply && presentation.kind === 'preview')
        ? props.heightBounds === undefined
            ? resolveSessionBoardReplyHeight({
                height: state.item.height,
                reportedHeight: props.reportedHeight ?? hostedFrameReportedHeight,
                // Only a caller frame reports its own height; native content lays itself out.
                measuresIntrinsicHeight: state.item.source.kind === 'hostedHtml',
            })
            : resolveSessionBoardItemHeight({
                height: state.item.height,
                reportedHeight: props.reportedHeight ?? hostedFrameReportedHeight,
                bounds: props.heightBounds,
            })
        : null;

    const executablePaused = presentation.kind === 'content'
        && state.kind === 'ready'
        && sessionBoardSourceRequiresExclusiveMount(state.item.source.kind)
        && props.executableCurrentness !== 'current';
    const executablePausedReason = props.executableCurrentness === 'offline'
        ? t('sessionBoard.board.offline')
        : props.executableCurrentness === 'stale'
            ? t('sessionBoard.board.stale')
            : t('sessionBoard.board.unavailable.reason');

    const previewAction = presentation.kind === 'preview' ? presentation.actionKind : null;
    const configuredReference = presentation.kind === 'preview' && widgetInstance !== null;
    // This copy is not the one that runs. Saying so keeps the frame truthful; an empty body read as a
    // visual that failed to render. Where the person can bring it here, the same line offers that.
    const runningElsewhere = (
        <SurfaceStateCard
            testID={`${testID}-elsewhere`}
            size="line"
            kind="empty"
            title={t('sessionBoard.item.runningElsewhere.title')}
            detail={t('sessionBoard.item.runningElsewhere.reason')}
            accessibilitySemantics="status"
            {...(previewAction === 'openHere'
                ? {
                    action: {
                        label: props.openActionLabel ?? actionLabel('openHere'),
                        onPress: () => runAction('openHere'),
                        testID: `${testID}-open-here`,
                    },
                }
                : {})}
        />
    );

    const body = executablePaused
        ? (
            <SurfaceStateCard
                testID={`${testID}-executable-${props.executableCurrentness}`}
                size={props.expanded ? undefined : 'line'}
                kind={props.executableCurrentness === 'unverified' ? 'unavailable' : 'warning'}
                title={t('sessionBoard.board.unavailable.title')}
                reason={props.expanded ? executablePausedReason : undefined}
                detail={props.expanded ? undefined : executablePausedReason}
                diagnosticCode={`session_board_executable_${props.executableCurrentness}`}
                accessibilitySemantics="status"
            />
        )
        : presentation.kind === 'state'
        ? (
            <SurfaceStateCard
                testID={`${testID}-state`}
                size={props.expanded ? undefined : 'line'}
                kind={presentation.card.kind}
                title={presentation.card.title}
                reason={props.expanded ? presentation.card.reason : undefined}
                detail={props.expanded ? undefined : presentation.card.reason}
                diagnosticCode={presentation.card.diagnosticCode}
                accessibilitySemantics="status"
                {...(stateActions[0] ? { action: stateActions[0] } : {})}
                {...(stateActions[1] ? { secondaryAction: stateActions[1] } : {})}
            />
        )
        : props.deferBody === true
        ? (
            <View
                testID={`${testID}-deferred`}
                style={{ minHeight: resolvedHeight?.height ?? props.heightBounds?.min ?? 0 }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            />
        )
        : state.kind === 'ready' && state.item.source.kind === 'walkthrough'
            ? <SessionWalkthroughWidgetContent sessionId={props.sessionId} serverId={props.serverId ?? null}
                comparisonKind={state.item.source.comparison} interactive={presentation.kind === 'content'} testID={`${testID}-walkthrough`} />
        : state.kind === 'ready' && state.item.source.kind === 'declarative'
            ? (
                // Native content reports what it draws, as a frame or an installed widget does, so an
                // `auto` card fits it instead of standing at its fallback size.
                <View onLayout={state.item.height.mode === 'auto' ? onDeclarativeLayout : undefined}>
                    <SessionBoardDeclarativeContent
                        testID={`${testID}-declarative`}
                        document={state.item.source.document}
                        snapshot={state.item.snapshot !== undefined}
                        // A preview is inert: it renders the same native content with no
                        // dispatch path, so a background placement cannot cause effects.
                        actionBinding={presentation.kind === 'content' ? props.actionBinding ?? null : null}
                    />
                </View>
            )
            : (presentation.kind === 'content' || configuredReference)
                && state.kind === 'ready'
                && state.item.source.kind === 'widget'
                && props.item.revision !== null
                ? (
                    // The same admission owner checks the exact bound target for
                    // both modes. A reference replaces the body before execution.
                    viewerScope && viewerScope.serverId === props.serverId ? <WidgetSnapshotCaptureContext.Provider value={definitionFlows.snapshotSlot}><WidgetSurface
                        testID={testID}
                        scope={{ ...viewerScope, owner: { kind: 'sessionBoard', sessionId: props.sessionId } }}
                        providedContext={readSessionWidgetProvidedContext({ serverId: viewerScope.serverId, sessionId: props.sessionId, session: props.session })}
                        instance={state.item.source.instance}
                        descriptor={widgetDescriptor}
                        // Presentation-only native height revisions do not change this configured executable.
                        recordRevision={stableJsonStringify(state.item.source.instance)}
                        // The embedded plugin presentation describes the actual
                        // host composition, not persisted outer card chrome.
                        presentation={embeddedPresentation}
                        appRuntime={appRuntime}
                        {...(configuredReference ? { reference: runningElsewhere } : {})}
                        onIntrinsicHeightChange={onReportIntrinsicHeight}
                        {...(props.onManagePlugin ? { onManagePlugin: props.onManagePlugin } : {})}
                        {...(inputs.onRepairInputs ? { onRepairInputs: inputs.onRepairInputs } : {})}
                    /></WidgetSnapshotCaptureContext.Provider> : <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_viewer_scope_mismatch' }} testID={testID} />
                )
                : presentation.kind === 'content'
                    && state.kind === 'ready' && state.item.source.kind === 'hostedHtml'
                    && props.item.revision !== null
                    && props.callerHostedHtmlRuntime
                    ? (
                        <HostedHtmlSurfaceAdapter
                            sessionId={props.sessionId}
                            title={state.item.title}
                            recordRevision={props.item.revision}
                            approvalSubject={stableJsonStringify([
                                'session-record',
                                props.callerHostedHtmlRuntime.serverIdentityId,
                                props.sessionId,
                                'surface/item.v1',
                                props.item.itemId,
                            ])}
                            source={state.item.source.source}
                            requestedCapabilities={state.item.source.requestedCapabilities}
                            {...(state.item.input === undefined ? {} : { input: state.item.input })}
                            target={hostedHtmlTarget}
                            runtime={props.callerHostedHtmlRuntime}
                            onIntrinsicHeightChange={onReportIntrinsicHeight}
                            testID={`${testID}-hosted-html`}
                        />
                    )
                : presentation.kind === 'preview'
                        ? runningElsewhere
                    : (
                        // Executable sources reach this branch only when their renderer is
                        // available; the presentation resolver has already refused otherwise.
                        <SurfaceStateCard
                            testID={`${testID}-state`}
                            size={props.expanded ? undefined : 'line'}
                            kind="unavailable"
                            title={t('sessionBoard.item.rendererUnavailable.title')}
                            reason={props.expanded ? t('sessionBoard.item.rendererUnavailable.reason') : undefined}
                            detail={props.expanded ? undefined : t('sessionBoard.item.rendererUnavailable.reason')}
                            diagnosticCode="session_board_renderer_missing"
                            accessibilitySemantics="status"
                        />
                    );

    // Only full-bleed items reach the frame's real edge; the card clips them to its corner.
    // Frameless drops the item's own chrome, never the host's inset, so its text never meets an edge.
    const bodyReachesEdge = state.kind === 'ready' && state.item.frame === 'full_bleed';
    const placement = section ? 'companion' as const : 'board' as const;
    const frameStyle = props.frameStyle ?? (section || reply ? 'plain' : 'card');

    const moveHandle = props.entityDrag ? (
        <SessionSurfaceEntityDragHandle drag={entityDrag} title={title} testID={`${testID}-move-handle`} />
    ) : null;

    // A record not read yet has no name to show. "Untitled widget" would be a claim about it;
    // the body's loading state already says what is happening.
    const recordLoading = state.kind === 'loading';
    const heading = (
            <TitleFrame style={styles.titleWrap} {...titleFrameProps}>
                {rename.field ?? (
                    <Text
                        ref={headingRef}
                        testID={`${testID}-title`}
                        style={styles.title}
                        tabIndex={-1}
                        // A narrow card wraps its title to a second line before it clips.
                        numberOfLines={narrow ? 2 : 1}
                        accessibilityRole="header"
                        accessibilityLabel={recordLoading
                            ? t('sessionBoard.item.loading.title')
                            : props.width
                            ? t('sessionBoard.item.a11yLabelWithWidth', {
                                title,
                                width: t(`sessionBoard.width.${props.width}`),
                            })
                            : title}
                        {...(beginRename ? { onPress: beginRename } : {})}
                    >
                        {recordLoading ? '' : title}
                    </Text>
                )}
            </TitleFrame>
    );

    // A posted snapshot says when its numbers are from beside its source ("Snapshot by you · As of 11:08 AM"); it never
    // updates. In a narrow card the time takes its own line under the source, so the clipping source gives way and
    // the time is always read in full.
    const snapshotAsOf = state.kind === 'ready' && state.item.snapshot ? Date.parse(state.item.snapshot.asOf) : null;
    const asOfLabel = snapshotAsOf !== null && Number.isFinite(snapshotAsOf)
        ? t('widgetDefinition.asOf', { time: formatHappierAsOfTime(snapshotAsOf) }) : null;
    // Shown at every density, including an inert preview: the source IS most of what a preview
    // says, and it is the only thing that tells two plugin widgets apart. The visible name may
    // clip (or leave first when the frame narrows); the announced one keeps the exact identity.
    const source = provenance ? (
        <View
            testID={`${testID}-provenance`}
            style={styles.provenanceStack}
            accessible
            accessibilityLabel={[provenance.accessibilityLabel, bodyCaption, asOfLabel].filter(Boolean).join(' · ')}
        >
            {asOfLabel && narrow ? (
                <>
                    <Text style={styles.provenance} numberOfLines={1}>{bodyCaption ?? provenance.label}</Text>
                    <Text style={styles.provenance} numberOfLines={1}>{asOfLabel}</Text>
                </>
            ) : (
                <Text style={styles.provenance} numberOfLines={1}>
                    {asOfLabel ? `${bodyCaption ?? provenance.label} · ${asOfLabel}` : bodyCaption ?? provenance.label}
                </Text>
            )}
        </View>
    ) : undefined;

    // A Companion section identifies its shared Board record. Board cards keep their header
    // clear; Companion membership still controls drag admission and the menu's inverse action.
    const meta = section ? (
        <View
            testID={`${testID}-on-board-mark`}
            accessibilityRole="image"
            accessibilityLabel={provenance
                ? t('sessionCompanion.picker.onTheBoard', { source: provenance.label })
                : t('sessionBoard.companion.actions.openOnBoard')}
        >
            <Icon name="squares-four" size={13} color={theme.colors.text.tertiary} />
        </View>
    ) : null;

    const controls = itemActions.length > 0 || props.headerAccessory ? (
        // Edit inputs anchors here, at the ⋯.
        <View style={styles.controls} ref={inputs.anchorRef} collapsable={false}>
            {itemActions.length > 0 ? (
                <ItemRowActions
                    title={title}
                    actions={itemActions}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    overflowTriggerTestID={`${testID}-actions`}
                    overflowTriggerAccessibilityLabel={t('common.moreActions')}
                    onOverflowTriggerKeyDown={key => stepWidgetSizeControl(sizeControl, key)}
                    renderOverflowSection={({ id }) => renderWidgetSizeMenuSection(sizeControl, id, `${testID}.size`)}
                    overflowMaxHeightCap={WIDGET_MENU_MAX_HEIGHT_PX}
                    iconSize={18}
                    gap={8}
                />
            ) : null}
            {props.headerAccessory}
        </View>
    ) : null;

    return (
        <View ref={entityDrag.ref} onLayout={onHostLayout} collapsable={false}>
            {/* The card's own region: every flow the card opens (Save as your widget, About, Post a snapshot) opens on its own card from here. */}
            <View ref={cardRegionRef} testID={`${testID}-card-region`} pointerEvents="none" style={styles.cardRegion} />
            <SessionSurfaceEntityTargetFeedback drag={entityDrag} testID={testID} />
            {inputs.popover}
            {definitionFlows.panel}
            {networkFlow && readyItem ? <WidgetFlowShell anchorRef={card.anchorRef}
                title={t('sessionBoard.item.network.title')}
                onRequestClose={closeNetworkFlow} testID={`${testID}.networkShell`}>
                <SessionVisualNetworkPanel item={readyItem} testID={`${testID}.network`} onClose={closeNetworkFlow}
                    onSave={(choice) => onSetNetwork?.(choice) ?? Promise.resolve({ ok: false, message: t('sessionBoard.item.network.failed') })} />
            </WidgetFlowShell> : null}
            {copyFlow && readyItem && copyAccount ? <WidgetFlowShell anchorRef={card.anchorRef}
                title={t('widgetDefinition.visualSaveTitle')}
                onRequestClose={closeCopyFlow} testID={`${testID}.copyShell`}>
                <SessionVisualCopyPanel account={copyAccount} item={readyItem} itemId={props.item.itemId}
                    sessionId={props.sessionId} share={copyFlow === 'share'}
                    onClose={closeCopyFlow} testID={`${testID}.copy`} />
            </WidgetFlowShell> : null}
            {/*
              * No `accessible` wrapper here. Collapsing the card into one element
              * would hide Remove, the action menu, the renderer's own controls and
              * the content itself from assistive technology; the heading
              * supplies the grouping relationship instead.
              */}
            <WidgetFrame
                testID={testID}
                frameStyle={frameStyle}
                placement={placement}
                mark={itemMark}
                title={heading}
                {...(source ? { source } : {})}
                // A narrow card (the Board in a pane) reads its source whole, on its own line beneath the title; "Snapshot
                // by you · as of 10:42" and a plugin's name are never squeezed out beside a long title.
                {...(source && narrow ? { sourcePlacement: 'below' as const } : {})}
                meta={bodyMeta ? <>{meta}{bodyMeta}</> : meta}
                menu={controls}
                {...(moveHandle ? { grip: moveHandle } : {})}
                fresh={props.fresh === true}
                widgetPresentation={widgetPresentation}
                {...(reply ? { bodyHeight: 'content' as const } : {})}
                viewportHeight={resolvedHeight?.height}
                bodyStyle={bodyReachesEdge ? FULL_BLEED_BODY : undefined}
                body={{
                    kind: 'content',
                    children: (
                        <WidgetFrameBodyCaptionContext.Provider value={setBodyCaption}>
                        <WidgetFrameBodyMetaContext.Provider value={setBodyMeta}>
                            <View
                                testID={`${testID}-body`}
                                style={[styles.body, resolvedHeight ? { height: resolvedHeight.height } : null]}
                            >
                                {configuredReference ? (
                                    <SurfaceStateSizeProvider size={props.expanded ? 'pane' : 'line'}>{body}</SurfaceStateSizeProvider>
                                ) : body}
                            </View>
                        </WidgetFrameBodyMetaContext.Provider>
                        </WidgetFrameBodyCaptionContext.Provider>
                    ),
                }}
            />
            {/*
              * Removal is NOT drawn here. It is the card's one destructive
              * operation and it lives last in the action menu with every
              * other card operation; as a standing button it was the only
              * always-visible control on a card whose constructive actions
              * all sat behind an overflow, which reads as an invitation to
              * delete.
              */}
        </View>
    );
}

/** The widget's mark in the frame header: what kind of thing it is, by its source. */
function sessionWidgetMark(state: SessionBoardItemProjection['state']): IconName {
    if (state.kind !== 'ready') return 'squares-four';
    switch (state.item.source.kind) {
        case 'walkthrough': return 'path';
        case 'declarative': return (state.item.source.document as { root?: { kind?: unknown } }).root?.kind === 'chart' ? 'chart-bar' : 'note';
        case 'hostedHtml': return 'squares-four';
        case 'widget': return 'puzzle-piece';
    }
}

/** Below this card width the header's source goes on its own line (a title and a source no longer fit side by side). */
const NARROW_CARD_WIDTH_PX = 520;

const FULL_BLEED_BODY = Object.freeze({ paddingLeft: 0, paddingRight: 0, paddingBottom: 0 });

// The `density` prop already expresses full / compact / inert-preview, so the
// three named wrappers were dead indirection over one shell and are gone. Hosts
// pass their density directly.
