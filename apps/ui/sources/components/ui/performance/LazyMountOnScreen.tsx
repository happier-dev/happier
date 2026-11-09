import * as React from 'react';

export function LazyMountOnScreen(props: Readonly<{
    children: React.ReactNode;
    initiallyVisible?: boolean;
    unmountWhenHidden?: boolean;
    placeholder?: React.ReactNode;
    rootMargin?: string;
    style?: React.CSSProperties;
}>) {
    return <>{props.children}</>;
}
