import * as React from 'react';
import type { BotFaceRasterImage } from './botFaceRaster';

/** Paints a raster face (device pixels) into one canvas at its logical size. */
export function BotFaceRasterView(
  props: Readonly<{ image: BotFaceRasterImage; size: number; testID?: string }>,
) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const { image } = props;
  React.useLayoutEffect(() => {
    const context = ref.current?.getContext('2d');
    if (!context) return;
    context.putImageData(
      new ImageData(image.data, image.width, image.height),
      0,
      0,
    );
  }, [image]);
  return React.createElement('canvas', {
    ref,
    width: image.width,
    height: image.height,
    'data-testid': props.testID,
    'aria-hidden': true,
    style: {
      width: props.size,
      height: props.size,
      display: 'block',
      pointerEvents: 'none',
      imageRendering: image.smooth ? 'auto' : 'pixelated',
    },
  });
}
