import * as React from 'react';
import { Octicons } from '@expo/vector-icons';

export function TagIcon(props: Readonly<{ size: number; color: string }>) {
    return <Octicons name="tag" size={props.size} color={props.color} />;
}
