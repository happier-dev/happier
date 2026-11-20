import * as React from 'react';

import { ScmStashDetailsCore } from '@/components/workspaces/scm/stash/ScmStashDetailsCore';
import type { ScmStashDetailsAdapter } from '@/components/workspaces/scm/stash/scmStashAdapter';
import {
    machineScmStashApply,
    machineScmStashDrop,
    machineScmStashList,
    machineScmStashPop,
    machineScmStashShow,
} from '@/sync/ops/scm/machineScm';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceScmStashDetailsViewProps = WorkspaceScopeBase & Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>;

export const WorkspaceScmStashDetailsView = React.memo((props: WorkspaceScmStashDetailsViewProps) => {
    const adapter = React.useMemo<ScmStashDetailsAdapter>(() => {
        const options = { serverId: props.serverId, ...(props.workspace ? { workspace: props.workspace } : {}) };
        return {
            list: () => machineScmStashList(props.machineId, { cwd: props.rootPath }, options),
            show: (stashRef) => machineScmStashShow(props.machineId, { cwd: props.rootPath, stashRef }, options),
            pop: (stashRef, call) => machineScmStashPop(props.machineId, { cwd: props.rootPath, stashRef }, { ...options, ...call }),
            drop: (stashRef, call) => machineScmStashDrop(props.machineId, { cwd: props.rootPath, stashRef }, { ...options, ...call }),
            apply: (stashRef, call) => machineScmStashApply(props.machineId, { cwd: props.rootPath, stashRef }, { ...options, ...call }),
        };
    }, [props.machineId, props.rootPath, props.serverId, props.workspace]);

    return (
        <ScmStashDetailsCore
            adapter={adapter}
            scopeResetKey={`workspace:${props.workspaceCacheKey}`}
            rootTestId="workspace-scm-stash-details-root"
            folderLabel={props.rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null}
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
        />
    );
});
