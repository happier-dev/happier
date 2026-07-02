import * as React from 'react';
import { Platform, StyleSheet as RNStyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

export type PlanetBackgroundProps = Readonly<{
    /**
     * Where this backdrop is being rendered.
     *  - `desktop` — left brand pane on tablet/desktop split.
     *  - `mobile`  — the shared mobile recipe used on BOTH the brand hero AND
     *    the welcome step. We deliberately use one variant across both mobile
     *    screens so the cosmic identity is continuous: the user sees the same
     *    "rising planet" from the moment they open the app to the moment they
     *    tap into the next flow.
     */
    variant: 'desktop' | 'mobile';
}>;

// Mobile recipe constants — shared by BOTH the web and native code paths so
// the two render identically.
//
//   background-size: 300%   →  the image WIDTH is 3× the container width and
//                              the height is `auto` (preserves the image's
//                              intrinsic aspect ratio). This is the crucial
//                              detail: a single `background-size` value scales
//                              width only; height follows the aspect ratio.
//   background-position: center 20%
//                           →  horizontally centred; the image's 20%-from-top
//                              point pins to the container's 20%-from-top.
//
// On native, expo-image has no direct "background-size/position" equivalent,
// so we measure the container and compute the matching pixel rect by hand
// using these same numbers (see the mobile branch below). Keeping the scale
// and anchor as named constants guarantees web and native stay in lockstep.
const PLANET_MOBILE_SCALE = 3;
const PLANET_MOBILE_VERTICAL_ANCHOR = 0.2;
// Intrinsic aspect ratio of planet-{light,dark}.jpg (6144 × 4096 = 1.5).
// Used on native to derive the auto height the web `background-size: 300%`
// gives us for free.
const PLANET_ASPECT_RATIO = 6144 / 4096;

const PLANET_MOBILE_BG_SIZE = `${PLANET_MOBILE_SCALE * 100}%`;
const PLANET_MOBILE_BG_POSITION = `center ${PLANET_MOBILE_VERTICAL_ANCHOR * 100}%`;

/**
 * The cosmic backdrop behind the unauth shell. Theme-aware: dark planet for
 * dark mode, warm planet for light mode. Reused from the website hero
 * imagery (`apps/website/public/images/background5_*`) and bundled into the
 * app's assets in P1.
 *
 * Two variants:
 *  - **desktop** — full-bleed cover behind the left brand pane on tablet
 *    and desktop. Anchored to 80% horizontal / 50% vertical so the planet
 *    sphere lands roughly at the centre of the pane.
 *  - **mobile** — shared between the mobile brand hero and the mobile
 *    welcome step. The image width is scaled to 300% of the container with
 *    aspect-preserving height, anchored at `center 20%`. Both screens look
 *    continuous because they use the exact same recipe.
 *
 * Platform fork:
 *  - **Web:** a `<View>` with CSS `background-image` + `background-size`
 *    + `background-position`. RN-web passes these straight through to the
 *    rendered `<div>`.
 *  - **Native (iOS/Android):** the mobile variant measures its container
 *    and renders an absolutely-positioned `expo-image` at the exact pixel
 *    rect that reproduces the web `background-size: 300%` (width-scaled,
 *    aspect-preserving height) + `background-position: center 20%`. We do
 *    NOT use `contentFit: cover` against a 300%×300% box — that ignores the
 *    image aspect ratio and zooms the planet sphere out of frame.
 */
export const PlanetBackground = React.memo(function PlanetBackground(props: PlanetBackgroundProps) {
    const { theme } = useUnistyles();

    const source = theme.dark
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        ? require('@/assets/onboarding/planet-dark.jpg')
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        : require('@/assets/onboarding/planet-light.jpg');

    if (Platform.OS === 'web') {
        const url = resolveAssetUri(source);
        const isMobile = props.variant === 'mobile';
        const backgroundSize = isMobile ? PLANET_MOBILE_BG_SIZE : 'cover';
        const backgroundPosition = isMobile ? PLANET_MOBILE_BG_POSITION : '80% 50%';
        // RN-web passes the `backgroundImage` / `backgroundSize` /
        // `backgroundPosition` style properties straight through to the
        // rendered `<div>`. We cast because these aren't part of React
        // Native's `ViewStyle` type, but they're valid web CSS and RN-web
        // supports them.
        const webStyle = {
            ...RNStyleSheet.absoluteFillObject,
            backgroundImage: `url(${url})`,
            backgroundSize,
            backgroundPosition,
            backgroundRepeat: 'no-repeat',
        } as unknown as React.ComponentProps<typeof View>['style'];
        return (
            <View
                testID={`planet-background-${props.variant}`}
                accessible={false}
                pointerEvents="none"
                style={webStyle}
            />
        );
    }

    // Native (iOS / Android) desktop variant — kept for completeness; in
    // practice the desktop variant only renders on web (Tauri/browser).
    if (props.variant === 'desktop') {
        return (
            <ExpoImage
                testID="planet-background-desktop"
                accessible={false}
                source={source}
                contentFit="cover"
                contentPosition={PLANET_DESKTOP_POSITION}
                style={RNStyleSheet.absoluteFillObject}
                pointerEvents="none"
            />
        );
    }

    return <PlanetBackgroundMobileNative source={source} />;
});

/**
 * Native mobile backdrop. Measures the container and renders the planet at
 * the exact pixel rect that reproduces the web recipe:
 *   width  = container width × PLANET_MOBILE_SCALE
 *   height = width / PLANET_ASPECT_RATIO          (web `auto` height)
 *   left   = (container width − width) / 2        (`center`)
 *   top    = anchor × (container height − height) (`center 20%`)
 * `contentFit="fill"` is safe because the computed box already matches the
 * source aspect ratio exactly, so there is no distortion or cropping.
 */
const PlanetBackgroundMobileNative = React.memo(function PlanetBackgroundMobileNative(
    props: Readonly<{ source: unknown }>,
) {
    const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((prev) =>
            prev && prev.width === width && prev.height === height ? prev : { width, height },
        );
    }, []);

    let imageStyle: React.ComponentProps<typeof ExpoImage>['style'] = null;
    if (size) {
        const imageWidth = size.width * PLANET_MOBILE_SCALE;
        const imageHeight = imageWidth / PLANET_ASPECT_RATIO;
        imageStyle = {
            position: 'absolute',
            width: imageWidth,
            height: imageHeight,
            left: (size.width - imageWidth) / 2,
            top: PLANET_MOBILE_VERTICAL_ANCHOR * (size.height - imageHeight),
        };
    }

    return (
        <View
            testID="planet-background-mobile-frame"
            accessible={false}
            pointerEvents="none"
            onLayout={onLayout}
            style={RNStyleSheet.absoluteFillObject}
        >
            {imageStyle ? (
                <ExpoImage
                    testID="planet-background-mobile"
                    accessible={false}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    source={props.source as any}
                    contentFit="fill"
                    style={imageStyle}
                    pointerEvents="none"
                />
            ) : null}
        </View>
    );
});

/**
 * Resolves a Metro-bundled asset (`require('./foo.jpg')`) to its URI string,
 * defensively. The shape varies across runtimes:
 *  - RN-web (Metro): often returns `{ uri, width, height }` directly.
 *  - ESM interop: sometimes returns `{ default: { uri, ... } }`.
 *  - Already a string: just pass through.
 *
 * We deliberately do NOT use `Image.resolveAssetSource(...)` — it isn't
 * exposed on the RN-web `Image` export in some versions and crashes with
 * "is not a function" at runtime.
 */
function resolveAssetUri(source: unknown): string {
    if (!source) return '';
    if (typeof source === 'string') return source;
    if (typeof source === 'object') {
        const obj = source as Record<string, unknown>;
        if (typeof obj.uri === 'string') return obj.uri;
        if ('default' in obj) return resolveAssetUri(obj.default);
    }
    return '';
}

const PLANET_DESKTOP_POSITION = { left: '80%' as const, top: '50%' as const };
