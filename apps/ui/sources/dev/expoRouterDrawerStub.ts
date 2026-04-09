import * as React from 'react';

type DrawerProps = Readonly<{
    children?: React.ReactNode;
    drawerContent?: ((props: Record<string, unknown>) => React.ReactNode) | undefined;
}>;

export const Drawer = Object.assign(
    function Drawer(props: DrawerProps) {
        return React.createElement(
            React.Fragment,
            null,
            props.drawerContent ? props.drawerContent({}) : null,
            props.children ?? null,
        );
    },
    {
        Screen: 'DrawerScreen' as any,
    },
);

export default Drawer;
