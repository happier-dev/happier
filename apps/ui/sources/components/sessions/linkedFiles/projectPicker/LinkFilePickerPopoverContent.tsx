import * as React from 'react';

import { MachinePathBrowserView } from '@/components/ui/pathBrowser/MachinePathBrowserModal';
import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';

export type LinkFilePickerPopoverContentProps = Readonly<{
    sessionId?: string | null;
    machineId?: string | null;
    serverId?: string | null;
    rootDirectoryPath?: string | null;
    maxHeight?: number;
    onPickPath: (path: string) => void;
    onRequestClose: () => void;
}>;

export const LinkFilePickerPopoverContent = React.memo((props: LinkFilePickerPopoverContentProps) => {
    const handlePickPath = React.useCallback((path: string) => {
        props.onPickPath(path);
        props.onRequestClose();
    }, [props]);

    if (props.sessionId) {
        return (
            <SessionRepositoryTreeBrowserView
                sessionId={props.sessionId}
                density="panel"
                onRequestClose={props.onRequestClose}
                onOpenFile={handlePickPath}
                onOpenFilePinned={handlePickPath}
            />
        );
    }

    const machineId = props.machineId ?? '';
    const rootDirectoryPath = props.rootDirectoryPath ?? '';
    if (!machineId || !rootDirectoryPath) {
        return null;
    }

    return (
        <MachinePathBrowserView
            machineId={machineId}
            serverId={props.serverId}
            rootDirectoryPath={rootDirectoryPath}
            includeFiles
            selectionMode="file"
            variant="popover"
            interaction="immediate"
            maxHeight={props.maxHeight}
            onPickPath={handlePickPath}
            onRequestClose={props.onRequestClose}
        />
    );
});
