import { Children, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { PluginUiPageNavigationV1, PluginUiPageNavigationItemV1 } from '@happier-dev/plugin-sdk/ui';
import { isPluginError, readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';

import {
  HappierTabs,
  HappierTabsLead,
  useHappierTabPanelActivity,
  useOptionalHappierTabPanelActivityInternal,
  type HappierTabPanelActivity,
  type HappierTabRetention,
} from '../presentation/navigation/Tabs.js';
import { PLUGIN_SURFACE_CONTEXT_INTERNAL, usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { PLUGIN_HOST_API_CONTEXT_INTERNAL } from '../hostApi/context.js';
import type { TextTone } from './Text.js';
import { Dropdown } from './Overlay.js';
import { View } from 'react-native';
import { Icon } from './Icon.js';
import { HAPPIER_SEGMENTED_METRICS } from '../presentation/form/SegmentedChoice.js';
import { ListCollectionControlContext, type ListCollectionControl } from './listCollectionControl.js';

/** The page-scroll choice `layout="page"` hands its panels' Lists (the mode `Collection` uses for a page). */
const PAGE_SCROLL_LIST_CONTROL: ListCollectionControl = Object.freeze({ pageScroll: true });

/** The enclosing panel's current active interval. See {@link useTabPanelActivity}. */
export type TabPanelActivity = HappierTabPanelActivity;

/**
 * Read the enclosing tab panel's active interval.
 *
 * `activeSignal` ends when the panel is left — including a retained panel whose
 * subtree stays mounted — so a live read, reveal or completion delivery stops
 * without the panel discarding its parsed state. Returning opens the next
 * interval with a new signal.
 */
export function useTabPanelActivity(): TabPanelActivity {
  return useHappierTabPanelActivity();
}

export type TabsItemProps = Readonly<{
  value: string;
  title: string;
  /** Decorative or independently-labelled leading content for the tab trigger. */
  icon?: ReactNode;
  /** Portable glyph used by the host's phone navigation. */
  glyph?: PluginUiPageNavigationItemV1['glyph'];
  /** Page is the default; a companion names an already admitted destination. */
  phonePlacement?: PluginUiPageNavigationItemV1['phonePlacement'];
  badge?: string;
  /** Reserve space in the strip for a compact count that arrives after its tab. */
  reserveBadge?: boolean;
  /** The badge's tone: quiet by default; a count that is itself a state ("2 failing") takes that state's tone. */
  badgeTone?: TextTone;
  /** A quiet state dot, announced with the tab title. */
  marker?: string;
  disabled?: boolean;
  /**
   * Whether leaving this tab keeps its panel mounted.
   *
   * Omission and `discard` both unmount the panel and end its active interval;
   * `retain` keeps a visited panel's subtree and parsed state while its
   * interval ends. A retained panel must consume {@link useTabPanelActivity}.
   */
  retention?: HappierTabRetention;
  children?: ReactNode;
}> & (Readonly<{ kind?: 'page'; companion?: never }> | Readonly<{
  kind: 'companion' | 'both';
  companion: Extract<PluginUiPageNavigationItemV1, { kind: 'companion' }>['companion'];
}>);

function TabsItem(_props: TabsItemProps): null {
  return null;
}

export type TabsProps = Readonly<{
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  testID?: string;
  /**
   * `host` when an enclosing frame already draws the tab strip for this
   * surface: only the selected panel is visible, with the same retention and
   * active-interval rules as a shown strip.
   */
  tabList?: 'shown' | 'host';
  /**
   * `fill` gives the tab root and the active panel the parent's remaining
   * height, for panels that host a bounded view such as `SessionChat` or a
   * self-scrolling panel. The default `content` sizes to the panel, which is
   * right inside a scroll area. `page` sizes like `content` and also lays a panel's List out in its existing
   * page-scroll mode, so the rows scroll with the page around them instead of inside a bounded scroller.
   */
  layout?: 'content' | 'fill' | 'page';
  /**
   * One stateful renderer shared by the tabs, instead of per-item children.
   * The caller supplies the selected panel to that renderer; changing tabs
   * updates its label without remounting it. Nested Tabs own panel activity.
   */
  sharedPanel?: ReactNode;
  /**
   * `none`: a strip with little room shows each tab as its glyph alone, still named by its title for assistive
   * technology. It applies only when every tab has an `icon`; otherwise every label stays. Default `all`.
   */
  labels?: 'all' | 'none';
  /**
   * What leads the page above its tabs (an item's title and facts). Above the tab row while the row is drawn here;
   * where the row is drawn elsewhere (the host's navigation, `tabList="host"`) the selected panel places it where
   * its story starts with `<Tabs.Lead />`, so it scrolls away with the story.
   */
  lead?: ReactNode;
  children?: ReactNode;
}> & (Readonly<{ presentation?: 'tabs'; pageKind?: never; companionInput?: never }> | Readonly<{
  presentation: 'page';
  pageKind: PluginUiPageNavigationV1['pageKind'];
  companionInput?: PluginUiPageNavigationV1['companionInput'];
  /** Collection supplies its existing pushed-detail fact; full pages omit it. */
  phonePresented?: boolean;
}>);

function TabsRoot(props: TabsProps): ReactElement {
  const listControl = useContext(ListCollectionControlContext);
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [publicationFailed, setPublicationFailed] = useState(false);
  const host = useContext(PLUGIN_HOST_API_CONTEXT_INTERNAL);
  const context = useContext(PLUGIN_SURFACE_CONTEXT_INTERNAL);
  const ancestor = useOptionalHappierTabPanelActivityInternal();
  const publishing = !publicationFailed && props.presentation === 'page' && props.tabList !== 'host'
    && (host?.surfaceActive ?? true) && (ancestor?.active ?? true)
    && host?.hostApi.version().methods.includes('setPageNavigation') === true;
  // Page navigation and companion input determine publication identity. Theme,
  // callback, body and host placement updates must not re-register the Items.
  const candidate: PluginUiPageNavigationV1 | null = props.presentation === 'page' ? {
    pageKind: props.pageKind,
    value: props.value,
    ...(props.companionInput === undefined ? {} : { companionInput: props.companionInput }),
    ...(props.phonePresented === undefined ? {} : { phonePresented: props.phonePresented }),
    items: Children.toArray(props.children)
      .filter((child): child is ReactElement<TabsItemProps> => isValidElement(child))
      .map(child => child.props)
      .filter((item, index, items) => items.findIndex(candidate => candidate.value === item.value) === index)
      .map((item): PluginUiPageNavigationItemV1 => ({ value: item.value, title: item.title,
        phonePlacement: item.phonePlacement ?? 'bar',
        ...(item.glyph === undefined ? {} : { glyph: item.glyph }),
        ...(item.badge === undefined ? {} : { badge: item.badge }),
        ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
        ...(item.kind === 'companion' || item.kind === 'both' ? { kind: item.kind, companion: item.companion } : { kind: 'page' }),
      })),
  } : null;
  const portable = JSON.stringify(candidate);
  const stableDescriptor = useRef({ portable, descriptor: candidate });
  if (stableDescriptor.current.portable !== portable) stableDescriptor.current = { portable, descriptor: candidate };
  const descriptor = stableDescriptor.current.descriptor;
  const projection = context?.page?.navigation;
  const projected = publishing && descriptor && projection
    && projection.pageKind.pluginId === descriptor.pageKind.pluginId
    && projection.pageKind.localId === descriptor.pageKind.localId ? projection : null;
  const request = projected?.request ?? null;
  // This is delivery state for a transient host request, never a second
  // selected value. A render after the callback observes acceptance or rejection.
  const [delivered, setDelivered] = useState<string | null>(null);
  const settled = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (request === null) { settled.current = null; setDelivered(null); return; }
    if (request === delivered) return;
    setDelivered(request);
    props.onValueChange(request);
  }, [request, delivered, props.onValueChange]);
  const published = useRef<PluginUiPageNavigationV1 | null>(null);
  const api = host?.hostApi;
  const publicationFailedFor = useCallback((error: unknown, method: 'setPageNavigation' | 'executeAction'): boolean => {
    if (isPluginError(error) && (error.code === 'stale_surface' || error.code === 'aborted'
      || error.diagnostics?.some(item => item.code === 'plugin_ui_invocation_aborted'))) return false;
    setPublicationFailed(true);
    const requestId = readPluginErrorRequestIdV1(error);
    api?.diagnostic({ code: isPluginError(error) ? error.code : 'internal_error', severity: 'warning',
      message: 'Optional page navigation is unavailable; using local tabs.',
      details: { method, ...(requestId ? { requestId } : {}),
        ...(isPluginError(error) && error.diagnostics ? { diagnostics: error.diagnostics.map(item => item.code) } : {}) } });
    return true;
  }, [api]);
  useEffect(() => {
    if (!publishing || !api) return;
    return () => {
      published.current = null;
      // The physical mount owner also clears its declaration on retirement.
      // Its transport may already be gone when React runs this cleanup.
      void api.setPageNavigation(null).catch(() => {});
    };
  }, [publishing, api]);
  useEffect(() => {
    if (!publishing || !api || !descriptor || request !== null && delivered !== request) return;
    const settling = request !== null && settled.current !== request;
    if (published.current === descriptor && !settling) return;
    published.current = descriptor;
    settled.current = request;
    let cancelled = false;
    void api.setPageNavigation(descriptor).catch(error => {
      if (!cancelled) publicationFailedFor(error, 'setPageNavigation');
    });
    return () => { cancelled = true; };
  }, [publishing, api, descriptor, request, delivered, publicationFailedFor]);
  const stripValues = projected?.tabIds;
  const pageCount = descriptor?.items.filter(item => item.kind !== 'companion').length ?? 0;
  const desktopMore = projected?.presentation === 'local' && pageCount > 1;
  const select = (value: string): void => {
    if (!publishing || !api) { props.onValueChange(value); return; }
    void api.executeAction('shell.column.set', { column: 'main', visible: true, tab: value })
      .catch(error => {
        if (published.current === descriptor && publicationFailedFor(error, 'executeAction')) props.onValueChange(value);
      });
  };
  const moreLabel = translate('common.more', 'More');
  const trailing = desktopMore ? <Dropdown open={moreOpen} onOpenChange={setMoreOpen}
    trigger={moreLabel} triggerAccessibilityLabel={moreLabel}
    // The host page-tab strip's More: the glyph alone, as on every overflow trigger; the word is its name.
    triggerContent={props.presentation === 'page' ? <View style={{ flexDirection: 'row', alignItems: 'center',
      paddingVertical: HAPPIER_SEGMENTED_METRICS.plain.paddingVerticalPx,
      paddingHorizontal: HAPPIER_SEGMENTED_METRICS.plain.paddingHorizontalPx }}>
      <Icon name="more" size="small" tone="secondary" />
    </View> : undefined} items={[
      ...(projected.overflowIds ?? []).flatMap(value => {
        const item = descriptor?.items.find(item => item.value === value && item.kind !== 'companion');
        return item ? [{ id: `page:${item.value}`, label: item.title, icon: item.glyph, disabled: item.disabled }] : [];
      }),
      { id: 'customize', label: translate('common.customize', 'Customize') },
    ]} onSelect={id => {
      if (id === 'customize') {
        void api?.executeAction('settings.invoke', { anchor: 'appearance.navigationPlacements' })
          .catch(error => { if (published.current === descriptor) publicationFailedFor(error, 'executeAction'); });
      } else select(id.slice('page:'.length));
    }} /> : undefined;
  const hidden = props.tabList === 'host' || projected?.presentation === 'bottom'
    || (projected?.presentation === 'top' ? stripValues?.length === 0 : descriptor !== null && pageCount < 2);
  // The provider is unconditional so a layout change keeps the tree shape (and the panels' state); outside
  // `page` it passes the enclosing collection's control through unchanged.
  return <ListCollectionControlContext.Provider value={props.layout === 'page' ? PAGE_SCROLL_LIST_CONTROL : listControl}>
    <HappierTabs {...props} layout={props.layout === 'page' ? 'content' : props.layout} onValueChange={select} trailing={trailing}
      hideStrip={hidden} stripValues={stripValues} theme={theme}
      // A destination's page tabs draw the host page-tab strip; nested in-body Tabs keep the underline.
      strip={props.presentation === 'page' ? 'page' : 'underline'} />
  </ListCollectionControlContext.Provider>;
}

export const Tabs = Object.assign(TabsRoot, { Item: TabsItem, Lead: HappierTabsLead });
