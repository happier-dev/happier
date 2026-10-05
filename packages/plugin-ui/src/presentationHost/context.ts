import { createContext, createElement, useContext, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiTargetedContributionSurfaceV1 } from '@happier-dev/plugin-sdk/ui';
import type { NavigationListDestination } from '../components/NavigationList.js';
import type { ItemProps } from '../components/List.js';
import type { HappierUiPalette, HappierUiTypography } from '../environment/types.js';
import type { HappierFocusable, HappierStyleProp } from '../presentation/portableTypes.js';
import type { HappierMaterialRole } from '../presentation/layout/material.js';
import type { HappierDiffViewerRequest } from '../presentation/content/DiffViewer.js';
import type { HappierPageChrome } from '../presentation/layout/pageChrome.js';
import type { HappierCollectionMotionDriver } from '../presentation/collection/collectionMotion.js';
import type { HappierDisclosureMotionDriver } from '../presentation/collection/Disclosure.js';
import type { HappierStateSize } from '../presentation/state/InfoState.js';
import type { HappierCapsuleHost } from '../presentation/status/capsuleHost.js';
import type { HappierAgentCursorMotionDriver } from '../presentation/copresence/AgentCursor.js';
import type { HappierLiveStreamProps } from '../presentation/media/LiveStream.js';
import type { HappierStoredImageHost } from '../presentation/content/StoredImage.js';
import type { DragSourceProps, DropTargetProps } from '../components/EntityDragDrop.js';
import type { PluginUiWidgetAreaPortV1 } from '../hostApi/widgetArea.public.js';
import type { SetupBlockGridProps, SetupBlockTileProps } from '../components/Setup.js';
import type { DictationButtonProps, StatusCellProps, VoiceMarkArtProps } from '../components/Voice.js';

export type PluginUiPopoverPresentation = 'popover' | 'menu' | 'dropdown' | 'context';

/**
 * Minimal Popover facts exposed to plugin-owned content. Pointer dismissal and
 * the viewport calculation remain inside the incumbent app Popover.
 */
export type PluginUiPopoverContentControls = Readonly<{
  requestClose(reason: 'selection' | 'escape'): void;
  /** Current viewport height computed by the incumbent host Popover. */
  maxHeight: number;
}>;

/**
 * One bounded request to render a QR code for a plugin-supplied payload such
 * as a pairing deep link. Encoding, quiet zone, error correction, and the
 * platform renderer stay with the incumbent host implementation; the payload
 * is rendered verbatim and is never interpreted, stored, or transformed.
 */
export type PluginUiQRCodePresentation = Readonly<{
  data: string;
  size: number;
  testID?: string;
}>;

/** One host-owned brand target; no package inventory or Resource reference escapes this seam. */
export type PluginUiTargetBrandMarkInput = Readonly<{
  pluginId: string;
  size?: 'small' | 'medium' | 'large';
  showName?: boolean;
  /** An adjacent host-owned label already supplies the one canonical name. */
  externallyLabelled?: boolean;
  testID?: string;
}>;

/**
 * One semantic request to render an already-admitted target-local contributor
 * surface. The bridge intentionally receives the public handle unchanged: host
 * rematching, input validation, identity namespacing, and every physical mount
 * lifetime remain with the incumbent PluginSurfaceHost.
 */
export type PluginUiTargetedSurfacePresentation = Readonly<{
  surface: PluginUiTargetedContributionSurfaceV1;
  input: JsonValue;
  instanceKey?: string;
  fallback?: ReactNode;
}>;

/**
 * One part of a host-owned Account Session (plan 05 §4.2). `provider` mounts the one Session
 * controller, resolved inside the mounted surface's own account scope; `transcript` and `composer`
 * render slots of the nearest host controller; `chat` is provider plus parts in the host's standard
 * layout. Authors receive no renderer, state, or callback: only the Session id and the read-only
 * choice cross this seam.
 */
export type PluginUiSessionPartPresentation =
  | Readonly<{ part: 'provider'; sessionId: string; readOnly: boolean; presented?: boolean; children: ReactNode }>
  | Readonly<{ part: 'transcript'; testID?: string }>
  | Readonly<{ part: 'composer'; testID?: string }>
  | Readonly<{ part: 'chat'; sessionId: string; readOnly: boolean; presented?: boolean; testID?: string }>;

/**
 * One request to present a page's declared widget area (`WidgetSurface area="pinned"`). The
 * operation port is the mounted Host API's `widgetArea`, already bound by the host to this page's
 * plugin, Account and declared area; the context is the page's readable input, admitted against the
 * area's declared schema on every operation. The host owns everything drawn inside: catalog,
 * gallery, Set up, frames, layout and access.
 */
export type PluginUiWidgetAreaPresentation = Readonly<{
  area: string;
  context: Readonly<Record<string, JsonValue>>;
  port: PluginUiWidgetAreaPortV1;
  title?: string;
  description?: string;
  testID?: string;
}>;

/**
 * What a plugin's `DetailsPane` asks the host to show in the page's app details pane: the pane's header
 * band (title, subtitle, actions, close) and the detail itself. The host owns the pane's geometry,
 * persisted width, docked/overlay decision, Escape and focus return.
 */
export type PluginUiDetailsPanePresentation = Readonly<{
  open: boolean;
  /** The header band's title; omitted, the detail draws its own heading and close control. */
  title?: string;
  /** Private semantic binding to the incumbent pane header, never an author DOM/native-ref API. */
  headingRef?: (target: HappierFocusable | null) => void;
  subtitle?: string;
  actions?: ReactNode;
  onClose(): void;
  children?: ReactNode;
  testID?: string;
}>;

/**
 * The page's app details pane, when the host placed this surface in a pane host (app and plugin pages).
 * Package-private: authors use the public `DetailsPane` (and `Collection`, which opens its items there).
 */
export type PluginUiDetailsPaneHost = Readonly<{
  /**
   * Whether the pane sits beside the page right now. False on phones and with side panes turned off:
   * the detail is then pushed inside the page. A hook: call it unconditionally from a component.
   */
  useAvailable(): boolean;
  /** Publishes the pane from where the detail is declared; renders nothing in place. */
  renderDetailsPane(input: PluginUiDetailsPanePresentation): ReactNode;
}>;

/**
 * What a plugin tab asks the host to show in the pane header it already draws for that tab (the
 * session sidebar band, a phone surface's large title): the one live line under the title and the
 * trailing actions, before ⋯. The host owns the header's layout, its title and what fits.
 */
export type PluginUiPaneHeaderPresentation = Readonly<{
  /** The live line's facts, joined by " · " ("1 needs you"); `null` for none. */
  line: readonly PluginUiPaneHeaderLineSegment[] | null;
  /** The trailing actions (a "+" and its menu), rendered in the header with this plugin's context. */
  actions: ReactNode | null;
}>;

/** Bounded presentation facts: attention styles the fact, never grants authority. */
export type PluginUiPaneHeaderLineSegment = string | Readonly<{ text: string; attention: true }>;

/**
 * The pane header of the tab the host mounted this surface in; absent where the surface has no
 * header of its own (a page, a widget). Package-private: authors use the public `PaneHeaderContent`.
 */
export type PluginUiPaneHeaderHost = Readonly<{
  /** Publishes the header content from where it is declared; renders nothing in place. */
  renderPaneHeader(input: PluginUiPaneHeaderPresentation): ReactNode;
}>;

/**
 * Host-owned product renderers that a bundled plugin surface may delegate to.
 *
 * This is deliberately package-internal. Authors get semantic components such
 * as `Markdown` and `CodeBlock`; they never receive Happier's renderer objects,
 * navigation roots, or modal/portal infrastructure.
 */
export type PluginUiPresentationHost = Readonly<{
  renderVoiceMarkArt?(input: Omit<VoiceMarkArtProps, 'fallback'>): ReactNode;
  renderStatusCell?(input: Omit<StatusCellProps, 'label' | 'fallback'> & Readonly<{ presented: boolean }>): ReactNode;
  renderSetupBlockTile?(input: Omit<SetupBlockTileProps, 'fallback'>): ReactNode;
  renderSetupBlockGrid?(input: Omit<SetupBlockGridProps, 'fallback'>): ReactNode;
  renderDictationButton?(input: Omit<DictationButtonProps, 'fallback'> & Readonly<{ presented: boolean }>): ReactNode;
  /** Thin presentation requests; the existing mounted host owns identity, gestures and Actions. */
  renderDragSource?(input: DragSourceProps): ReactNode;
  renderDropTarget?(input: DropTargetProps): ReactNode;
  /** The incumbent host material owner; no settings or platform policy enters the author API. */
  renderMaterialSurface?(input: Readonly<{
    role: HappierMaterialRole;
    /** A same-role parent already owns this plane's material coat. */
    nested?: boolean;
    children?: ReactNode;
    style?: HappierStyleProp;
    testID?: string;
  }>): ReactNode;
  /** Incumbent platform image decoder; Session-media acquisition remains in the mounted host API. */
  storedImageHost?: HappierStoredImageHost;
  /** Qualified row destinations use the incumbent workspace owner; absent hosts keep ordinary activation. */
  renderDestinationRow?(input: NavigationListDestination & Readonly<{
    children: ReactNode;
    /** Collection rows retain their List.Item menu owner and merge the host's destination actions there. */
    renderWithSecondaryActions?(actions: Readonly<{
      secondaryActions: NonNullable<ItemProps['secondaryActions']>;
      onSecondaryAction: NonNullable<ItemProps['onSecondaryAction']>;
    }>): ReactNode;
  }>): ReactNode;
  /**
   * The host's motion drivers for the Collection's table ⇄ split transition and its peek disclosure
   * (COLLECTION.md §8). Durations and easings are the host's motion tokens; the animation library stays
   * host-private. Absent (a hosted-web realm), the Collection's changes land at once.
   */
  collectionMotion?: HappierCollectionMotionDriver;
  /**
   * The container the surface is mounted in, as Happier's own states size themselves (`pane` in a
   * session sidebar tab, `phone` on a phone surface, `details` in a details drawer). A plugin state
   * that passes no `size` takes this one, so a plugin tab's empty and loading states match the host's
   * without every author passing it.
   */
  stateSize?: HappierStateSize;
  /** The page's app details pane; absent where the surface is not placed in a pane host. */
  detailsPane?: PluginUiDetailsPaneHost;
  /** The pane header of the tab this surface fills; absent where it has none. */
  paneHeader?: PluginUiPaneHeaderHost;
  /**
   * The page's own scroller, for a page-sized Collection (`scroll="page"`) on a same-realm host page: the host's
   * page scroller with its page anatomy. Absent, the Collection scrolls in a plain scroll view.
   */
  renderPageScroller?(children: ReactNode): ReactNode;
  disclosureMotion?: HappierDisclosureMotionDriver;
  /**
   * The host's leaves for the floating capsules a plugin draws (`StatusCapsule`, `PresenceCapsule`): its
   * floating material, row type roles, small button, spinner, icon pack, step morph and dock motion, so
   * a plugin's capsule is the host's capsule. Absent (a hosted-web realm), they draw a plain solid
   * capsule whose changes land at once.
   */
  capsuleHost?: HappierCapsuleHost;
  /** Each mounted read-only viewer is admitted and disposed by the app's capture owner. */
  renderLiveStream?(input: HappierLiveStreamProps): ReactNode;
  /** The host's motion for the agent cursor (`AgentCursor`). Absent, the hand lands at once. */
  agentCursorMotion?: HappierAgentCursorMotionDriver;
  /**
   * The host's real type-role styles (family, tracking, tabular figures and a
   * heading step) for same-realm surfaces. The public theme snapshot carries
   * only metrics; this is the same-realm host fact every shared text owner
   * reads when present (`presentation/text/typeRole.ts`).
   */
  typography?: HappierUiTypography;
  /**
   * The host's configuration-page colour roles (sheets, row seams, field boxes,
   * switches, segmented choices, tiles) for same-realm surfaces. The public
   * theme snapshot carries no such roles; without this fact shared components
   * resolve them from the snapshot. A new value accompanies a theme change.
   */
  palette?: HappierUiPalette;
  /**
   * The navigation chrome the plugin page is mounted in (title shown by the
   * chrome, the back control, the content column), so the public `PageHeader`
   * and page sections place themselves exactly as Happier's own pages do.
   */
  pageChrome?: HappierPageChrome;
  /** Manifest-owned brand fact for the mounted plugin; authors cannot replace it. */
  brand?: Readonly<{
    displayName: string;
    monochrome?: boolean;
    resource?: Readonly<{ pluginId: string; localId: string }>;
  }>;
  /**
   * Resolve one exact installed package name inside the host. The plugin never
   * receives the installed-package projection, a catalog, or a lookup map.
   */
  resolveBrandDisplayName?(pluginId: string): string | undefined;
  /**
   * Render one exact installed package mark through the host's private Resource
   * lifecycle. This never grants cross-plugin `readResource` authority.
   */
  renderBrandMark?(input: PluginUiTargetBrandMarkInput): ReactElement | undefined;
  /**
   * Render one target-local embedded contributor through the incumbent physical
   * host. This stays package-private: authors receive only `TargetedSurface`,
   * never a renderer, portal, catalog, artifact, or lifecycle control.
   */
  renderTargetedSurface?(input: PluginUiTargetedSurfacePresentation): ReactNode;
  /**
   * A mounted targeted child cannot become a second targeted-surface parent.
   * The host keeps the supplied fallback local and names that deliberate
   * refusal so the author primitive can report it through its installed Host
   * API diagnostic method.
   */
  targetedSurfaceUnavailableReason?: 'unsupported_nested_targeted_surface';
  /**
   * Render one part of a host-owned Account Session (`SessionProvider`, `SessionTranscript`,
   * `SessionComposer`, `SessionChat`). The host's one Session implementation renders it; the plugin
   * never renders a transcript or composer itself. Absent where the host cannot present a Session
   * (isolated tests, hosted-web realms): the author's fallback renders instead.
   */
  renderSessionPart?(input: PluginUiSessionPartPresentation): ReactNode;
  /**
   * Render one declared widget area of this page through the host's one widget area owner (the
   * public `WidgetSurface`). Absent where the host cannot present widgets (isolated tests, a
   * hosted-web realm): the author's fallback renders instead.
   */
  renderWidgetArea?(input: PluginUiWidgetAreaPresentation): ReactNode;
  /**
   * Transfer an opaque public control target through the mounted app host.
   * The app retains layout currentness and platform-specific physical focus;
   * plugin code never receives either owner.
   */
  focusTarget?(target: HappierFocusable): boolean;
  renderMarkdown(input: Readonly<{
    value: string;
    selectable: boolean;
    testID?: string;
  }>): ReactNode;
  renderCodeBlock(input: Readonly<{
    code: string;
    language?: string;
    selectable: boolean;
    testID?: string;
  }>): ReactNode;
  /**
   * Render one read-only unified diff through the incumbent product renderer.
   * Parsing, syntax highlighting, settings, and virtualization remain host-owned.
   */
  renderDiffViewer?(input: HappierDiffViewerRequest): ReactNode;
  renderPopover(input: Readonly<{
    open: boolean;
    anchorRef: RefObject<unknown>;
    /** Optional physical ScrollArea source for the incumbent Popover to track. */
    followScrollRef?: RefObject<unknown>;
    /** Focus return stays separate from the measurable positioning anchor. */
    focusReturnRef?: RefObject<unknown>;
    /** Menu rows nominate the physical initial target; the app Popover owns focusing it. */
    initialFocusRef?: RefObject<unknown>;
    placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
    /** Semantic disposition selects the host's established portal sizing contract. */
    presentation?: PluginUiPopoverPresentation;
    /** Menu-like content asks the incumbent host Popover to move focus on open. */
    autoFocusOnOpen?: boolean;
    onRequestClose(): void;
    content(controls: PluginUiPopoverContentControls): ReactNode;
  }>): ReactNode;
  renderIcon(input: Readonly<{
    name: string;
    size: number;
    color?: string;
    accessibilityLabel?: string;
    testID?: string;
  }>): ReactNode;
  /**
   * Render one QR code through the incumbent app QR renderer. Optional on
   * hosts without that capability; authors must keep a non-visual twin of any
   * QR payload (copyable token or link) because a QR never becomes the only
   * accessible representation of the data it carries.
   */
  renderQRCode?(input: PluginUiQRCodePresentation): ReactNode;
  /**
   * Render one person's mark through the host's avatar owner (the same generated mark and monogram
   * Happier draws for people), sized in points. Absent, the public `Avatar` draws a plain monogram.
   */
  renderAvatar?(input: Readonly<{ name: string; size: number; testID?: string }>): ReactNode;
}>;

const PluginUiPresentationHostContext = createContext<PluginUiPresentationHost | null>(null);

/** @internal The surface bridge re-provides this across the host's details pane (`components/surfaceBridge.tsx`). */
export const PLUGIN_UI_PRESENTATION_HOST_CONTEXT_INTERNAL = PluginUiPresentationHostContext;

/**
 * Physical scroll identity for a plugin-owned ScrollArea. This is private
 * composition data only: the app Popover still owns listener registration,
 * positioning, and currentness.
 */
const PluginUiPopoverScrollSourceContext = createContext<RefObject<unknown> | null>(null);

export function PluginUiPresentationHostProviderInternal(props: Readonly<{
  host: PluginUiPresentationHost;
  children?: ReactNode;
}>) {
  return createElement(PluginUiPresentationHostContext.Provider, { value: props.host }, props.children);
}

export function PluginUiPopoverScrollSourceProvider(props: Readonly<{
  scrollSourceRef: RefObject<unknown>;
  children?: ReactNode;
}>) {
  return createElement(
    PluginUiPopoverScrollSourceContext.Provider,
    { value: props.scrollSourceRef },
    props.children,
  );
}

export function useOptionalPluginUiPresentationHost(): PluginUiPresentationHost | null {
  return useContext(PluginUiPresentationHostContext);
}

export function useOptionalPluginUiPopoverScrollSource(): RefObject<unknown> | null {
  return useContext(PluginUiPopoverScrollSourceContext);
}
