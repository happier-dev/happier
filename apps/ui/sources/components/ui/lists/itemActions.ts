import type React from 'react';
import type { Ionicons } from '@expo/vector-icons';

export type ItemAction = {
    id: string;
    title: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    onPress: () => void;
    disabled?: boolean;
    destructive?: boolean;
    color?: string;
};
