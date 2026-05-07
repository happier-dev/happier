import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';
import { getCachedMeshGradientAvatarXml } from '@/components/ui/avatar/generation/mesh/avatarXml';

import type { MeshGradientThemeInput } from './meshGradientTypes';

type AvatarMeshGradientProps = Readonly<{
    id: string;
    styleId?: AvatarStyleId;
    title?: boolean;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}>;

export const AvatarMeshGradient = React.memo((props: AvatarMeshGradientProps) => {
    const { id, styleId, square, size = 48, monochrome = false } = props;
    const { theme } = useUnistyles();
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
    const xml = React.useMemo(() => getCachedMeshGradientAvatarXml({
        id,
        styleId,
        monochrome,
        theme: themeInput,
    }), [id, monochrome, styleId, themeInput]);
    const containerStyle = React.useMemo((): ViewStyle => ({
        width: size,
        height: size,
        borderRadius: square ? 0 : size / 2,
        overflow: 'hidden',
        position: 'relative',
    }), [size, square]);

    return (
        <View
            testID="avatar-generated-meshGradient"
            style={containerStyle}
        >
            <SvgXml
                xml={xml}
                width={size}
                height={size}
                style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                }}
            />
        </View>
    );
});
