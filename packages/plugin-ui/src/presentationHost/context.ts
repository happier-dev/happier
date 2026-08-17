import { createContext, createElement, useContext, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiTargetedContributionSurfaceV1 } from '@happier-dev/plugin-sdk/ui';

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
 * Host-owned product renderers that a bundled plugin surface may delegate to.
 *
 * This is deliberately package-internal. Authors get semantic components such
 * as `Markdown` and `CodeBlock`; they never receive Happier's renderer objects,
 * navigation roots, or modal/portal infrastructure.
 */
export type PluginUiPresentationHost = Readonly<{
  /** Manifest-owned brand fact for the mounted plugin; authors cannot replace it. */
  brand?: Readonly<{
    displayName: string;
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
   * Transfer an opaque public control target through the mounted app host.
   * The app retains layout currentness and platform-specific physical focus;
   * plugin code never receives either owner.
   */
  focusTarget?(target: unknown): boolean;
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
}>;

const PluginUiPresentationHostContext = createContext<PluginUiPresentationHost | null>(null);

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
