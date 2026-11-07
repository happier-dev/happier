import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { useSessionLocalFilePath } from '@/components/sessions/files/local/useSessionLocalFilePath';
import {
    openLocalFileWithDefaultApp,
    revealLocalFileInFileManager,
} from '@/components/sessions/files/local/desktopLocalFileActions';
import { canOpenSessionFileWindow, openSessionFileWindow } from '@/components/sessions/files/window/openSessionFileWindow';
import { Modal } from '@/modal';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

export type SessionDetailsTabMenuTab = Readonly<{
    key: string;
    title: string;
    /** Workspace-relative path when the tab shows a file. */
    filePath: string | null;
}>;

type SessionDetailsTabMenuItemId = 'openInNewWindow' | 'openWithDefaultApp' | 'revealInFileManager' | 'closeTab';

/**
 * The right-click / long-press menu of a details tab. Mounted only while open, so the local-path
 * lookup it needs runs only when someone asks for the menu.
 */
export function SessionDetailsTabMenu(props: Readonly<{
    sessionId: string;
    tab: SessionDetailsTabMenuTab;
    anchorRef: React.RefObject<unknown>;
    onClose: () => void;
    onCloseTab: (tabKey: string) => void;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const desktop = isTauriDesktop();
    const { sessionId, tab, onClose, onCloseTab } = props;
    const serverId = useWorkspaceScopeForSession(sessionId)?.serverId ?? null;
    const localFilePath = useSessionLocalFilePath(sessionId, tab.filePath ?? '');
    const localPath = tab.filePath ? localFilePath : null;
    const iconColor = theme.colors.text.secondary;

    const items = React.useMemo<readonly ContextMenuItem[]>(() => {
        const next: ContextMenuItem[] = [];
        if (tab.filePath && canOpenSessionFileWindow()) {
            next.push({
                id: 'openInNewWindow',
                title: t('session.detailsPanel.tabMenu.openInNewWindow'),
                icon: <Icon name="arrow-square-out" size={16} color={iconColor} />,
            });
        }
        if (tab.filePath && desktop) {
            next.push({
                id: 'openWithDefaultApp',
                title: t('session.detailsPanel.tabMenu.openWithDefaultApp'),
                icon: <Icon name="file-arrow-up" size={16} color={iconColor} />,
            });
        }
        if (localPath) {
            next.push({
                id: 'revealInFileManager',
                title: t('session.detailsPanel.tabMenu.revealInFileManager'),
                icon: <Icon name="folder-open" size={16} color={iconColor} />,
            });
        }
        next.push({
            id: 'closeTab',
            title: t('session.detailsPanel.closeTabA11y'),
            icon: <Icon name="x" size={16} color={iconColor} />,
        });
        return next;
    }, [desktop, iconColor, localPath, tab.filePath]);

    const handleSelect = React.useCallback((itemId: string) => {
        onClose();
        const run = async () => {
            switch (itemId as SessionDetailsTabMenuItemId) {
                case 'openInNewWindow':
                    if (tab.filePath) await openSessionFileWindow({ sessionId, serverId, path: tab.filePath }, tab.title);
                    return;
                case 'openWithDefaultApp':
                    if (localPath) {
                        await openLocalFileWithDefaultApp(localPath);
                    } else if (tab.filePath && desktop) {
                        const confirmed = await Modal.confirm(
                            t('session.detailsPanel.tabMenu.setupRequiredTitle'),
                            t('session.detailsPanel.tabMenu.setupRequiredMessage'),
                            {
                                confirmText: t('session.detailsPanel.tabMenu.openSettings'),
                                cancelText: t('common.cancel'),
                            },
                        );
                        if (confirmed) router.push('/settings/file-opening');
                    }
                    return;
                case 'revealInFileManager':
                    if (localPath) await revealLocalFileInFileManager(localPath);
                    return;
                case 'closeTab':
                    onCloseTab(tab.key);
                    return;
            }
        };
        run().catch((error: unknown) => {
            Modal.alert(
                t('session.detailsPanel.tabMenu.actionFailedTitle'),
                error instanceof Error ? error.message : String(error),
            );
        });
    }, [desktop, localPath, onClose, onCloseTab, router, serverId, sessionId, tab.filePath, tab.key, tab.title]);

    return (
        <ContextMenu
            anchorRef={props.anchorRef}
            open={true}
            onOpenChange={(open) => { if (!open) onClose(); }}
            items={items}
            onSelect={handleSelect}
            closeOnSelect={true}
        />
    );
}
