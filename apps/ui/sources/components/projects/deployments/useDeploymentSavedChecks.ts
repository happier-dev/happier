import * as React from 'react';
import { HEALTH_REMOVE_ACTION_REF, savedHealthRemovalResultSchema } from '@happier-dev/plugins-machine-services/health-results';
import type { WorkflowTriggerHealthSourceV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { useWorkflowTriggerSets } from '@/components/workflows/triggers/useWorkflowTriggerSets';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor, readActionApprovalRequestCreatedError, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { projectServiceCheckDefinition, serviceCheckTitle } from './serviceCheckPresentation';

type SavedSource = WorkflowTriggerHealthSourceV1;
export type DeploymentSavedCheck = Readonly<{
    source: SavedSource;
    check: SavedSource['source']['checks'][number];
    title: string;
    targetLabel: string | null;
}>;

/** Settings reads saved definitions even before a runtime target has its first deploy. */
export function useDeploymentSavedChecks(
    lifetime: ServerAccountScopeLifetime | null, environmentId: string, demanded: boolean, environmentName?: string,
) {
    const read = useWorkflowTriggerSets({ healthSource: { environmentId } }, lifetime, { demanded });
    const rows = React.useMemo<readonly DeploymentSavedCheck[]>(() => {
        const names = environmentName ? new Map([[environmentId, environmentName]]) : undefined;
        return read.healthSources.flatMap(source => source.source.checks.map(check => {
            const definition = projectServiceCheckDefinition(source.source, check);
            return { source, check, title: serviceCheckTitle(definition, names).title, targetLabel: definition.targetLabel };
        }));
    }, [read.healthSources, environmentId, environmentName]);
    const remove = React.useMemo(() => lifetime ? createRemoval(lifetime) : null, [lifetime]);
    return { status: read.status, failure: read.failure, rows, retry: read.retry, remove };
}

function createRemoval(lifetime: ServerAccountScopeLifetime) {
    const execute = createFrontDoorUiActionExecutor(undefined, {
        serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    });
    return async ({ source, check }: DeploymentSavedCheck, operation?: UiActionOperation) => {
        if (!lifetime.isCurrent()) throw new HappyError('action_account_scope_changed', false, { code: 'action_account_scope_changed' });
        try {
            return savedHealthRemovalResultSchema.parse(await execute('action.invoke', {
                action: HEALTH_REMOVE_ACTION_REF,
                input: { automationId: source.automationId, triggerId: source.triggerId, checkId: check.checkId },
            }, { ...operation, externalActionTarget: { kind: 'machine', machineId: source.observer.machineId } }));
        } catch (error) {
            const approval = readActionApprovalRequestCreatedError(error);
            if (approval) return { status: 'approvalRequested' as const, ...approval };
            throw error;
        }
    };
}
