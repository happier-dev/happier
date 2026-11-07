import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierAvatarStack, type HappierAvatarStackProps } from '@happier-dev/plugin-ui/presentation';

export type { HappierAvatarStackEntry as AvatarStackEntry } from '@happier-dev/plugin-ui/presentation';
export type AvatarStackProps = Omit<HappierAvatarStackProps, 'ringColor'> & Readonly<{ ringColor?: string }>;

/** Core theme binding of the shared overlapping identity marks, including their single-slot composition. */
export function AvatarStack(props: AvatarStackProps) {
    const { theme } = useUnistyles();
    return <HappierAvatarStack {...props} ringColor={props.ringColor ?? theme.colors.surface.base} />;
}
