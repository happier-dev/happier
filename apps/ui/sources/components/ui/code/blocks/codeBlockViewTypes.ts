import type * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

export type CodeBlockViewProps = Readonly<{
    code: string;
    language?: string | null;
    showHeaderRow?: boolean;
    selectable?: boolean;
    wrap?: boolean;
    showCopyButton?: boolean;
    headerLeft?: React.ReactNode;
    headerRight?: React.ReactNode;
    scrollTestID?: string;
    containerStyle?: StyleProp<ViewStyle>;
}>;
