import * as React from 'react';
import { View } from 'react-native';

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
        const browser = (
            <SessionRepositoryTreeBrowserView
                sessionId={props.sessionId}
                density="panel"
                onRequestClose={props.onRequestClose}
                onOpenFile={handlePickPath}
                onOpenFilePinned={handlePickPath}
            />
        );
        // In popovers, the tree browser uses `flex: 1` at the root. Without an explicit height
        // constraint, React Native can collapse the popover content to 0 height on first render.
        if (typeof props.maxHeight === 'number' && Number.isFinite(props.maxHeight) && props.maxHeight > 0) {
            return (
                <View testID="link-file-picker-session-wrapper" style={{ height: props.maxHeight, width: '100%' }}>
                    {browser}
                </View>
            );
        }
        return browser;
    }

    const machineId = props.machineId ?? '';
    const rootDirectoryPath = props.rootDirectoryPath ?? '';
    if (!machineId || !rootDirectoryPath) {
        return null;
    }

    return (
        (() => {
            const browser = (
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
            // Same constraint as the session tree browser: when the root uses flex layouts (FlatList),
            // a maxHeight cap alone can still allow 0-height measurement on first render.
            if (typeof props.maxHeight === 'number' && Number.isFinite(props.maxHeight) && props.maxHeight > 0) {
                return (
                    <View testID="link-file-picker-machine-wrapper" style={{ height: props.maxHeight, width: '100%' }}>
                        {browser}
                    </View>
                );
            }
            return browser;
        })()
    );
});
