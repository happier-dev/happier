import * as React from 'react';
import { Icon } from '@/components/ui/icons/Icon';

export function PinIcon(props: Readonly<{ size: number; color: string }>) {
    return <Icon name="push-pin" size={props.size} color={props.color} />;
}

export function PinSlashIcon(props: Readonly<{ size: number; color: string }>) {
    return <Icon name="push-pin-slash" size={props.size} color={props.color} />;
}

