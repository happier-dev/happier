import { Asset } from 'expo-asset';
import { Skia, type SkFont, type SkTypeface } from '@shopify/react-native-skia';

import type { MeasureMarkText } from './markGeometry';

/* eslint-disable @typescript-eslint/no-require-imports -- bundled font asset */
const INTER_SEMIBOLD = require('@/assets/fonts/Inter-SemiBold.ttf');
/* eslint-enable @typescript-eslint/no-require-imports */

let typeface: SkTypeface | null = null;
let loading: Promise<SkTypeface | null> | null = null;

/**
 * Text marks are Inter semibold on every platform (MIS §3.4), and Skia reads it from the bundled file
 * because the OS font manager doesn't know app fonts. The canvas and the flatten both wait on this one load.
 */
export function loadMarkTypeface(): Promise<SkTypeface | null> {
  loading ??= (async () => {
    const asset = Asset.fromModule(INTER_SEMIBOLD);
    if (!asset.localUri) await asset.downloadAsync();
    const data = await Skia.Data.fromURI(asset.localUri ?? asset.uri);
    typeface = Skia.Typeface.MakeFreeTypeFaceFromData(data);
    return typeface;
  })();
  return loading;
}

export function markFont(fontSize: number): SkFont {
  return Skia.Font(typeface ?? undefined, fontSize);
}

export const measureMarkText: MeasureMarkText = (text, fontSize) => {
  const font = markFont(fontSize);
  const width = font.getTextWidth(text);
  font.dispose();
  return width;
};
