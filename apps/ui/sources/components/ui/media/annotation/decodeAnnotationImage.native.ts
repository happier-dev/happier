import { Skia, type SkData, type SkImage } from '@shopify/react-native-skia';

import { decodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';

import type { ImageAnnotationSource } from './types';

/** Android's Skia URL stream has no data: handler; feed its bytes directly to Skia. */
export function annotationImageDataSource(uri: string): string | Uint8Array | null {
  if (!uri.startsWith('data:')) return uri;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  try {
    const payload = decodeURIComponent(uri.slice(comma + 1));
    return uri.slice(0, comma).split(';').includes('base64') ? decodeBase64(payload) : encodeUTF8(payload);
  } catch {
    return null;
  }
}

/** MediaStage admits raster and SVG pictures; preview and flatten share the same raster. */
export function decodeAnnotationImage(data: SkData, source: Pick<ImageAnnotationSource, 'width' | 'height'>): SkImage | null {
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (image) return image;
  const svg = Skia.SVG.MakeFromData(data, Skia.FontMgr.System());
  if (!svg) return null;
  const surface = Skia.Surface.Make(source.width, source.height);
  if (!surface) return null;
  surface.getCanvas().drawSvg(svg, source.width, source.height);
  surface.flush();
  return surface.makeImageSnapshot();
}
