import * as React from 'react';
import { Platform, View } from 'react-native';

import { requireReactDOM } from '@/utils/web/reactDomCjs';

/** Where the docked right panel stands, resolved by the frame for this window: its own sheet on the canvas, or in the page. */
export type AppShellRightPanelPlacement = 'canvas' | 'sheet';
/** How a right panel joined to the page is divided from it (R11-3): a hairline, or the header's soft shade. */
export type AppShellPanelDivider = 'line' | 'shadow';

/**
 * The shell's trailing slot (calm-shell R4-2, R11-1), resolved once by `AppShellMaterialFrame`. A page's
 * action rail always stands in `railHost`, on the canvas beside the page sheet like the app rail. With the
 * `canvas` placement the docked right panel stands in `rightHost` too, as its own sheet; with `sheet` it
 * joins the page inside its sheet, divided from it by `divider`. `containerWidthPx` is the width the page
 * sheet has when the tail is empty, so a pane host budgets the same layout in every placement.
 */
export type AppShellTail = Readonly<{
  placement: AppShellRightPanelPlacement;
  divider: AppShellPanelDivider;
  /** The web shell's chrome is shown: a page's rail stands on the canvas, in `railHost`. */
  railOnCanvas: boolean;
  rightHost: HTMLElement | null;
  railHost: HTMLElement | null;
  /** Where a rail with nothing standing on it keeps its More: the title strip's trailing controls. */
  railMoreHost: HTMLElement | null;
  containerWidthPx: number | null;
  /** A joined panel's tab is the rail's first action: the page squares its top trailing corner into it. */
  joinTrailingTopCorner: (joined: boolean) => void;
}>;

export const AppShellTailContext = React.createContext<AppShellTail | null>(
  null,
);

const AppShellTitleMoreHostContext = React.createContext<((node: unknown) => void) | null>(null);

/** The frame hands the title strip its one attach point for `railMoreHost`. */
export const AppShellTitleMoreHostProvider = AppShellTitleMoreHostContext.Provider;

/** In the title strip's trailing controls: empty and without width until a vacant rail's More stands in it. */
export function AppShellTitleMoreSlot(): React.ReactNode {
  const attach = React.useContext(AppShellTitleMoreHostContext);
  return attach ? <View ref={attach} testID="app-shell-title-more" style={TITLE_MORE_STYLE} /> : null;
}

const TITLE_MORE_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;

/** The frame's tail, or null outside the app shell and inside a pane host that already took it. */
export function useAppShellTail(): AppShellTail | null {
  return React.useContext(AppShellTailContext);
}

/**
 * Renders its children in `host` (a tail host) when one is given, otherwise where it stands. The
 * children live in one stable container for the slot's whole life, and only that container moves
 * between the two places, so a move never remounts them: drafts, focus owners and React state stay.
 * While `hidden` (a scope that is not on screen) the container keeps its place in the tail but takes
 * no room and shows nothing. Web only; native shells always keep the page placement.
 */
export function AppShellTailSlot(
  props: Readonly<{
    host: HTMLElement | null;
    hidden?: boolean;
    children: React.ReactNode;
  }>,
): React.ReactNode {
  const [container] = React.useState<HTMLDivElement | null>(() =>
    Platform.OS === 'web' && typeof document !== 'undefined'
      ? createSlotContainer()
      : null,
  );
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const { host, hidden } = props;
  const place = React.useCallback(() => {
    if (!container) return;
    const target = host ?? anchorRef.current;
    if (target && container.parentNode !== target)
      target.appendChild(container);
    container.style.display = host && hidden ? 'none' : 'contents';
  }, [container, hidden, host]);
  // The anchor comes before the portal, so it places the container before the children's own layout
  // effects measure anything.
  const attachAnchor = React.useCallback(
    (node: HTMLDivElement | null) => {
      anchorRef.current = node;
      place();
    },
    [place],
  );
  React.useLayoutEffect(place, [place]);
  React.useEffect(
    () => () => {
      container?.remove();
    },
    [container],
  );
  if (!container) return props.children;
  const reactDom = requireReactDOM() as Pick<
    typeof import('react-dom'),
    'createPortal'
  >;
  return (
    <>
      <div ref={attachAnchor} style={SLOT_STYLE} />
      {reactDom.createPortal(props.children, container)}
    </>
  );
}

const SLOT_STYLE = { display: 'contents' } as const;

function createSlotContainer(): HTMLDivElement {
  const node = document.createElement('div');
  node.style.display = 'contents';
  return node;
}
