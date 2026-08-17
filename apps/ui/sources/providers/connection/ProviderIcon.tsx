import * as React from 'react';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ICON_REGISTRY } from '@/components/ui/icons/iconRegistry.generated';

function contributedIconName(value: string | null | undefined): IconName | null {
    if (!value) return null;
    return Object.hasOwn(ICON_REGISTRY, value) ? value as IconName : null;
}

export const ProviderIcon = React.memo(function ProviderIcon(props: Readonly<{
    icon: string | null | undefined;
    size: number;
    color: string;
}>) {
    return (
        <Icon
            name={contributedIconName(props.icon) ?? 'cube'}
            size={props.size}
            color={props.color}
        />
    );
});
