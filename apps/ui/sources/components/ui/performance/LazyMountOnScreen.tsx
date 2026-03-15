import * as React from 'react';

export function LazyMountOnScreen(props: Readonly<{ children: React.ReactNode }>) {
    return <>{props.children}</>;
}
