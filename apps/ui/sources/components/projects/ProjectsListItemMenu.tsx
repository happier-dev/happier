import * as React from 'react';
import { Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { Icon } from '@/components/ui/icons/Icon';

type AppTheme = ReturnType<typeof useUnistyles>['theme'];

type ProjectsListItemMenuProps = Readonly<{
    theme: AppTheme;
    workspaceRef: WorkspaceRefV1;
    pinAction?: 'pin' | 'unpin' | null;
    onTogglePinned: (workspaceRefId: string) => void;
    onRename: (workspaceRef: WorkspaceRefV1) => void | Promise<void>;
    onReset: (workspaceRef: WorkspaceRefV1) => void;
    onRemove: (workspaceRef: WorkspaceRefV1) => void;
}>;

function stopPressEventPropagation(event: unknown): void {
    const maybeEvent = event as {
        stopPropagation?: () => void;
        nativeEvent?: { stopPropagation?: () => void };
    };
    try {
        maybeEvent.stopPropagation?.();
    } catch {}
    try {
        maybeEvent.nativeEvent?.stopPropagation?.();
    } catch {}
}

export const ProjectsListItemMenu = React.memo((props: ProjectsListItemMenuProps) => {
    const [open, setOpen] = React.useState(false);
    const pinTitle = props.pinAction === 'unpin'
        ? t('projects.actions.unpin')
        : props.pinAction === 'pin'
            ? t('projects.actions.pin')
            : null;
    const renameTitle = t('sessionsList.renameWorkspace');
    const resetTitle = t('sessionsList.resetWorkspaceName');
    const removeTitle = t('projects.actions.remove');
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => {
        const nextItems: DropdownMenuItem[] = [];
        if ((props.pinAction === 'pin' || props.pinAction === 'unpin') && pinTitle) {
            nextItems.push({
                id: props.pinAction,
                title: pinTitle,
                icon: <Icon name="push-pin" size={16} color={props.theme.colors.text.secondary} />,
            });
        }
        nextItems.push(
            {
                id: 'rename',
                title: renameTitle,
                icon: <Icon name="pencil" size={16} color={props.theme.colors.text.secondary} />,
            },
            {
                id: 'reset',
                title: resetTitle,
                icon: <Icon name="arrow-clockwise" size={16} color={props.theme.colors.text.secondary} />,
            },
            {
                id: 'remove',
                title: removeTitle,
                icon: <Icon name="trash" size={16} color={props.theme.colors.state.danger.foreground} />,
            },
        );
        return nextItems;
    }, [pinTitle, props.pinAction, props.theme.colors.state.danger.foreground, props.theme.colors.text.secondary, removeTitle, renameTitle, resetTitle]);

    const handleSelect = React.useCallback((itemId: string) => {
        if ((itemId === 'pin' || itemId === 'unpin') && props.pinAction) {
            props.onTogglePinned(props.workspaceRef.id);
            return;
        }
        if (itemId === 'rename') {
            void props.onRename(props.workspaceRef);
            return;
        }
        if (itemId === 'reset') {
            props.onReset(props.workspaceRef);
            return;
        }
        if (itemId === 'remove') {
            props.onRemove(props.workspaceRef);
        }
    }, [props]);

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={handleSelect}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={240}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <Pressable
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        toggle();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.moreActions')}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                >
                    <Icon name="dots-three-vertical" size={14} color={props.theme.colors.text.secondary} />
                </Pressable>
            )}
        />
    );
});
