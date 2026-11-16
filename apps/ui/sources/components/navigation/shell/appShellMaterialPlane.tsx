import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassSurface, useContainingGlassSurfaceGroup, type GlassSurfaceProps } from '@/components/ui/glass/GlassSurface';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';
import { useAtmospherePictureShown } from '@/components/atmosphere/atmosphereStage';

/**
 * The shell's sheet geometry: every sheet on the canvas (the page, and with the `canvas` placement the
 * right panel) has these rounded corners and stands this far from the window edge and from its
 * neighbouring sheet.
 */
export const APP_SHELL_SHEET_RADIUS_PX = 12;
export const APP_SHELL_SHEET_INSET_PX = 8;

/** Structural coats share the surface owner; Wallpaper filters paint beside their content. */
export function AppShellMaterialPlane(
  props: Readonly<{
    group: GlassSurfaceGroup;
    color: string;
    translucentColor: string;
    style: StyleProp<ViewStyle>;
    testID?: string;
    themeSurface?: GlassSurfaceProps['themeSurface'];
    pointerEvents?: 'none';
    nested?: boolean;
    children?: React.ReactNode;
  }>,
) {
  const containingGroup = useContainingGlassSurfaceGroup();
  const pictureShown = useAtmospherePictureShown();
  // Every main area shares Sessions' existing reading material. Inner page planes inherit it,
  // including a Settings shell, so the reading coat is never stacked or recalibrated by a page.
  const inheritsContent = props.group === 'content' && containingGroup === 'content';
  const atmosphereCoat = props.group === 'content' && pictureShown ? 'reading' : undefined;
  if (props.pointerEvents === 'none')
    return (
      <View
        testID={props.testID}
        pointerEvents="none"
        style={[props.style, { backgroundColor: 'transparent' }]}
      >
        <GlassSurface
          plane
          themeSurface={props.themeSurface}
          noCoat={inheritsContent}
          atmosphereCoat={atmosphereCoat}
          surfaceGroup={props.group}
          solidColor={props.color}
          translucentColor={props.translucentColor}
          finishRole={null}
          nested={props.nested}
          style={StyleSheet.absoluteFillObject}
        >
          {props.children}
        </GlassSurface>
      </View>
    );
  return (
    <GlassSurface
      plane
      themeSurface={props.themeSurface}
      noCoat={inheritsContent}
      atmosphereCoat={atmosphereCoat}
      testID={props.testID}
      surfaceGroup={props.group}
      solidColor={props.color}
      translucentColor={props.translucentColor}
      finishRole={null}
      nested={props.nested}
      style={props.style}
    >
      {props.children}
    </GlassSurface>
  );
}

export type AppShellPlaneCoat = Readonly<{
  group: GlassSurfaceGroup;
  color: string;
  translucentColor: string;
}>;

/**
 * The window's canvas: the coat the app rail, the title strip and the strip beneath the page stand on.
 * Everything else on the canvas (the right action rail, the gap and inset around a separate right panel,
 * the window's trailing inset and the cutouts outside the page's trailing corners) takes this same coat,
 * so nothing on the canvas reads as a band of its own (R11-1). Only the navigation column has its plane.
 */
export function useAppShellCanvasCoat(): AppShellPlaneCoat {
  const { theme } = useUnistyles();
  return React.useMemo(
    () => ({ group: 'chrome', color: theme.colors.background.canvas, translucentColor: theme.colors.surface.selected }),
    [theme.colors],
  );
}

const CORNERS = [
  { id: 'tl', vertical: 'top', horizontal: 'left', at: '100% 100%' },
  { id: 'tr', vertical: 'top', horizontal: 'right', at: '0% 100%' },
  { id: 'bl', vertical: 'bottom', horizontal: 'left', at: '100% 0%' },
  { id: 'br', vertical: 'bottom', horizontal: 'right', at: '0% 0%' },
] as const;

/**
 * The canvas outside a sheet's rounded corners. A clipped sheet leaves those pixels to whatever is
 * behind the shell (the document on the web, the bare window material in the desktop app), so each
 * corner gets the coat of the plane beside it, masked to the outside of the curve: the canvas is
 * painted once there and never behind the sheet's own (possibly translucent) coat. Web only, like the
 * sheet's seam; the rect is the sheet's, inset from the positioned parent's edges.
 */
export const AppShellSheetCorners = React.memo(function AppShellSheetCorners(
  props: Readonly<{
    leading: AppShellPlaneCoat;
    trailing: AppShellPlaneCoat;
    inset?: Readonly<{
      left?: number;
      right?: number;
      top?: number;
      bottom?: number;
    }>;
    testIDPrefix: string;
    /** Corners the sheet does not round (one joined to a neighbouring shape): nothing to coat there. */
    omit?: readonly ('tl' | 'tr' | 'bl' | 'br')[];
  }>,
) {
  if (Platform.OS !== 'web') return null;
  const radius = APP_SHELL_SHEET_RADIUS_PX;
  return (
    <>
      {CORNERS.filter((corner) => !props.omit?.includes(corner.id)).map((corner) => {
        const coat =
          corner.horizontal === 'left' ? props.leading : props.trailing;
        const mask = `radial-gradient(circle at ${corner.at}, transparent ${radius - 0.5}px, #000 ${radius + 0.5}px)`;
        return (
          <AppShellMaterialPlane
            key={corner.id}
            testID={`${props.testIDPrefix}-${corner.id}`}
            pointerEvents="none"
            group={coat.group}
            color={coat.color}
            translucentColor={coat.translucentColor}
            style={
              {
                position: 'absolute',
                width: radius,
                height: radius,
                [corner.vertical]: props.inset?.[corner.vertical] ?? 0,
                [corner.horizontal]: props.inset?.[corner.horizontal] ?? 0,
                maskImage: mask,
                WebkitMaskImage: mask,
              } as ViewStyle
            }
          />
        );
      })}
    </>
  );
});
