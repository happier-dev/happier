import * as React from 'react';
import {
  AlphaType,
  Canvas,
  ColorType,
  Image,
  FilterMode,
  MipmapMode,
  Skia,
} from '@shopify/react-native-skia';

const PIXEL_SAMPLING = { filter: FilterMode.Nearest, mipmap: MipmapMode.None } as const;
const SMOOTH_SAMPLING = { filter: FilterMode.Linear, mipmap: MipmapMode.None } as const;
import type { BotFaceRasterImage } from './botFaceRaster';

/** Paints a raster face (device pixels) through Skia at its logical size. */
export function BotFaceRasterView(
  props: Readonly<{ image: BotFaceRasterImage; size: number; testID?: string }>,
) {
  const { image } = props;
  const skImage = React.useMemo(
    () =>
      Skia.Image.MakeImage(
        {
          width: image.width,
          height: image.height,
          colorType: ColorType.RGBA_8888,
          alphaType: AlphaType.Unpremul,
        },
        Skia.Data.fromBytes(
          new Uint8Array(
            image.data.buffer,
            image.data.byteOffset,
            image.data.byteLength,
          ),
        ),
        image.width * 4,
      ),
    [image],
  );
  React.useEffect(
    () => () => {
      skImage?.dispose();
    },
    [skImage],
  );
  return (
    <Canvas
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={props.testID}
      style={{ width: props.size, height: props.size }}
    >
      {skImage ? (
        <Image
          image={skImage}
          x={0}
          y={0}
          width={props.size}
          height={props.size}
          fit="fill"
          sampling={image.smooth ? SMOOTH_SAMPLING : PIXEL_SAMPLING}
        />
      ) : null}
    </Canvas>
  );
}
