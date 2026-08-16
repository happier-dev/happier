import * as React from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import {
  FloatingOverlay,
  type FloatingOverlayArrow,
  type FloatingOverlayEdgeFades,
} from "@/components/ui/overlays/FloatingOverlay";
import type { ScrollEdgeVisibility } from "@/components/ui/scroll/useScrollEdgeFades";

export type AgentInputPopoverSurfaceProps = Readonly<{
  children: React.ReactNode;
  maxHeight: number;
  testID?: string;
  /**
   * When true (default), the popover provides its own scroll container + edge fades.
   * When false, the popover only provides the surface/frame (useful if the child already
   * contains its own scrollable list).
   */
  scrollEnabled?: boolean;
  showScrollIndicator?: boolean;
  keyboardShouldPersistTaps?: boolean | "always" | "never" | "handled";
  edgeFades?: FloatingOverlayEdgeFades;
  edgeIndicators?: boolean | Readonly<{ size?: number; opacity?: number }>;
  arrow?: FloatingOverlayArrow;
  initialVisibility?: Partial<ScrollEdgeVisibility>;
  /**
   * Told that this surface's scroller moved, for content that must not re-lay-out mid-scroll.
   *
   * The surface owns the scroller its content does not, so a list inside it cannot know it is
   * being scrolled without being told.
   */
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}>;

export const AgentInputPopoverSurface = React.memo(
  (props: AgentInputPopoverSurfaceProps) => {
    const {
      children,
      maxHeight,
      testID,
      scrollEnabled = true,
      showScrollIndicator = false,
      keyboardShouldPersistTaps = "handled",
      edgeFades = { top: true, bottom: true, size: 28 },
      edgeIndicators = true,
      arrow = false,
      initialVisibility,
      onScroll,
    } = props;

    return (
      <View testID={testID} collapsable={false}>
        <FloatingOverlay
          maxHeight={maxHeight}
          scrollEnabled={scrollEnabled}
          showScrollIndicator={showScrollIndicator}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
          edgeFades={edgeFades}
          edgeIndicators={edgeIndicators}
          arrow={arrow}
          surfaceChrome="theme"
          initialVisibility={initialVisibility}
          onScrollViewScroll={onScroll}
        >
          {children}
        </FloatingOverlay>
      </View>
    );
  },
);
