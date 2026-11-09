import * as React from 'react';
import type { FileChangesScope } from '@happier-dev/protocol/scm';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { FileViewActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { FileDisplayMode, FilePageModeOption } from './filePageModel';

/** Explicit controls address their mounted File; passive hydration still calls its raw owner. */
export function useFileViewCommands(params: Readonly<{
    scope: ServerAccountScope | null;
    owner: React.MutableRefObject<FileViewActionOwner | null>;
    modes: readonly FilePageModeOption[];
}>) {
    const execute = useMountedScopeActionCommand(params.scope);
    const read = React.useCallback(() => params.owner.current!, [params.owner]);
    const set = React.useCallback((patch: Parameters<FileViewActionOwner['set']>[0]) => {
        const owner = params.owner.current;
        return owner ? execute('file.view.set', { tabId: owner.tabId, ...patch }, { kind: 'file.view', read }) : Promise.resolve(false);
    }, [execute, params.owner, read]);
    const onDisplayMode = React.useCallback((mode: FileDisplayMode) => {
        const option = params.modes.find(option => option.displayMode === mode);
        return option ? set({ mode: option.id }) : Promise.resolve(false);
    }, [params.modes, set]);
    const onChangesScopeChange = React.useCallback((changesScope: FileChangesScope) => { void set({ changesScope }); }, [set]);
    const toggleBlame = React.useCallback(() => { void set({ blame: !params.owner.current?.blame }); }, [params.owner, set]);
    return { onDisplayMode, onChangesScopeChange, toggleBlame, set };
}
