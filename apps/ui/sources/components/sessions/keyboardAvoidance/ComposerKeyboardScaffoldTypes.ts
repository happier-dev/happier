import type * as React from 'react';
import type {
    AccessibilityRole,
    StyleProp,
    ViewProps,
    ViewStyle,
} from 'react-native';

export type ComposerKeyboardScaffoldMode = 'session' | 'newSession';

/**
 * Whether the scaffold paints its own ground.
 *
 * `opaque` (the default) fills the root and the composer wrapper with `surface.base`, which is what
 * every bar and sheet in the app expects. `transparent` paints neither, so a screen presented as a
 * transparent modal can show what is behind it.
 *
 * Deliberately NOT derived from `mode`: the new-session wizard is also `newSession` and keeps its
 * opaque sheet.
 */
export type ComposerKeyboardScaffoldSurface = 'opaque' | 'transparent';

export type ComposerKeyboardScaffoldProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityRole?: AccessibilityRole;
    children: React.ReactNode;
    composer: React.ReactNode;
    composerTestID?: string;
    /** A non-modal shell host receives input only on its composer children. */
    composerPointerEvents?: ViewProps['pointerEvents'];
    /** A shell overlay can let the page receive touches outside its children. */
    pointerEvents?: ViewProps['pointerEvents'];
    contentProps?: ViewProps;
    contentStyle?: StyleProp<ViewStyle>;
    contentTestID?: string;
    headerHeight?: number;
    keyboardLiftSuppressed?: boolean;
    layoutBottomInset?: number;
    mode: ComposerKeyboardScaffoldMode;
    safeAreaBottom?: number;
    style?: StyleProp<ViewStyle>;
    /** Defaults to `opaque`. See {@link ComposerKeyboardScaffoldSurface}. */
    surface?: ComposerKeyboardScaffoldSurface;
    testID?: string;
}>;
