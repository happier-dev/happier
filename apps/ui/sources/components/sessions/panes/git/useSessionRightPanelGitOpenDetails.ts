import * as React from 'react';

type PaneLike = Readonly<{
    openDetailsTab: (tab: any, options?: any) => void;
}>;

export function useSessionRightPanelGitOpenDetails(pane: PaneLike): Readonly<{
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
    openCommitInDetails: (sha: string) => void;
}> {
    const openDetailsTab = pane.openDetailsTab;

    const openFileInDetails = React.useCallback((fullPath: string) => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        openDetailsTab({
            key: `file:${fullPath}`,
            kind: 'file',
            title: fileName,
            resource: { kind: 'file', path: fullPath },
        });
    }, [openDetailsTab]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        openDetailsTab(
            {
                key: `file:${fullPath}`,
                kind: 'file',
                title: fileName,
                resource: { kind: 'file', path: fullPath },
            },
            { intent: 'pinned' }
        );
    }, [openDetailsTab]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const safeSha = sha.trim().split(/\s+/)[0] ?? '';
        if (!safeSha) return;
        openDetailsTab({
            key: `commit:${safeSha}`,
            kind: 'commit',
            title: safeSha.slice(0, 7),
            resource: { kind: 'commit', sha: safeSha },
        });
    }, [openDetailsTab]);

    return { openFileInDetails, openFileInDetailsPinned, openCommitInDetails };
}
