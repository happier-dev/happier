import { Octicons } from '@expo/vector-icons';
import * as React from 'react';

type SidebarIconProps = {
    size?: number;
    color?: string;
};

export const SidebarExpandIcon = React.memo(({ size = 16, color = '#6B7280' }: SidebarIconProps) => {
    return <Octicons name="sidebar-expand" size={size} color={color} />;
});

export const SidebarCollapseIcon = React.memo(({ size = 16, color = '#6B7280' }: SidebarIconProps) => {
    return <Octicons name="sidebar-collapse" size={size} color={color} />;
});
