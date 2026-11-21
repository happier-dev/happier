import * as React from 'react';
import type { ProjectSourceIdentityV1 } from '@happier-dev/protocol/projects/sources/projectSourceIdentityV1';

import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { teamSetupStepId, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { openTeamSetupFirstTask, prepareTeamSetupPlan, runTeamSetupPlan, type TeamSetupActionContext, type TeamSetupTarget, type TeamSetupRunResult } from './teamSetupPlan';

export type TeamSetupBatchSelection = Readonly<{
    team: TeamAddress;
    lifetime: ServerAccountScopeLifetime;
    sources: readonly ProjectSourceIdentityV1[];
}>;
export type TeamSetupBatch = Readonly<{
    selection: Readonly<{
        team: TeamAddress;
        lifetime: ServerAccountScopeLifetime;
        target: TeamSetupTarget;
        repositories: readonly Readonly<{ repositoryId: string; source: ProjectSourceIdentityV1; requestId: string }>[];
    }>;
    dispatched: ReadonlySet<string>;
    running: boolean;
    settlement: TeamSetupRunResult | null;
}>;

/** Hoist one controller to the Home/Account workspace owner; native operations own all execution status. */
export function useTeamSetupPlan(executeAction: FrontDoorActionExecute, context: TeamSetupActionContext) {
    const [batch, setBatch] = React.useState<TeamSetupBatch | null>(null);
    React.useEffect(() => {
        if (!batch) return;
        const retire = () => setBatch(current => current?.selection === batch.selection ? null : current);
        if (!batch.selection.lifetime.isCurrent()) { retire(); return; }
        const subscription = batch.selection.lifetime.onRetire(retire);
        return () => subscription.dispose();
    }, [batch?.selection]);
    React.useEffect(() => {
        setBatch(current => current && (current.selection.lifetime.scope.serverId !== context.serverId
            || current.selection.lifetime.scope.accountId !== context.expectedAccountId) ? null : current);
    }, [context.serverId, context.expectedAccountId]);
    const actions = React.useMemo(() => ({
        prepare: (input: Omit<Parameters<typeof prepareTeamSetupPlan>[0], 'executeAction' | 'context'>) =>
            prepareTeamSetupPlan({ ...input, executeAction, context }),
        run: async (input: Omit<Parameters<typeof runTeamSetupPlan>[0], 'executeAction' | 'context' | 'repositoryRequestIds' | 'onCompleted'>
            & Readonly<{ selection?: TeamSetupBatchSelection }>) => {
            const { selection: selected, ...run } = input;
            if (!selected) return runTeamSetupPlan({ ...run, executeAction, context });
            const sourcesById = new Map(selected.sources.map(source => [source.id, source]));
            const repositories = run.plan.repositories.flatMap(repository => {
                const inputSource = repository.input.source;
                // An adopted existing clone opens as a Folder attach; its row still belongs to the Team Source.
                const source = sourcesById.get(inputSource.kind === 'source' ? inputSource.id : repository.id);
                if (!source) {
                    if (inputSource.kind !== 'source') return [];
                    throw new Error('Selected Team repository is missing its Source identity');
                }
                const revision = inputSource.kind === 'source' ? inputSource.revision : source.revision;
                return [{ repositoryId: repository.id, source: { id: source.id, revision, name: source.name, ...(source.owner ? { owner: source.owner } : {}) }, requestId: randomUUID() }];
            });
            const selection: TeamSetupBatch['selection'] = {
                team: selected.team, lifetime: selected.lifetime, target: run.plan.target, repositories,
            };
            setBatch({ selection, dispatched: new Set(), running: true, settlement: null });
            let settlement: TeamSetupRunResult | null = null;
            try {
                settlement = await runTeamSetupPlan({ ...run, executeAction, context,
                    repositoryRequestIds: new Map(repositories.map(repository => [repository.repositoryId, repository.requestId])),
                    onRepositoryOpening: id => {
                        setBatch(current => current?.selection === selection ? {
                            ...current, dispatched: new Set([...current.dispatched, id]),
                        } : current);
                        run.onRepositoryOpening?.(id);
                    },
                    onCompleted: () => {
                        if (repositories.length !== selected.sources.length || !selected.lifetime.isCurrent()) return;
                        void executeAction('home.hub.layout.update', {
                            intent: { kind: 'setup_visibility', stepId: teamSetupStepId(selected.lifetime.scope, selected.team), hidden: true },
                        }, context).catch(() => {
                            // The settled setup remains available and the offer can still be dismissed manually.
                        });
                    },
                });
                return settlement;
            } finally {
                setBatch(current => current?.selection === selection ? { ...current, running: false, settlement } : current);
            }
        },
        openFirstTask: (input: Omit<Parameters<typeof openTeamSetupFirstTask>[0], 'executeAction' | 'context'>) =>
            openTeamSetupFirstTask({ ...input, executeAction, context }),
    }), [executeAction, context]);
    return React.useMemo(() => ({ ...actions, batch }), [actions, batch]);
}

export type TeamSetupPlanController = ReturnType<typeof useTeamSetupPlan>;
