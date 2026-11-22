import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { createFrontDoorActionExecute, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import type { TeamSetupActionContext } from './teamSetupPlan';
import { useTeamSetupBatchProgress, type TeamSetupBatchRepositoryProgress } from './useTeamSetupBatchProgress';
import { useTeamSetupPlan, type TeamSetupBatch, type TeamSetupPlanController } from './useTeamSetupPlan';

const TeamSetupPlanContext = React.createContext<TeamSetupPlanController | null>(null);
const INACTIVE_CONTEXT: TeamSetupActionContext = { surface: 'ui', serverId: '', expectedAccountId: '' };

export function AuthenticatedTeamSetupPlanProvider({ children }: React.PropsWithChildren) {
    const { isAuthenticated } = useAuth();
    const lifetime = useActiveServerAccountScopeLifetime(isAuthenticated);
    const [execute] = React.useState(() => createFrontDoorActionExecute());
    const context = React.useMemo<TeamSetupActionContext | null>(() => lifetime && {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    }, [lifetime]);
    return <TeamSetupPlanProvider execute={execute} context={context}>{children}</TeamSetupPlanProvider>;
}

export function useRetainedTeamSetupPlan(): TeamSetupPlanController {
    const controller = React.useContext(TeamSetupPlanContext);
    if (!controller) throw new Error('Team Setup requires its authenticated layout');
    return controller;
}

export function TeamSetupPlanProvider({ children, execute, context }: React.PropsWithChildren<Readonly<{
    execute: FrontDoorActionExecute;
    context: TeamSetupActionContext | null;
}>>) {
    const controller = useTeamSetupPlan(execute, context ?? INACTIVE_CONTEXT);
    const { batch, complete, openFirstTask } = controller;
    return <TeamSetupPlanContext.Provider value={controller}>
        {children}
        {context && batch?.selection.repositories.map(({ source, requestId }) =>
            <TeamSetupRepositoryReadiness key={requestId} sourceId={source.id} batch={batch} requestId={requestId}
                complete={complete} openFirstTask={openFirstTask} />)}
    </TeamSetupPlanContext.Provider>;
}

/** One observer owns each selected native request across navigation. Page rows read its pushed snapshots. */
function TeamSetupRepositoryReadiness({ batch, complete, openFirstTask, requestId, sourceId }: Readonly<{
    batch: TeamSetupBatch;
    complete: TeamSetupPlanController['complete'];
    openFirstTask: TeamSetupPlanController['openFirstTask'];
    requestId: string;
    sourceId: string;
}>) {
    const { selection } = batch;
    const key = `team-setup-repository-ready:${requestId}`;
    const onReady = React.useCallback(({ readyProject, source }: TeamSetupBatchRepositoryProgress) => {
        if (!readyProject || selection.isReviewPresented?.() !== false || !selection.lifetime.isCurrent()) return;
        publishPresentationNotice({
            key, severity: 'info',
            message: t('teams.join.setupPage.repositoryReadyNotice', { repository: source.name }),
            emphasis: source.name,
            action: {
                label: t('teams.join.setupPage.repositoryReadyStart', { repository: source.name }),
                run: async () => {
                    await openFirstTask({ project: readyProject, machineId: selection.target.machineId,
                        prompt: '', lifetime: selection.lifetime });
                },
            },
        });
    }, [key, openFirstTask, selection]);
    const progress = useTeamSetupBatchProgress(batch, sourceId, onReady);
    // The immediate Open settlement already completes no-setup repositories.
    const setupCompleted = !!progress?.readyProject && progress.readyProject.setup !== 'notRequired';
    React.useEffect(() => {
        if (setupCompleted) complete(selection, requestId);
    }, [complete, requestId, selection, setupCompleted]);
    React.useEffect(() => () => retirePresentationNotice(key), [key]);
    return null;
}
