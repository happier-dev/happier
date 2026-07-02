import type React from 'react';
import type { Ionicons } from '@expo/vector-icons';

export type ItemAction = {
    id: string;
    title: string;
    subtitle?: string;
    /**
     * Either an Ionicons icon name (recommended for standard row actions),
     * or a fully-rendered icon node for custom surfaces (e.g. header icons with badges).
     */
    icon: React.ComponentProps<typeof Ionicons>['name'] | React.ReactElement;
    onPress?: () => void;
    /** Optional testID for the inline icon pressable. */
    inlineTestID?: string;
    disabled?: boolean;
    destructive?: boolean;
    color?: string;
};
