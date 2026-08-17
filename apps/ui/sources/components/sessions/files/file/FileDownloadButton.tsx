import * as React from 'react';
import { Platform } from 'react-native';

import { t } from '@/text';
import { useWorkspaceFileTransfers } from '@/hooks/session/files/useWorkspaceFileTransfers';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export const FileDownloadButton = React.memo((props: Readonly<{
    sessionId: string;
    path: string;
    asZip?: boolean;
    testID?: string;
}>) => {
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    const transfers = useWorkspaceFileTransfers({
        sessionId: props.sessionId,
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
            onPress={async (event) => {
                event?.stopPropagation?.();
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
