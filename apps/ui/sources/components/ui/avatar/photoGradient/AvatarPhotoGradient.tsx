import * as React from 'react';
import { View, type ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

import { AvatarGradient } from '../AvatarGradient';
import { AvatarMeshGradient } from '../meshGradient/AvatarMeshGradient';
import type { MeshGradientThemeInput } from '../meshGradient/meshGradientTypes';
import {
    generateAndCachePhotoGradientAvatarDataUri,
    getCachedPhotoGradientAvatarDataUri,
} from './photoGradientAvatarDataUri';
import { getPhotoGradientFallbackStyleId } from './photoGradientStyleRegistry';

type AvatarPhotoGradientProps = Readonly<{
    id: string;
    styleId?: AvatarStyleId;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}>;

type FallbackBoundaryProps = AvatarPhotoGradientProps & Readonly<{
    fallbackStyleId: AvatarStyleId;
}>;

export class PhotoGradientFallbackBoundary extends React.Component<
    React.PropsWithChildren<FallbackBoundaryProps>,
    { failed: boolean }
> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(): void {
        // React error boundaries require this method in some renderers to commit the fallback path.
    }

    render(): React.ReactNode {
        if (this.state.failed) {
            return <AvatarGradient {...this.props} />;
        }
        return this.props.children;
    }
}

export const AvatarPhotoGradient = React.memo((props: AvatarPhotoGradientProps) => {
    const { id, size = 48, square, monochrome = false, styleId } = props;
    const { theme } = useUnistyles();
    const fallbackStyleId = getPhotoGradientFallbackStyleId(styleId);
    const themeInput: MeshGradientThemeInput = React.useMemo(() => ({
        surface: theme.colors.surface,
        surfaceHigh: theme.colors.surfaceHigh,
        surfaceHighest: theme.colors.surfaceHighest,
        textSecondary: theme.colors.textSecondary,
        accentColors: [
            theme.colors.accent.blue,
            theme.colors.accent.green,
            theme.colors.accent.orange,
            theme.colors.accent.yellow,
            theme.colors.accent.red,
            theme.colors.accent.indigo,
            theme.colors.accent.purple,
        ],
    }), [theme]);
    const cacheParams = React.useMemo(() => ({
        id,
        styleId,
        monochrome,
        theme: themeInput,
    }), [id, monochrome, styleId, themeInput]);
    const [dataUri, setDataUri] = React.useState(() => getCachedPhotoGradientAvatarDataUri(cacheParams));
    const [imageFailed, setImageFailed] = React.useState(false);
    const imageStyle = React.useMemo((): ImageStyle => ({
        width: size,
        height: size,
        borderRadius: square ? 0 : size / 2,
    }), [size, square]);

    React.useEffect(() => {
        let cancelled = false;
        setImageFailed(false);
        const cached = getCachedPhotoGradientAvatarDataUri(cacheParams);
        if (cached) {
            setDataUri(cached);
            return undefined;
        }
        setDataUri(null);
        void generateAndCachePhotoGradientAvatarDataUri(cacheParams).then((generated) => {
            if (!cancelled && generated) {
                setDataUri(generated);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [cacheParams]);

    if (dataUri && !imageFailed) {
        return (
            <Image
                testID="avatar-generated-photoGradient"
                source={{ uri: dataUri }}
                style={imageStyle}
                contentFit="cover"
                onError={() => setImageFailed(true)}
            />
        );
    }

    return (
        <PhotoGradientFallbackBoundary {...props} fallbackStyleId={fallbackStyleId}>
            <View testID="avatar-generated-photoGradient-fallback">
                <AvatarMeshGradient
                    {...props}
                    styleId={fallbackStyleId}
                />
            </View>
        </PhotoGradientFallbackBoundary>
    );
});

AvatarPhotoGradient.displayName = 'AvatarPhotoGradient';
