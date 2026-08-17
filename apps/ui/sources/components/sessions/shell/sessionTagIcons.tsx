import * as React from 'react';
import { Icon } from '@/components/ui/icons/Icon';

export function TagIcon(props: Readonly<{ size: number; color: string }>) {
    return <Icon name="tag" size={props.size} color={props.color} />;
}
