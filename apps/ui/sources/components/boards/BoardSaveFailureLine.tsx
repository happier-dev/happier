import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { WorkBoardSaveFailure, WorkBoardSaveFailureReason } from './model/workBoardSaveQueue';
import { useWorkBoardSaveQueue } from './model/useWorkBoards';
import type { WorkBoardEntityContext } from './model/workBoardEntityDrop';

export function describeBoardSaveFailure(reason: WorkBoardSaveFailureReason): string {
    if (reason === 'not_found') return t('boards.saveFailed.notFound');
    return t('boards.saveFailed.generic');
}

/** A refused board save, said once where the person is (the board, or the Boards collection), with Try again and Dismiss. */
export const BoardSaveFailureLine = React.memo(function BoardSaveFailureLine(props: Readonly<{
    failure: WorkBoardSaveFailure;
    testID: string;
    context?: Omit<WorkBoardEntityContext, 'scope'>;
}>) {
    const saveQueue = useWorkBoardSaveQueue(props.context);
    const { failure } = props;
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind="error"
            size="line"
            accessibilitySemantics="alert"
            title={describeBoardSaveFailure(failure.reason)}
            action={failure.reason === 'not_found' ? undefined : { label: t('boards.saveFailed.retry'), onPress: () => { void saveQueue.retry(); } }}
            secondaryAction={{ label: t('boards.saveFailed.dismiss'), onPress: saveQueue.dismissFailure }}
        />
    );
});
