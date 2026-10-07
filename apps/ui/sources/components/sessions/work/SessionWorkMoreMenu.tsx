import * as React from 'react';

import { useSessionRolesMenuActions } from '@/components/sessions/work/roles/SessionRolesSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

/**
 * The Work pane header's ⋯ (lab `convo-W9`: Work · List | Map · ⤢ · + · ⋯): whole-pane operations
 * that are not a way to start something (those are "+"). Today these are the Roles bulk actions,
 * "Use defaults" and "Apply to sessions under it". With nothing to offer, there is no ⋯.
 */
export const SessionWorkMoreMenu = React.memo(function SessionWorkMoreMenu(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** The session has sessions under it, so its roles can be applied to them. */
    hasReports: boolean;
}>) {
    const [open, setOpen] = React.useState(false);
    const actions = useSessionRolesMenuActions(props);
    const items = React.useMemo<readonly DropdownMenuItem[]>(
        () => actions.map((action) => ({ id: action.id, testID: `session-work-more.${action.id}`, title: action.title })),
        [actions],
    );
    const onSelect = React.useCallback(async (id: string) => {
        setOpen(false);
        await actions.find((action) => action.id === id)?.onSelect();
    }, [actions]);
    if (items.length === 0) return null;
    return (
        <DropdownMenu
            testID="session-work-more.menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={onSelect}
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={280}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <IconButton
                    testID="session-work-more"
                    iconName="dots-three"
                    variant="plain"
                    accessibilityLabel={t('common.moreActions')}
                    tooltip={t('common.moreActions')}
                    onPress={toggle}
                />
            )}
        />
    );
});
