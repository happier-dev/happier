import type * as React from 'react';

export type CodeBlockViewProps = Readonly<{
    code: string;
    language?: string | null;
    showHeaderRow?: boolean;
    selectable?: boolean;
    wrap?: boolean;
    showCopyButton?: boolean;
    headerRight?: React.ReactNode;
    scrollTestID?: string;
}>;
