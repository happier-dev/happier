import * as React from 'react';
import {
  Platform,
  StyleSheet as RNStyleSheet,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import {
  useContainingHappierMaterialRole,
  useHappierMaterialColorResolver,
} from '@happier-dev/plugin-ui/presentation';

import {
  PaneHeaderScrollIsolation,
  usePaneHeaderScrollSink,
} from '@/components/appShell/panes/paneHeaderScroll';
import {
  ScreenBackdropBoundary,
  useScreenSafeAreaBackdrop,
} from '@/components/navigation/safeArea/HorizontalSafeArea';
import { useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { PopoverScrollSourceProvider } from '@/components/ui/popover';
import { useScrollViewWheelScrollTo } from '@/components/ui/scroll/useScrollViewWheelScrollTo';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';
import { useSessionCockpitPageBottomClearance } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';

import {
  ListPresentationProvider,
  useContainedPageScope,
  type ListPresentation,
} from './listPresentation';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * What a page's scroller is to the things inside it: `scrollTo` (wheel fix, a setting row's reveal), the
 * scrollable node (popovers follow it) and the content node (near-viewport measurement). A ScrollView is one;
 * a virtualized page list hands an adapter over its own scroll owner.
 */
export type PageScrollTarget = Readonly<{
  scrollTo?: (
    options: Readonly<{ x?: number; y?: number; animated?: boolean }>,
  ) => void;
  getScrollableNode?: () => unknown;
  getInnerViewNode?: () => unknown;
  getInnerViewRef?: () => unknown;
}>;

export type PageScrollerInput = Readonly<{
  presentation: ListPresentation;
  pageNoticeActive?: boolean;
  /** The author's style; an authored background is the page's ground. */
  style?: StyleProp<ViewStyle>;
  horizontal?: boolean;
  /** The scroll owner the page draws. Stable for the scroller's life. */
  scrollRef: React.RefObject<PageScrollTarget | null>;
  onScroll?: (event: ScrollEvent) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  onWheel?: (event: unknown) => void;
  scrollEventThrottle?: number;
}>;

export type PageScroller = Readonly<{
  /** The page's ground and the author's style, for the scroll owner itself. */
  style: readonly StyleProp<ViewStyle>[];
  /** A card modal's body is the page's column (R-APP-7). */
  contained: boolean;
  /** How far the phone's floating tab bar covers the page's bottom (0 when none). */
  bottomChromeHeight: number;
  handlers: Readonly<{
    onScroll: (event: ScrollEvent) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onContentSizeChange: (width: number, height: number) => void;
    onWheel?: (event: unknown) => void;
    scrollEventThrottle?: number;
  }>;
  /** Wraps what scrolls: nothing inside claims the screen's backdrop or the pane header's shade again. */
  isolate: (content: React.ReactNode) => React.ReactElement;
  /** Wraps the scroll owner: the page presentation, the popover scroll source and near-viewport activity. */
  provide: (scroller: React.ReactNode) => React.ReactElement;
}>;

/**
 * The one owner of what a scrolling page is, whatever draws its scroll (`ItemList`'s ScrollView or
 * `VirtualizedItemList`'s recycler): the page's ground and the screen backdrop behind it, the pane header's
 * scroll-linked shade, the scroll source popovers follow, plugin near-viewport activity, the floating tab bar's
 * clearance and the web modal wheel fix.
 */
export function usePageScroller(input: PageScrollerInput): PageScroller {
  const {
    presentation,
    style,
    scrollRef,
    onScroll,
    onLayout,
    onContentSizeChange,
    onWheel,
  } = input;
  const horizontal = input.horizontal === true;
  const { theme } = useUnistyles();
  const materialRole = useContainingHappierMaterialRole();
  const paintColor = useHappierMaterialColorResolver();
  const isInsideModalBoundary = useIsInsideModalBoundary();
  // When the floating tab bar (and the docked Voice Island above it) overlays this screen, the page's bottom clears it. 0 when no bar is present.
  const bottomChromeHeight = useSessionCockpitPageBottomClearance();
  const contained = useContainedPageScope();
  const isWeb = Platform.OS === 'web';

  const pageColor = theme.colors.surface.base;
  const nativePageColor = useGlassSurfaceColor(
    pageColor,
    'content',
    true,
    false,
    true,
  );
  // A list standing on the navigation plane (a navigation column, a side panel on the canvas) draws no ground.
  const onNavigationPlane = useContainingGlassSurfaceGroup() === 'sidebar';
  const ground = onNavigationPlane
    ? 'transparent'
    : materialRole === undefined
      ? isWeb
        ? glassSurfaceBackgroundColor(pageColor, 'content', true)
        : nativePageColor
      : paintColor(pageColor, 'transparent');
  const authoredBackground = RNStyleSheet.flatten(style)?.backgroundColor;
  const paintedAuthoredBackground =
    typeof authoredBackground === 'string' && materialRole !== undefined
      ? paintColor(authoredBackground, 'transparent')
      : undefined;
  useScreenSafeAreaBackdrop(
    typeof authoredBackground === 'string'
      ? (paintedAuthoredBackground ?? authoredBackground)
      : ground,
  );

  const tracker = React.useMemo(
    () => createScrollViewNearViewportTracker(scrollRef, horizontal),
    [horizontal, scrollRef],
  );
  // A vertical page list that is a pane's primary body drives the pane header's shade; it then ends
  // the scope for anything scrolling inside it, so a nested list never claims the header.
  const paneHeaderScroll = usePaneHeaderScrollSink();
  const reportsPaneHeader = paneHeaderScroll !== null && !horizontal;
  const reportedMountRef = React.useRef(false);

  const installWebModalWheelFix =
    isWeb && isInsideModalBoundary && onWheel == null;
  const wheelScrollHandlers = useScrollViewWheelScrollTo(
    scrollRef as React.RefObject<{
      scrollTo: (options: { y: number; animated?: boolean }) => void;
    } | null>,
    {
      enabled: installWebModalWheelFix,
      onScroll,
      onWheel,
    },
  );

  const handlers: PageScroller['handlers'] = {
    scrollEventThrottle:
      reportsPaneHeader && input.scrollEventThrottle === undefined
        ? 16
        : input.scrollEventThrottle,
    onScroll: (event) => {
      tracker.onScroll(event);
      if (reportsPaneHeader)
        paneHeaderScroll.reportTopDistance(event.nativeEvent.contentOffset.y);
      (installWebModalWheelFix ? wheelScrollHandlers.onScroll : onScroll)?.(
        event,
      );
    },
    onLayout: (event) => {
      tracker.onLayout(event);
      // A body that just mounted starts at its top: the header it replaces under may still show a shade.
      if (reportsPaneHeader && !reportedMountRef.current) {
        reportedMountRef.current = true;
        paneHeaderScroll.reportTopDistance(0);
      }
      onLayout?.(event);
    },
    onContentSizeChange: (width, height) => {
      tracker.onContentSizeChange(width, height);
      onContentSizeChange?.(width, height);
    },
    onWheel: installWebModalWheelFix ? wheelScrollHandlers.onWheel : onWheel,
  };

  const isolate = (content: React.ReactNode) => {
    const isolated = <ScreenBackdropBoundary>{content}</ScreenBackdropBoundary>;
    return reportsPaneHeader ? (
      <PaneHeaderScrollIsolation>{isolated}</PaneHeaderScrollIsolation>
    ) : (
      isolated
    );
  };
  const provide = (scroller: React.ReactNode) => (
    <PopoverScrollSourceProvider scrollSourceRef={scrollRef}>
      <ListPresentationProvider
        value={presentation}
        pageNoticeActive={input.pageNoticeActive === true}
        pageInsets={contained ? 'contained' : undefined}
      >
        <PluginUiScrollActivityProvider tracker={tracker}>
          {scroller}
        </PluginUiScrollActivityProvider>
      </ListPresentationProvider>
    </PopoverScrollSourceProvider>
  );

  return {
    style: [
      { backgroundColor: ground },
      style,
      paintedAuthoredBackground
        ? { backgroundColor: paintedAuthoredBackground }
        : null,
      // Whatever the page scrolls into view (a focused control, an opened review's footer) stops above the floating
      // bar, not under it: the browser's scroll snapping to focus honours this inset.
      isWeb && bottomChromeHeight > 0 ? ({ scrollPaddingBottom: bottomChromeHeight } as ViewStyle) : null,
    ],
    contained,
    bottomChromeHeight,
    handlers,
    isolate,
    provide,
  };
}
