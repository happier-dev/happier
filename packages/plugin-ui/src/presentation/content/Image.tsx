import type { ReactElement } from 'react';
import { Image as ReactNativeImage, View } from 'react-native';

import type {
  HappierUiPlatformFacts,
  HappierUiTheme,
} from '../../environment/types.js';
import { HappierText } from '../text/Text.js';

export type HappierImageSize = 'small' | 'medium' | 'large';

const IMAGE_SIZE: Readonly<Record<HappierImageSize, number>> = Object.freeze({
  small: 32,
  medium: 48,
  large: 72,
});

function isBrandFallbackGraphemeExtension(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function resolveBrandFallbackGrapheme(value: string): string {
  const codePoints = Array.from(value);
  const first = codePoints[0];
  if (!first) return '?';

  let end = 1;
  const firstCodePoint = first.codePointAt(0)!;
  if (isRegionalIndicator(firstCodePoint) && isRegionalIndicator(codePoints[1]?.codePointAt(0) ?? 0)) {
    end = 2;
  }

  while (end < codePoints.length) {
    const codePoint = codePoints[end]!.codePointAt(0)!;
    if (isBrandFallbackGraphemeExtension(codePoint)) {
      end += 1;
      continue;
    }
    if (codePoint === 0x200d && codePoints[end + 1]) {
      end += 2;
      continue;
    }
    break;
  }

  return codePoints.slice(0, end).join('');
}

/** One size projection shared by the package Resource adapter and core chrome. */
export function resolveHappierImagePixels(size: HappierImageSize | undefined): number {
  return IMAGE_SIZE[size ?? 'medium'];
}

/** One neutral textual fallback; manifest projection remains the brand owner. */
export function resolveHappierBrandFallback(displayName: string): string {
  const value = displayName.trim();
  const Segmenter = typeof Intl === 'undefined' ? undefined : Intl.Segmenter;
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter('und', { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(value)) {
      return segment.toLocaleUpperCase();
    }
  }
  return resolveBrandFallbackGrapheme(value).toLocaleUpperCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(chunk >>> 18) & 63];
    output += alphabet[(chunk >>> 12) & 63];
    output += second === undefined ? '=' : alphabet[(chunk >>> 6) & 63];
    output += third === undefined ? '=' : alphabet[chunk & 63];
  }
  return output;
}

/**
 * One derived platform image source per admitted byte identity.
 *
 * `data:` encoding is pure, so it belongs to the bytes, not to a render. The
 * Resource store already collapses digest-equal reads onto one retained
 * `ResourceContent`, which makes the byte array itself the admitted identity;
 * keying the derivation on it weakly means an encoded source lives exactly as
 * long as the bytes some mounted surface still holds. That is a derivation
 * memo, not an image cache: it has no lifecycle, no eviction policy, no
 * capacity, and no ability to answer for bytes nobody is holding.
 *
 * The whole `source` object is retained rather than the URI string, because a
 * fresh `{ uri }` on every render re-enters the native image host's source
 * diff and defeats memoization on `react-native-web`.
 */
const IMAGE_SOURCE_BY_ADMITTED_BYTES = new WeakMap<Uint8Array, Readonly<{ uri: string }>>();

function resolveHappierImageSource(bytes: Uint8Array): Readonly<{ uri: string }> {
  const derived = IMAGE_SOURCE_BY_ADMITTED_BYTES.get(bytes);
  if (derived) return derived;
  const source = Object.freeze({ uri: `data:image/png;base64,${bytesToBase64(bytes)}` });
  IMAGE_SOURCE_BY_ADMITTED_BYTES.set(bytes, source);
  return source;
}

/**
 * A brand mark is an explicit presentation variant of a bounded image. It
 * keeps opaque marks unchanged while giving transparent marks a semantic,
 * opaque backing; generic images intentionally remain bare.
 */
type HappierBrandMarkBacking = Readonly<{
  backgroundColor: string;
  foregroundColor: string;
}>;

function resolveHappierBrandMarkBacking(
  theme: HappierUiTheme,
  colorScheme: HappierUiPlatformFacts['colorScheme'],
): HappierBrandMarkBacking {
  const isDark = colorScheme === 'dark';
  return {
    // `text` and `surface` are a canonical contrast pair. On dark hosts the
    // light foreground becomes the backing for transparent black marks; on
    // light hosts the ordinary surface already supplies that backing.
    backgroundColor: isDark ? theme.colors.text : theme.colors.surface,
    foregroundColor: isDark ? theme.colors.surface : theme.colors.text,
  };
}

/** One bounded PNG/fallback renderer; byte acquisition stays with its adapter. */
export function HappierImage(props: Readonly<{
  bytes?: Uint8Array;
  size?: HappierImageSize;
  accessibilityLabel?: string;
  fallback: string;
  theme: HappierUiTheme;
  testID?: string;
  /** Internal explicit presentation supplied only by the brand-mark composition. */
  backing?: HappierBrandMarkBacking;
  /** Internal: an adjacent canonical label makes this fallback initial decorative. */
  fallbackAccessibilityHidden?: boolean;
}>): ReactElement {
  const pixels = resolveHappierImagePixels(props.size);
  const backingStyle = props.backing
    ? {
      backgroundColor: props.backing.backgroundColor,
      borderRadius: props.theme.radii.control,
    }
    : undefined;
  if (props.bytes && props.bytes.byteLength > 0) {
    return (
      <ReactNativeImage
        source={resolveHappierImageSource(props.bytes)}
        accessibilityLabel={props.accessibilityLabel}
        accessible={Boolean(props.accessibilityLabel)}
        testID={props.testID}
        resizeMode="contain"
        style={{ width: pixels, height: pixels, ...backingStyle }}
      />
    );
  }
  const hideFallbackFromAccessibility = props.fallbackAccessibilityHidden === true
    && props.accessibilityLabel === undefined;
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      accessible={hideFallbackFromAccessibility ? false : Boolean(props.accessibilityLabel)}
      accessibilityElementsHidden={hideFallbackFromAccessibility || undefined}
      importantForAccessibility={hideFallbackFromAccessibility ? 'no-hide-descendants' : undefined}
      aria-hidden={hideFallbackFromAccessibility || undefined}
      testID={props.testID}
      style={{
        width: pixels,
        height: pixels,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: props.theme.radii.control,
        ...(backingStyle ?? { backgroundColor: props.theme.colors.control }),
      }}
    >
      <HappierText {...(props.backing
        ? { style: { color: props.backing.foregroundColor } }
        : { tone: 'secondary' })}
      >
        {props.fallback.slice(0, 2)}
      </HappierText>
    </View>
  );
}

/** Canonical display-name accessibility for an optional packaged brand mark. */
export type HappierBrandMarkProps = Readonly<{
  displayName: string;
  bytes?: Uint8Array;
  size?: HappierImageSize;
  showName?: boolean;
  theme: HappierUiTheme;
  colorScheme: HappierUiPlatformFacts['colorScheme'];
  testID?: string;
  /** An adjacent host-owned label already names the brand; keep the mark decorative. */
  externallyLabelled?: boolean;
}>;

export function HappierBrandMark(props: HappierBrandMarkProps): ReactElement {
  const showName = props.showName === true;
  const fallback = resolveHappierBrandFallback(props.displayName);
  const backing = resolveHappierBrandMarkBacking(props.theme, props.colorScheme);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} testID={props.testID}>
      <HappierImage
        bytes={props.bytes}
        size={props.size}
        fallback={fallback}
        theme={props.theme}
        backing={backing}
        accessibilityLabel={showName || props.externallyLabelled ? undefined : props.displayName}
        fallbackAccessibilityHidden={showName || props.externallyLabelled}
      />
      {showName ? <HappierText>{props.displayName}</HappierText> : null}
    </View>
  );
}
