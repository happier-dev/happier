import * as React from 'react';
import { Image as ReactNativeImage, type ImageURISource, type ImageProps as ReactNativeImageProps } from 'react-native';
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

export const SafeExpoImage = React.memo(function SafeExpoImage(props: SafeExpoImageProps) {
    if (isRenderableElementType(ExpoImageImport)) {
        return React.createElement(
            ExpoImageImport as React.ElementType<SafeExpoImageProps>,
            props,
        );
    }

    const {
        source,
        contentFit,
        resizeMode,
        placeholder: _placeholder,
        tintColor,
        style,
        ...reactNativeImageProps
    } = props;

    return (
        <ReactNativeImage
            {...reactNativeImageProps}
            source={normalizeReactNativeSource(source)}
            style={tintColor ? [style, { tintColor }] : style}
            resizeMode={resolveResizeMode(contentFit, resizeMode)}
        />
    );
});
