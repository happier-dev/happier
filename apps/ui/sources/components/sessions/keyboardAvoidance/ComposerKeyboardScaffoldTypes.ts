import type * as React from 'react';
import type {
    AccessibilityRole,
    StyleProp,
    ViewProps,
    ViewStyle,
} from 'react-native';

export type ComposerKeyboardScaffoldMode = 'session' | 'newSession';

export type ComposerKeyboardScaffoldProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityRole?: AccessibilityRole;
    children: React.ReactNode;
    composer: React.ReactNode;
    composerTestID?: string;
    contentProps?: ViewProps;
    contentStyle?: StyleProp<ViewStyle>;
    contentTestID?: string;
    headerHeight?: number;
    keyboardLiftSuppressed?: boolean;
    layoutBottomInset?: number;
    mode: ComposerKeyboardScaffoldMode;
    safeAreaBottom?: number;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;
