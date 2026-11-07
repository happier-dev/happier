import * as React from 'react';
import { Image as ReactNativeImage, Platform, type ImageURISource, type ImageProps as ReactNativeImageProps } from 'react-native';
import { Image as ExpoImageImport } from 'expo-image';

import { isRenderableElementType } from '@/components/ui/icons/isRenderableElementType';

export type SafeExpoImageContentFit = 'contain' | 'cover' | 'fill' | 'none' | 'scale-down';

type SafeExpoImageUriSource = Readonly<ImageURISource & {
    thumbhash?: string;
}>;

export type SafeExpoImageProps = Readonly<
    Omit<ReactNativeImageProps, 'resizeMode' | 'source'> & {
        source?: ReactNativeImageProps['source'] | SafeExpoImageUriSource | SafeExpoImageUriSource[];
        contentFit?: SafeExpoImageContentFit;
        resizeMode?: ReactNativeImageProps['resizeMode'];
        placeholder?: Readonly<{ thumbhash: string }> | null;
        tintColor?: string;
        allowDownscaling?: boolean;
        alt?: string;
    }
>;

function resolveResizeMode(
    contentFit: SafeExpoImageProps['contentFit'],
    resizeMode: SafeExpoImageProps['resizeMode'],
): ReactNativeImageProps['resizeMode'] {
    if (resizeMode) {
        return resizeMode;
    }

    switch (contentFit) {
        case 'contain':
            return 'contain';
        case 'fill':
            return 'stretch';
        case 'none':
            return 'center';
        case 'scale-down':
            return 'contain';
        case 'cover':
        default:
            return 'cover';
    }
}

function stripThumbhashFromUriSource(source: SafeExpoImageUriSource): ImageURISource {
    const { thumbhash: _thumbhash, ...reactNativeSource } = source;
    return reactNativeSource;
}

function isSafeExpoImageUriSource(source: SafeExpoImageProps['source']): source is SafeExpoImageUriSource {
    return Boolean(source)
        && !Array.isArray(source)
        && typeof source === 'object'
        && 'uri' in source
        && typeof source.uri === 'string';
}

function normalizeReactNativeSource(source: SafeExpoImageProps['source']): ReactNativeImageProps['source'] {
    if (Array.isArray(source)) {
        return source.map(stripThumbhashFromUriSource);
    }

    if (isSafeExpoImageUriSource(source)) {
        return stripThumbhashFromUriSource(source);
    }

    return source;
}

/**
 * expo-image flattens its `style` with React Native's `StyleSheet.flatten`, which keeps enumerable own
 * properties. On web a Unistyles `StyleSheet.create` entry holds its values as NON-enumerable properties
 * (only a hidden `unistyles_<id>` marker is enumerable; Unistyles turns it into a class name for the
 * views it wraps, and expo-image is not one of them), so the flatten dropped every value and the
 * picture fell back to its intrinsic size (live: 56x36 leading-media thumbnails measured 54x0).
 * Reading the own property names resolves the entry (and arrays of entries and inline styles, in
 * order) into the plain style expo-image applies.
 */
function resolveWebImageStyle(style: unknown): unknown {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(resolveWebImageStyle));
    }
    if (!style || typeof style !== 'object') {
        return style;
    }
    const resolved: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(style)) {
        if (!key.startsWith('unistyles_')) {
            resolved[key] = (style as Record<string, unknown>)[key];
        }
    }
    return resolved;
}

export const SafeExpoImage = React.memo(function SafeExpoImage(props: SafeExpoImageProps) {
    const imageLabel = props.alt ?? props.accessibilityLabel ?? '';
    const imageProps = { ...props, alt: imageLabel, accessibilityLabel: imageLabel };
    if (isRenderableElementType(ExpoImageImport)) {
        return React.createElement(
            ExpoImageImport as React.ElementType<SafeExpoImageProps>,
            Platform.OS === 'web' && props.style ? { ...imageProps, style: resolveWebImageStyle(props.style) as SafeExpoImageProps['style'] } : imageProps,
        );
    }

    const {
        source,
        contentFit,
        resizeMode,
        placeholder: _placeholder,
        tintColor,
        allowDownscaling: _allowDownscaling,
        style,
        ...reactNativeImageProps
    } = imageProps;

    return (
        <ReactNativeImage
            {...reactNativeImageProps}
            source={normalizeReactNativeSource(source)}
            style={tintColor ? [style, { tintColor }] : style}
            resizeMode={resolveResizeMode(contentFit, resizeMode)}
        />
    );
});
