import * as React from 'react';
import type { FileViewerFindSnapshot } from '../details/useFileViewerFind';

/** The file content owner arbitrates deep-link and ephemeral Find scroll intent. */
export function useFileContentScrollTarget(jumpTarget: string | undefined, find?: Pick<FileViewerFindSnapshot, 'open' | 'lineTarget'>): string | undefined {
    const intent = React.useRef({ target: jumpTarget, retired: false });
    React.useLayoutEffect(() => {
        if (intent.current.target !== jumpTarget) intent.current = { target: jumpTarget, retired: false };
        if (find?.open) intent.current.retired = true;
    }, [find?.open, jumpTarget]);
    if (find?.open) return find.lineTarget ?? undefined;
    return intent.current.target === jumpTarget && intent.current.retired ? undefined : jumpTarget;
}
