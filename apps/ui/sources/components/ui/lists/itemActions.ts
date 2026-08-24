import type React from 'react';
import type { GestureResponderEvent } from 'react-native';
import type { IconName } from '@/components/ui/icons/Icon';

export type ItemAction = {
    id: string;
    title: string;
    subtitle?: string;
    /**
     * Either an Ionicons icon name (recommended for standard row actions),
     * or a fully-rendered icon node for custom surfaces (e.g. header icons with badges).
     */
    icon: IconName | React.ReactElement;
    onPress?: (event?: GestureResponderEvent) => void;
    /** Optional testID for the inline icon pressable. */
    inlineTestID?: string;
    disabled?: boolean;
    destructive?: boolean;
    color?: string;
};
