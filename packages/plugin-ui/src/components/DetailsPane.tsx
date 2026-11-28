import { useHappierMaterialColorResolver } from '../presentation/layout/Surface.js';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { resolveHappierUiPalette, useHappierUiInsets, useOptionalHappierUiPalette } from '../environment/context.js';
import { HappierCollectionNavigationBackClosesDetailContext } from '../presentation/collection/collectionLayout.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';

import {
  useOptionalPluginUiPresentationHost,
  type PluginUiDetailsPaneHost,
} from '../presentationHost/context.js';
import { HappierPageHeader, HappierPageHeadingBindingContext } from '../presentation/layout/PageHeader.js';
import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { Button, IconButton } from './Button.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';
import { useCollectionDetailHeadingBindingInternal } from './Focus.js';
import { HappierColumnEdgeContext, useHappierColumnEdgePx } from '../presentation/layout/columnEdge.js';
import { HappierTextActionEdgeContext } from '../presentation/interaction/textActionEdge.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';

export type DetailsPaneProps = Readonly<{
  /** Whether the detail is open. The plugin keeps the open item in its own location (`replacePageLocation`). */
  open: boolean;
  /** The pane's title in its header band. Omit it when the detail draws its own heading and close control. */
  title?: string;
  /**
   * The line under the title. Separate facts (where it lives, who opened it, its branches) go as segments: the
   * header joins them and wraps whole facts, never inside one.
   */
  subtitle?: string | readonly string[];
  /**
   * Where the item lives, outermost first, above the title in the pane's band ("owner/repo › #2476"). A detail
   * pushed as the page names its place in its facts line instead, so the pushed header does not draw it.
   */
  breadcrumb?: readonly string[];
  /** The item's identity mark beside the title (a kind glyph). It stands on its own: no tile, border or fill. */
  leading?: ReactNode;
  /** A mark leading the subtitle line (the source's brand mark). */
  subtitleLeading?: ReactNode;
  /** The detail's actions, beside the pane's close button (icon buttons). */
  actions?: ReactNode;
  /** The pane asks to close: its close or back control, Escape, or a tap outside an overlay pane. */
  onClose: () => void;
  children?: ReactNode;
  /**
   * The detail's one primary, pinned in thumb reach when the detail is pushed (phones): under a flat
   * hairline at the foot of the page, above the home indicator and the keyboard, while the detail
   * scrolls above it. Beside the page (the details pane) it is not drawn: the primary lives in
   * `actions` there.
   */
  footer?: ReactNode;
  testID?: string;
}>;

const NO_PANE_HOST = null;

/**
 * Choose the current pane placement, retaining an open detail's choice until close. Fresh opens
 * push in-page where the host has no pane beside it (phones or side panes turned off).
 */
/** @internal The Collection reads it to choose its container. */
export function useDetailsPanePlacement(open: boolean) {
  const binding = useOptionalPluginUiPresentationHost()?.detailsPane ?? NO_PANE_HOST;
  return useBindingPlacement(binding, open);
}

/** @internal Whether the host placed this surface in a pane host at all, its pane beside the page or not. */
export function useDetailsPaneHostInstalled(): boolean {
  return (useOptionalPluginUiPresentationHost()?.detailsPane ?? NO_PANE_HOST) !== null;
}

/**
 * The host binding is installed once per mount, so the same hook runs on every render of a given
 * surface; where there is none a constant stands in.
 */
function useBindingPlacement(binding: PluginUiDetailsPaneHost | null, open: boolean) {
  const useAvailable = binding?.useAvailable ?? useNoPane;
  const beside = useAvailable();
  // Placement is chosen on open. Moving children between the slot and the page remounts their
  // owners; the app pane already fills the viewport when side panes no longer fit.
  const [placement, setPlacement] = useState<Readonly<{ binding: PluginUiDetailsPaneHost | null; available: boolean }> | null>(null);
  let current = placement;
  if (!open || current?.binding !== binding) current = null;
  if (open && current === null) current = { binding, available: beside };
  if (current !== placement) setPlacement(current);
  return { inPane: current?.available ?? beside, beside };
}

function useNoPane(): boolean {
  return false;
}

function useDetailPageTitle(title: string | undefined, ownsTitle = true) {
  const publish = useHappierPageChromeInternal()?.publishPageTitle;
  useEffect(() => {
    if (!ownsTitle) return;
    publish?.(title);
    return () => publish?.(undefined);
  }, [ownsTitle, publish, title]);
}

/**
 * An item opened beside the page, in the page's **app details pane** — the same pane every Happier
 * page opens details in: one band with the title, the actions and a close button, the width the user
 * last gave it, docked beside the page or over it when the page would get too narrow, Escape and
 * focus return. Where there is no pane beside the page (phones, side panes turned off, a surface the
 * host placed in no pane host) the detail is pushed inside the page with a way back.
 *
 * The children render where the pane is, not where `DetailsPane` is declared: they keep this plugin's
 * context (theme, translation, the surface context, the Host API and every public component), and
 * they read the page's state through the props and closures you pass them. React context that your
 * own components provide above `DetailsPane` does not reach them; provide it inside the children.
 *
 * ```tsx
 * <DetailsPane open={entry !== null} title={entry?.title} actions={<OpenOnGitHub />}
 *   onClose={() => host.replacePageLocation('', { backLocation: '' })}>
 *   <EntryDetail entry={entry} />
 * </DetailsPane>
 * ```
 */
export function DetailsPane(props: DetailsPaneProps): ReactElement | null {
  useDetailPageTitle(props.open ? props.title : undefined);
  const headingRef = useCollectionDetailHeadingBindingInternal();
  const binding = useOptionalPluginUiPresentationHost()?.detailsPane ?? NO_PANE_HOST;
  const { inPane, beside } = useBindingPlacement(binding, props.open);
  const bridge = usePluginUiSurfaceBridge();
  if (binding !== null && inPane) {
    return (
      <>
        {binding.renderDetailsPane({
          open: props.open,
          ...(headingRef === undefined ? {} : { headingRef }),
          ...(props.title === undefined ? {} : { title: props.title }),
          ...(props.subtitle === undefined ? {} : { subtitle: props.subtitle }),
          ...(props.breadcrumb === undefined ? {} : { breadcrumb: props.breadcrumb }),
          ...(props.leading === undefined ? {} : { leading: bridge(props.leading) }),
          ...(props.subtitleLeading === undefined ? {} : { subtitleLeading: bridge(props.subtitleLeading) }),
          ...(props.actions === undefined ? {} : { actions: bridge(props.actions) }),
          onClose: props.onClose,
          // One element whatever the title, so the detail never remounts when its band comes or goes.
          children: bridge(<>
            <DetailsPaneBody inset={props.title !== undefined}>{props.children}</DetailsPaneBody>
            {beside || props.footer === undefined ? null : (
              <DetailsPaneFooter testID={props.testID === undefined ? undefined : `${props.testID}:footer`}>{props.footer}</DetailsPaneFooter>
            )}
          </>),
          ...(props.testID === undefined ? {} : { testID: props.testID }),
        })}
      </>
    );
  }
  if (!props.open) return null;
  return <PushedDetail {...props} />;
}

/** The detail as the page: over the page's content, on the page's ground, a back control, the title and the actions. */
function PushedDetail(props: DetailsPaneProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const materialColor = useHappierMaterialColorResolver();
  const translate = usePluginTranslation();
  return (
    <View
      testID={props.testID}
      role="dialog"
      aria-modal={true}
      accessibilityViewIsModal
      accessibilityLabel={props.title ?? translate('happier.plugin-ui.detailsPane.back', 'Back')}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: materialColor(palette.page, 'transparent'),
      }}
    >
      <PushedDetailHeader {...props} />
      <DetailsPaneBody inset={props.title !== undefined}>{props.children}</DetailsPaneBody>
      {props.footer === undefined ? null : (
        <DetailsPaneFooter testID={props.testID === undefined ? undefined : `${props.testID}:footer`}>{props.footer}</DetailsPaneFooter>
      )}
    </View>
  );
}

/**
 * @internal The body of a detail. Where the platform draws its title (`inset`: the details pane's band, the
 * pushed detail's header) its content stands on the title's edge, the page's sheet inset, so a plain line of text lines up under
 * the title instead of touching the pane's side. It draws only the part of that edge its column does not draw already:
 * a pushed detail is the page, whose host column already stands on the edge (a plugin page's gutter), so it adds
 * nothing there and the body, the band and the story's title share one edge. The details pane (a new root, see
 * `usePluginUiSurfaceBridge`) and the detail beside its list (`Collection`) are columns of their own and start at `0`. Sheets, page states and headings inside keep their own edges
 * (`HappierColumnEdgeContext`); `DetailsPaneFooter` still spans the whole width.
 */
/** How far a detail's body pads its content, which its pinned footer reaches back across to span the body. */
const DetailsPaneBodyPaddingContext = createContext(0);

export function DetailsPaneBody(props: Readonly<{ inset: boolean; children?: ReactNode }>): ReactElement {
  const columnEdgePx = useHappierColumnEdgePx();
  const edgePx = props.inset ? Math.max(columnEdgePx, HAPPIER_PAGE_METRICS.sheetInsetPx) : 0;
  const paddingPx = props.inset ? edgePx - columnEdgePx : 0;
  return (
    <View style={{ flex: 1, minHeight: 0, paddingHorizontal: paddingPx }}>
      <HappierColumnEdgeContext.Provider value={edgePx}>
        <DetailsPaneBodyPaddingContext.Provider value={paddingPx}>{props.children}</DetailsPaneBodyPaddingContext.Provider>
      </HappierColumnEdgeContext.Provider>
    </View>
  );
}

/**
 * @internal The band that leads a detail which is the page (pushed): the one way back, then the title, its facts
 * line and actions. `DetailsPane` draws it where no pane sits beside the page; a `Collection` draws it above its
 * pushed detail, so every pushed detail has the same way back whatever its author draws. Without a title (the
 * author draws its own heading) the band is the back control alone, on the page's text edge.
 */
/**
 * @internal A pushed detail's hosted title, offered to the detail's own story (`useDetailPageLead`). `claim` reports
 * that the story draws it, so the Collection draws no fixed title band of its own.
 */
export type PushedDetailLeadInternal = Readonly<{ header: ReactNode; claim: () => () => void }>;

/** @internal Provided by `Collection` around a pushed detail with a hosted header. */
export const PushedDetailLeadContextInternal = createContext<PushedDetailLeadInternal | null>(null);

/**
 * Where a detail is the page (a phone's pushed detail), its hosted title as content: place it at the top of the
 * story that scrolls, and it scrolls away with the page as in the lab, the navigation band keeping the way back.
 * While a detail draws it, the Collection draws no fixed title band. `null` beside the list or without a hosted title.
 */
export function useDetailPageLead(): ReactNode | null {
  const lead = useContext(PushedDetailLeadContextInternal);
  const claim = lead?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  return lead?.header ?? null;
}

/**
 * @internal The one owner of where a pushed detail's title stands: its band above the detail (`band`, or `backOnly`
 * while the detail's story carries the title) and the lead it offers that story (`useDetailPageLead`). `Collection`
 * and `DetailPage` compose a detail that is the page through it, so both read alike.
 */
export function usePushedDetailPageInternal(
  renderHeader: (placement: PushedDetailHeaderPlacementInternal) => ReactNode,
  titleHosted: boolean,
): Readonly<{ band: ReactNode; lead: PushedDetailLeadInternal | null }> {
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((count) => count + 1);
    return () => { setClaims((count) => count - 1); };
  }, []);
  return {
    band: renderHeader(titleHosted && claims > 0 ? 'backOnly' : 'band'),
    lead: titleHosted ? { header: renderHeader('story'), claim } : null,
  };
}

export type DetailPageProps = Readonly<Pick<DetailsPaneProps, 'title' | 'subtitle' | 'leading' | 'subtitleLeading' | 'actions' | 'testID'> & {
  /** The way back from this page: the list or page the item belongs to. */
  onBack: () => void;
  /** The name of the page `onBack` returns to ("PRs & Issues"): the way back reads as it. */
  backLabel?: string;
  /**
   * Below this measured width the detail is the page: the width at which this item's own list page stops splitting
   * (its list and detail minima together), so the item reads the same opened from its list or from its address.
   */
  pushedBelowWidthPx: number;
  /**
   * The detail. `pushed` says the detail is the page (pin its one primary in a `DetailsPaneFooter`); `headerHosted`
   * says this page draws its title band, so the detail leaves out its own and may lead its story with
   * `useDetailPageLead`. The same facts a `Collection` hands its `renderDetail`.
   */
  children: (context: Readonly<{ pushed: boolean; headerHosted: boolean }>) => ReactNode;
}>;

/**
 * An item that is its own page, opened by its address (a link to a pull request) rather than from a list on this
 * page. Narrower than `pushedBelowWidthPx` it is the detail pushed as the page, exactly as a `Collection`'s pushed
 * detail: the one way back, the title leading the detail's story and the body on the title's edge. Wider it is the
 * plain page and the detail draws its own header and actions. Like the Collection it is the narrow page until it has
 * measured, and the detail stays mounted when the page crosses between the two.
 */
export function DetailPage(props: DetailPageProps): ReactElement {
  const [widthPx, setWidthPx] = useState<number | null>(null);
  const pushed = widthPx === null || widthPx < props.pushedBelowWidthPx;
  const headerHosted = pushed && props.title !== undefined;
  const page = usePushedDetailPageInternal((placement) => (
    <PushedDetailHeader
      {...(props.title === undefined ? {} : { title: props.title })}
      {...(props.subtitle === undefined ? {} : { subtitle: props.subtitle })}
      {...(props.leading === undefined ? {} : { leading: props.leading })}
      {...(props.subtitleLeading === undefined ? {} : { subtitleLeading: props.subtitleLeading })}
      {...(props.actions === undefined ? {} : { actions: props.actions })}
      onClose={props.onBack}
      {...(props.backLabel === undefined ? {} : { backLabel: props.backLabel })}
      placement={placement}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    />
  ), headerHosted);
  return (
    <View
      style={{ flex: 1, minHeight: 0 }}
      onLayout={(event) => { setWidthPx(event.nativeEvent.layout.width); }}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {pushed ? page.band : null}
      <PushedDetailLeadContextInternal.Provider value={pushed ? page.lead : null}>
        <DetailsPaneBody inset={headerHosted}>{props.children({ pushed, headerHosted })}</DetailsPaneBody>
      </PushedDetailLeadContextInternal.Provider>
    </View>
  );
}

/**
 * Where a pushed detail's header stands: `band` (fixed above the detail, the default); `story`, the title leading the
 * detail's own scrolling story (`useDetailPageLead`), which leaves the way back to the band; `backOnly`, the band's
 * part while the story carries the title: the way back, and the compact title handed to navigation that shows one.
 */
export type PushedDetailHeaderPlacementInternal = 'band' | 'story' | 'backOnly';

export function PushedDetailHeader(props: Readonly<Pick<DetailsPaneProps, 'title' | 'subtitle' | 'leading' | 'subtitleLeading' | 'actions' | 'onClose' | 'testID'>
  & {
    placement?: PushedDetailHeaderPlacementInternal;
    /** The page the way back returns to, by name ("‹ PRs & Issues"); without it the way back is the Back glyph. */
    backLabel?: string;
  }>): ReactElement {
  // The story mirrors the band's identity; the band remains the single publisher.
  useDetailPageTitle(props.title, props.placement !== 'story');
  const placement = props.placement ?? 'band';
  const headingRef = useCollectionDetailHeadingBindingInternal();
  const translate = usePluginTranslation();
  // The navigation's own Back already returns to the list here: one way back, not two.
  const chrome = useHappierPageChromeInternal();
  const chromeBack = chrome?.navigationBackSpendsStep === true;
  const collectionBack = useContext(HappierCollectionNavigationBackClosesDetailContext);
  const hostBack = collectionBack || chromeBack;
  // One band above a pushed detail: where the navigation draws one, the way back joins it (lab alert-detail-pr 390).
  // Never read from `chromeBack`: the published Back itself makes the navigation show one, and would withdraw itself.
  // Only one placement publishes the way back: the story's title leaves it to the band (never two publishers).
  const publishBack = collectionBack || placement === 'story' ? undefined : chrome?.publishBack;
  const latestClose = useRef(props.onClose);
  latestClose.current = props.onClose;
  const backLabel = props.backLabel;
  const columnEdgePx = useHappierColumnEdgePx();
  useEffect(() => {
    if (publishBack === undefined) return undefined;
    publishBack(() => { latestClose.current(); }, backLabel);
    return () => publishBack(null);
  }, [backLabel, publishBack]);
  const backTestID = props.testID === undefined ? {} : { testID: `${props.testID}:back` };
  const backInBand = hostBack || publishBack !== undefined;
  // A phone's local Back row takes the actions from the same host that lends them to the list toolbar.
  // When the route draws Back instead, the route already has the actions.
  const localBackActions = !backInBand && placement !== 'story' && chrome?.largeTitle === true
    ? chrome.renderNavigationActions?.(null, 'page') : null;
  const back = (style?: HappierStyleProp, textEdge: 'start' | null = null) => <View style={[style, localBackActions == null ? null : {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexGrow: 1,
  }]}><HappierTextActionEdgeContext.Provider value={textEdge}>{backLabel === undefined ? <IconButton
    icon={<Icon name="back" tone="secondary" />}
    accessibilityLabel={translate('happier.plugin-ui.detailsPane.back', 'Back')}
    onPress={props.onClose}
    {...backTestID}
  /> : <Button variant="plain" size="small" singleLine icon={<Icon name="back" tone="secondary" />} title={backLabel}
    onPress={props.onClose} {...backTestID} />}</HappierTextActionEdgeContext.Provider>
    {localBackActions == null ? null : <View style={{ flexDirection: 'row', alignItems: 'center', gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx }}>
      {localBackActions}
    </View>}
  </View>;
  // While the story carries the title the band is the way back alone: the title is said once, in the story that
  // scrolls (lab merged-detail-pr phone, "‹ PRs & Issues" above the large title; DESIGN-LIVE-225).
  if (props.title === undefined || placement === 'backOnly') {
    if (backInBand) return <View />;
    return back({
      flexDirection: 'row',
      alignItems: 'center',
      gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
      // The way back starts on the story's text edge: the column already brings its own edge (phone page),
      // and the plain label sits on that edge rather than its own padding (review P1, ~30 px in on 390).
      paddingHorizontal: Math.max(0, HAPPIER_PAGE_METRICS.pageTextInsetPx - HAPPIER_PAGE_METRICS.headingOpticalInsetPx - columnEdgePx),
      paddingTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx,
    }, 'start');
  }
  return (
    <HappierPageHeadingBindingContext.Provider value={headingRef}>
      <HappierPageHeader
        title={props.title}
        // A line led by a mark is the item's facts line (the header's meta), its mark before the words.
        {...(props.subtitle === undefined ? {} : props.subtitleLeading === undefined
          ? { description: typeof props.subtitle === 'string' ? props.subtitle : props.subtitle.join(' · ') }
          // Each fact its own meta item, so the line wraps between facts; the mark leads the first.
          : { meta: (typeof props.subtitle === 'string' ? [props.subtitle] : props.subtitle).map((text, index) => (
            index === 0 ? { key: 'subtitle', text, icon: props.subtitleLeading } : { key: `subtitle:${index}`, text })) })}
        {...(props.leading === undefined ? {} : { leading: props.leading })}
        actions={props.actions}
        // A detail's actions are its item's own quiet controls (pin, open at the source): they hang from the title's
        // first line, as in the details pane's band, instead of wrapping onto a row of their own on a phone.
        actionsLayout="hang"
        renderBack={backInBand || placement === 'story' ? null : back}
      />
    </HappierPageHeadingBindingContext.Provider>
  );
}

/**
 * The pinned footer of a detail that is the page (pushed): page ground under a flat ink hairline, the page's edge
 * inset, the home-indicator inset below. It arrives with the page (no motion of its own), and the host's keyboard
 * owner, where there is one, keeps it above the keyboard.
 *
 * `DetailsPane` draws it for its `footer`. A `Collection` detail places it itself as the last child of its own
 * full-height column when `renderDetail` receives `pushed: true`; the story above it scrolls and the footer stays.
 * Draw it only while pushed: beside the page the primary lives in the details pane's header actions.
 */
export function DetailsPaneFooter(props: Readonly<{ children: ReactNode; testID?: string | undefined }>): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const materialColor = useHappierMaterialColorResolver();
  const { safeArea } = useHappierUiInsets();
  const host = useOptionalPluginUiPresentationHost();
  // Inside a detail's body (which pads its content) the footer still spans the detail's whole width.
  const edgePx = useContext(DetailsPaneBodyPaddingContext);
  // The pause a group edge makes: the page's existing measure for a seam inside its column.
  const gap = HAPPIER_PAGE_METRICS.groupSeparatorGapPx;
  const paddingBottom = Math.max(safeArea.bottom, gap);
  const content = <HappierColumnEdgeContext.Provider value={0}>{props.children}</HappierColumnEdgeContext.Provider>;
  // The host's pinned bar owns the phone's bottom, so the shell's bar folds instead of stacking under this one.
  const hostBar = host?.renderPagePinnedBar?.({
    ...(props.testID === undefined ? {} : { testID: props.testID }),
    style: { paddingTop: gap, paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    children: content,
  });
  const footer = hostBar ? <View style={{ marginHorizontal: -edgePx }}>{hostBar}</View> : (
    <View
      testID={props.testID}
      style={{
        backgroundColor: materialColor(palette.page, 'transparent'),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: palette.rowDivider,
        paddingTop: gap,
        paddingBottom,
        paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
        marginHorizontal: -edgePx,
      }}
    >
      {content}
    </View>
  );
  return host?.renderKeyboardStickyFooter === undefined
    ? footer
    : <>{host.renderKeyboardStickyFooter({ offset: paddingBottom - gap, children: footer })}</>;
}
