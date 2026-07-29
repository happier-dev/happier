import * as React from 'react';

import { ScmStashDetailsCore } from '@/components/workspaces/scm/stash/ScmStashDetailsCore';
import type { ScmStashDetailsAdapter } from '@/components/workspaces/scm/stash/scmStashAdapter';
import { machineScmStashDrop, machineScmStashList, machineScmStashPop, machineScmStashShow } from '@/sync/ops/scm/machineScm';

export type WorkspaceScmStashDetailsViewProps = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    machineId: string;
    rootPath: string;
    serverId: string;
    onOpenFile?: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
}>;

export const WorkspaceScmStashDetailsView = React.memo((props: WorkspaceScmStashDetailsViewProps) => {
    const adapter = React.useMemo<ScmStashDetailsAdapter>(() => ({
        list: () => machineScmStashList(props.machineId, { cwd: props.rootPath }, { serverId: props.serverId }),
        show: (stashRef) => machineScmStashShow(props.machineId, { cwd: props.rootPath, stashRef }, { serverId: props.serverId }),
        pop: (stashRef) => machineScmStashPop(props.machineId, { cwd: props.rootPath, stashRef }, { serverId: props.serverId }),
        drop: (stashRef) => machineScmStashDrop(props.machineId, { cwd: props.rootPath, stashRef }, { serverId: props.serverId }),
    }), [props.machineId, props.rootPath, props.serverId]);

    return (
        <ScmStashDetailsCore
            adapter={adapter}
            scopeResetKey={`workspace:${props.workspaceCacheKey}`}
            rootTestId="workspace-scm-stash-details-root"
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
        />
    );
});
