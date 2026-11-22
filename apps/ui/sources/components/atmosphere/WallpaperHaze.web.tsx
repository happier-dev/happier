import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { BackdropCanvas } from './BackdropCanvas';
import type { BackdropCanvasProps } from './backdropCanvas.types';
import { pictureBackdropProps } from './pictureBackdrop';
import type { WallpaperHaze as WallpaperHazeComposition } from './wallpaperHaze';

/**
 * A layered haze under the content (lab `paintHaze`): two soft copies of the scene, centred on the
 * content column. They are low-resolution renders of the same picture, blurred once as images, never a
 * live backdrop filter; the radii are the glass owner's.
 */
export function WallpaperHaze(
  props: Readonly<{
    source: NonNullable<React.ComponentProps<typeof BackdropCanvas>['source']>;
    size: { width: number; height: number };
    job: ReturnType<typeof pictureBackdropProps> & Pick<BackdropCanvasProps, 'resettle'>;
    focus: { x: number; y: number };
    /** Its layers and veil (`resolveWallpaperHaze`). */
    haze: WallpaperHazeComposition;
    /** The haze's render: head lines stand on it, so the atmosphere measures its tone too. */
    onRendered?: React.ComponentProps<typeof BackdropCanvas>['onRendered'];
  }>,
) {
  // Both blur layers project identical pixels; their CSS masks/blur remain independent.
  const renderGroup = React.useMemo(() => ({}), []);
  const quarter = {
    width: Math.max(2, Math.round(props.size.width / 4)),
    height: Math.max(2, Math.round(props.size.height / 4)),
  };
  const at = `${((props.focus.x / props.size.width) * 100).toFixed(1)}% ${((props.focus.y / props.size.height) * 100).toFixed(1)}%`;
  const maskOf = (ellipse: string, solid: string, centre = at) => `radial-gradient(ellipse ${ellipse} at ${centre}, #000 ${solid}, transparent 100%)`;
  const layer = (blur: number, ellipse: string, solid: string, measureTone: boolean) => {
    const mask = maskOf(ellipse, solid);
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          // The quarter-size render is scaled up by 4 from a rounded size, so it can end a few px past an
          // edge that is not a multiple of 4 (a 390px phone paints 392px): clip it to the layer, or the
          // page scrolls sideways.
          { overflow: 'hidden', maskImage: mask, WebkitMaskImage: mask } as object,
        ]}
      >
        <View
          style={
            {
              width: quarter.width,
              height: quarter.height,
              transformOrigin: 'top left',
              transform: [{ scale: 4 }],
              filter: `blur(${blur / 4}px)`,
            } as object
          }
        >
          <BackdropCanvas
            source={props.source}
            size={quarter}
            dpr={1}
            {...props.job}
            renderGroup={renderGroup}
            onRendered={measureTone ? props.onRendered : undefined}
          />
        </View>
      </View>
    );
  };
  const { layers, veil } = props.haze;
  const veilMask = veil ? maskOf(`${veil.rx * 100}% ${veil.ry * 100}%`, `${veil.solid * 100}%`, `${(veil.at.x * 100).toFixed(1)}% ${(veil.at.y * 100).toFixed(1)}%`) : null;
  return (
    <>
      {layers.map((spec, index) => <React.Fragment key={spec.blur}>{layer(spec.blur, `${spec.rx * 100}% ${spec.ry * 100}%`, `${spec.solid * 100}%`, index === 0)}</React.Fragment>)}
      {veil && veilMask ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: veil.color, opacity: veil.alpha, maskImage: veilMask, WebkitMaskImage: veilMask } as object]} />
      ) : null}
    </>
  );
}
