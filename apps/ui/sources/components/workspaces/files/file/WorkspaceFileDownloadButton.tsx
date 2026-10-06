import * as React from 'react';
import { Platform } from 'react-native';

import { t } from '@/text';
import { useWorkspaceFileTransfers, type WorkspaceFileDownloadAction } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Modal } from '@/modal';
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
    const [menuOpen, setMenuOpen] = React.useState(false);
    const normalizedScope = React.useMemo(() => normalizeWorkspaceScope(props.workspaceScope), [props.workspaceScope]);
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    const transfers = useWorkspaceFileTransfers({
        workspaceScope: normalizedScope,
    });

    const android = Platform.OS === 'android';
    const busy = transfers.downloadState.status === 'downloading';
    const disabled = !normalizedScope || busy;
    const label = t('files.repositoryTree.actions.download');

    const download = async (action?: WorkspaceFileDownloadAction) => {
        if (!normalizedScope) return;
        const result = await transfers.startDownload({ path: props.path, asZip: props.asZip === true, action });
        if (!result.ok && result.canceled !== true) Modal.alert(t('common.error'), result.error);
    };

    const renderButton = (onPress: () => void | Promise<void>) => (
        <IconButton
            testID={props.testID}
            accessibilityLabel={label}
            tooltip={label}
            tooltipHidden={menuOpen}
            hasPopup={android ? 'menu' : undefined}
            expanded={android ? menuOpen : undefined}
            {...(busy ? { icon: <ActivitySpinner size={iconMatchedSpinnerSize(14)} /> } : { iconName: 'download' as const })}
            iconSize={14}
            size={28}
            minimumInteractiveTargetSize={minimumInteractiveTargetSize}
            interactiveTargetGapPx={20}
            disabled={disabled}
            onPress={(event) => {
                event?.stopPropagation?.();
                if (disabled) return;
                return onPress();
            }}
        />
    );

    if (!android) return renderButton(() => download());

    return (
        <DropdownMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={[
                { id: 'save', testID: 'workspace-file-download-action-save', title: t('common.saveAs'), disabled },
                { id: 'open', testID: 'workspace-file-download-action-open', title: t('files.repositoryTree.actions.openWith'), disabled },
                { id: 'share', testID: 'workspace-file-download-action-share', title: t('files.repositoryTree.actions.share'), disabled },
            ]}
            onSelect={async (action) => {
                setMenuOpen(false);
                if (disabled) return;
                if (action === 'save' || action === 'open' || action === 'share') await download(action);
            }}
            search={false}
            matchTriggerWidth={false}
            placement="bottom"
            popoverAnchorAlign="end"
            trigger={({ toggle }) => renderButton(toggle)}
        />
    );
});
