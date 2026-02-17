import * as React from 'react';
import { Octicons } from '@expo/vector-icons';

export function PinIcon(props: Readonly<{ size: number; color: string }>) {
    return <Octicons name="pin" size={props.size} color={props.color} />;
}

export function PinSlashIcon(props: Readonly<{ size: number; color: string }>) {
    return <Octicons name="pin-slash" size={props.size} color={props.color} />;
}

