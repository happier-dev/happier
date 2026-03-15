import * as React from 'react';

export function PierreScrollRootVirtualizerProvider(props: Readonly<{ children: React.ReactNode }>) {
    return <>{props.children}</>;
}
