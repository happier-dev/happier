import * as React from "react";
import { Platform, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
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
}>;

const stylesheet = StyleSheet.create((theme) => ({
  frame: {
    overflow: "hidden",
    elevation: 5,
  },
}));

const NonScrollableOverlayFrame = React.memo(
  (props: Readonly<{ maxHeight: number; children: React.ReactNode }>) => {
    const styles = stylesheet;
    return (
      <View style={[styles.frame, { maxHeight: props.maxHeight }]}>
        {props.children}
      </View>
    );
  },
);

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
    } = props;

    if (scrollEnabled) {
      return (
        <View testID={testID} collapsable={false}>
          <FloatingOverlay
            maxHeight={maxHeight}
            showScrollIndicator={showScrollIndicator}
            keyboardShouldPersistTaps={keyboardShouldPersistTaps}
            edgeFades={edgeFades}
            edgeIndicators={edgeIndicators}
            arrow={arrow}
            initialVisibility={initialVisibility}
          >
            {children}
          </FloatingOverlay>
        </View>
      );
    }

    return (
      <View testID={testID} collapsable={false}>
        <NonScrollableOverlayFrame maxHeight={maxHeight}>
          {children}
        </NonScrollableOverlayFrame>
      </View>
    );
  },
);
