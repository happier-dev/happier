import * as React from 'react';

import { useSessionRolesMenuActions } from '@/components/sessions/work/roles/SessionRolesSection';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';

/**
 * The Work pane's rare whole-pane operations, folded into the pane header's one ⋯: the Roles bulk
 * actions ("Use defaults", "Apply to sessions under it"). The map's larger view (⤢) is a header
 * control of its own beside List | Map and "+" (lab `convo-W7`: Work · meta · List | Map · ⤢ · + · ⋯).
 * With nothing to offer, the Work tab adds nothing to the ⋯.
 */
export function useSessionWorkMenuActions(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    /** The session has sessions under it, so its roles can be applied to them. */
    hasReports: boolean;
}>): readonly ItemAction[] {
    const actions = useSessionRolesMenuActions(input);
    return React.useMemo(() => [
        ...actions.map((action): ItemAction => ({
            id: action.id,
            title: action.title,
            icon: action.id === 'roles.useDefaults' ? 'arrow-arc-left' : 'tree-structure',
            inlineTestID: `session-work-more.${action.id}`,
            onPress: () => { void action.onSelect(); },
        })),
    ], [actions]);
}
