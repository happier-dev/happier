import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import { SafeIonicons, type SafeIoniconsName } from '@/components/ui/icons/SafeIonicons';

function contributedIoniconName(value: string | null | undefined): SafeIoniconsName | null {
    if (!value || typeof Ionicons?.glyphMap !== 'object' || Ionicons.glyphMap === null) return null;
    return Object.hasOwn(Ionicons.glyphMap, value) ? value as SafeIoniconsName : null;
}

export const ProviderIcon = React.memo(function ProviderIcon(props: Readonly<{
    icon: string | null | undefined;
    size: number;
    color: string;
}>) {
    return (
        <SafeIonicons
            name={contributedIoniconName(props.icon) ?? 'cube-outline'}
            size={props.size}
            color={props.color}
        />
    );
});
