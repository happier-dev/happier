import * as React from 'react';

import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { openTeamSetupFirstTask, prepareTeamSetupPlan, runTeamSetupPlan, type TeamSetupActionContext } from './teamSetupPlan';

/** PlanChecklistController and the Machine/Project owners keep selection, progress, cancel and retry. */
export function useTeamSetupPlan(executeAction: FrontDoorActionExecute, context: TeamSetupActionContext) {
    return React.useMemo(() => ({
        prepare: (input: Omit<Parameters<typeof prepareTeamSetupPlan>[0], 'executeAction' | 'context'>) =>
            prepareTeamSetupPlan({ ...input, executeAction, context }),
        run: (input: Omit<Parameters<typeof runTeamSetupPlan>[0], 'executeAction' | 'context'>) =>
            runTeamSetupPlan({ ...input, executeAction, context }),
        openFirstTask: (input: Omit<Parameters<typeof openTeamSetupFirstTask>[0], 'executeAction' | 'context'>) =>
            openTeamSetupFirstTask({ ...input, executeAction, context }),
    }), [executeAction, context]);
}

export type TeamSetupPlanController = ReturnType<typeof useTeamSetupPlan>;
