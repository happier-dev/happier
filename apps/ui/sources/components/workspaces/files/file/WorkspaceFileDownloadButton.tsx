import * as React from 'react';
import { Platform } from 'react-native';

import { t } from '@/text';
import { useWorkspaceFileTransfers } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

function normalizeWorkspaceScope(scope: WorkspaceScopeBase | null): WorkspaceScopeBase | null {
    if (!scope) return null;
    const serverId = String(scope.serverId ?? '').trim();
    const machineId = String(scope.machineId ?? '').trim();
    const rootPath = String(scope.rootPath ?? '').trim();
    if (!serverId || !machineId || !rootPath) return null;
    return { serverId, machineId, rootPath };
}

export const WorkspaceFileDownloadButton = React.memo((props: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    path: string;
    asZip?: boolean;
    testID?: string;
}>) => {
    const normalizedScope = React.useMemo(() => normalizeWorkspaceScope(props.workspaceScope), [props.workspaceScope]);
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    const transfers = useWorkspaceFileTransfers({
        workspaceScope: normalizedScope,
    });

    return (
        <IconButton
            testID={props.testID}
            accessibilityLabel={t('files.repositoryTree.actions.download')}
            tooltip={t('files.repositoryTree.actions.download')}
            iconName="download"
            iconSize={14}
            size={28}
            minimumInteractiveTargetSize={minimumInteractiveTargetSize}
            interactiveTargetGapPx={20}
            disabled={!normalizedScope}
            onPress={async (event) => {
                event?.stopPropagation?.();
                if (!normalizedScope) return;
                const res = await transfers.startDownload({ path: props.path, asZip: props.asZip === true });
                if (!res.ok && res.canceled !== true) {
                    try {
                        const { Modal } = await import('@/modal');
                        Modal.alert(t('common.error'), res.error);
                    } catch {
                        // Best-effort only.
                    }
                }
            }}
        />
    );
});
