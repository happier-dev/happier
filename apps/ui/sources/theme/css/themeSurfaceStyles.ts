import type { SurfaceAddress } from '@happier-dev/plugin-ui';
import { resolveHappierThemeSurfaceStyle } from '@happier-dev/plugin-ui/presentation';
import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

const emptyStyle = {};

/** Registered native projection of the runtime's prepared table; web uses its scoped sheet. */
export const themeSurfaceStyles = StyleSheet.create(theme => ({
    surface: (address?: SurfaceAddress) => address
        ? resolveHappierThemeSurfaceStyle(theme, address, Platform.OS) ?? emptyStyle
        : emptyStyle,
}));
