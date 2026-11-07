import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

import { describeBoardUndetermined } from './model/boardCards';
import type { BoardUndeterminedMembership } from './model/boardMembership';

/**
 * What a Board could not check, said once under its header: its answered filter left some candidates
 * unclassified, so every count above is a floor. A quiet neutral line (never a warning); it reads the
 * membership owner's fact and words it, and a Board with nothing unresolved renders nothing.
 */
export const BoardUndeterminedLine = React.memo(function BoardUndeterminedLine(props: Readonly<{
    undetermined: BoardUndeterminedMembership;
    taskItemsComplete?: boolean;
    onRetryTasks?: () => void;
}>) {
    const said = describeBoardUndetermined(props.undetermined);
    const tasksIncomplete = props.taskItemsComplete === false;
    if (!said && !tasksIncomplete) return null;
    const reason = [said ? `${said.headline} · ${said.reason}` : null,
        tasksIncomplete ? t('boards.undetermined.taskSources') : null].filter(Boolean).join(' · ');
    return <SurfaceFreshnessLine testID="board-undetermined" glyph="info" reason={reason} emphasis={said?.headline}
        action={tasksIncomplete && props.onRetryTasks ? { label: t('common.retry'), onPress: props.onRetryTasks } : undefined} />;
});
