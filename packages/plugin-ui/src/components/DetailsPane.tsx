import { useContext, useState, type ReactElement, type ReactNode } from 'react';
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
import { IconButton } from './Button.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { usePluginUiSurfaceBridge } from './surfaceBridge.js';
import { useCollectionDetailHeadingBindingInternal } from './Focus.js';
import { HappierColumnEdgeContext, useHappierColumnEdgePx } from '../presentation/layout/columnEdge.js';
import { useHappierPageChromeInternal } from '../presentation/layout/pageChrome.js';

export type DetailsPaneProps = Readonly<{
  /** Whether the detail is open. The plugin keeps the open item in its own location (`replacePageLocation`). */
  open: boolean;
  /** The pane's title in its header band. Omit it when the detail draws its own heading and close control. */
  title?: string;
  subtitle?: string;
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
        backgroundColor: palette.page,
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
 * the title instead of touching the pane's side. Sheets, page states and headings inside keep their own edges
 * (`HappierColumnEdgeContext`); `DetailsPaneFooter` still spans the whole width.
 */
export function DetailsPaneBody(props: Readonly<{ inset: boolean; children?: ReactNode }>): ReactElement {
  const edgePx = props.inset ? HAPPIER_PAGE_METRICS.sheetInsetPx : 0;
  return (
    <View style={{ flex: 1, minHeight: 0, paddingHorizontal: edgePx }}>
      <HappierColumnEdgeContext.Provider value={edgePx}>{props.children}</HappierColumnEdgeContext.Provider>
    </View>
  );
}

/**
 * @internal The band that leads a detail which is the page (pushed): the one way back, then the title, its facts
 * line and actions. `DetailsPane` draws it where no pane sits beside the page; a `Collection` draws it above its
 * pushed detail, so every pushed detail has the same way back whatever its author draws. Without a title (the
 * author draws its own heading) the band is the back control alone, on the page's text edge.
 */
export function PushedDetailHeader(props: Readonly<Pick<DetailsPaneProps, 'title' | 'subtitle' | 'leading' | 'subtitleLeading' | 'actions' | 'onClose' | 'testID'>>): ReactElement {
  const headingRef = useCollectionDetailHeadingBindingInternal();
  const translate = usePluginTranslation();
  // The navigation's own Back already returns to the list here: one way back, not two.
  const chromeBack = useHappierPageChromeInternal()?.navigationBackSpendsStep === true;
  const hostBack = useContext(HappierCollectionNavigationBackClosesDetailContext) || chromeBack;
  const back = (style?: HappierStyleProp) => <View style={style}><IconButton
    icon={<Icon name="back" tone="secondary" />}
    accessibilityLabel={translate('happier.plugin-ui.detailsPane.back', 'Back')}
    onPress={props.onClose}
    {...(props.testID === undefined ? {} : { testID: `${props.testID}:back` })}
  /></View>;
  if (props.title === undefined) {
    if (hostBack) return <View />;
    return back({
      flexDirection: 'row',
      paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx - HAPPIER_PAGE_METRICS.headingOpticalInsetPx,
      paddingTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx,
    });
  }
  return (
    <HappierPageHeadingBindingContext.Provider value={headingRef}>
      <HappierPageHeader
        title={props.title}
        // A line led by a mark is the item's facts line (the header's meta), its mark before the words.
        {...(props.subtitleLeading === undefined || props.subtitle === undefined
          ? { description: props.subtitle }
          : { meta: [{ key: 'subtitle', text: props.subtitle, icon: props.subtitleLeading }] })}
        {...(props.leading === undefined ? {} : { leading: props.leading })}
        actions={props.actions}
        // A detail's actions are its item's own quiet controls (pin, open at the source): they hang from the title's
        // first line, as in the details pane's band, instead of wrapping onto a row of their own on a phone.
        actionsLayout="hang"
        renderBack={hostBack ? null : back}
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
  const { safeArea } = useHappierUiInsets();
  const host = useOptionalPluginUiPresentationHost();
  // Inside a detail's body (which pads its content) the footer still spans the detail's whole width.
  const edgePx = useHappierColumnEdgePx();
  // The pause a group edge makes: the page's existing measure for a seam inside its column.
  const gap = HAPPIER_PAGE_METRICS.groupSeparatorGapPx;
  const paddingBottom = Math.max(safeArea.bottom, gap);
  const footer = (
    <View
      testID={props.testID}
      style={{
        backgroundColor: palette.page,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: palette.rowDivider,
        paddingTop: gap,
        paddingBottom,
        paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
        marginHorizontal: -edgePx,
      }}
    >
      <HappierColumnEdgeContext.Provider value={0}>{props.children}</HappierColumnEdgeContext.Provider>
    </View>
  );
  return host?.renderKeyboardStickyFooter === undefined
    ? footer
    : <>{host.renderKeyboardStickyFooter({ openedOffset: paddingBottom - gap, children: footer })}</>;
}
