import * as React from 'react';
import { HEALTH_REMOVE_ACTION_REF, savedHealthRemovalResultSchema } from '@happier-dev/plugins-machine-services/health-results';
import type { WorkflowTriggerHealthSourceV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor, readActionApprovalRequestCreatedError, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { buildServiceCheckHref } from './deploymentNavigation';
import { observeDeploymentSavedChecks, observedSavedCheckStatus, type DeploymentSavedCheckSnapshot } from './observeDeploymentSavedChecks';
import { projectServiceCheckDefinition, serviceCheckTitle } from './serviceCheckPresentation';

type SavedSource = WorkflowTriggerHealthSourceV1;
export type DeploymentSavedCheck = Readonly<{
    source: SavedSource;
    check: SavedSource['source']['checks'][number];
    title: string;
    targetLabel: string | null;
    healthStatus: ReturnType<typeof observedSavedCheckStatus>;
    href: string;
}>;

/** Settings reads saved definitions even before a runtime target has its first deploy. */
export function useDeploymentSavedChecks(
    lifetime: ServerAccountScopeLifetime | null, environmentId: string, demanded: boolean, environmentName?: string,
) {
    const [observed, setObserved] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime; environmentId: string; snapshot: DeploymentSavedCheckSnapshot;
    }> | null>(null);
    const read = React.useRef<ReturnType<typeof observeDeploymentSavedChecks> | null>(null);
    React.useEffect(() => {
        if (!lifetime || !demanded) return;
        const observation = observeDeploymentSavedChecks(lifetime, environmentId, snapshot => {
            setObserved({ lifetime, environmentId, snapshot });
        }, { definitions: true });
        read.current = observation;
        return () => { observation.dispose(); read.current = null; };
    }, [lifetime, environmentId, demanded]);
    const retry = React.useCallback(() => read.current?.retry(), []);
    const snapshot = observed?.lifetime === lifetime && observed?.environmentId === environmentId ? observed.snapshot : undefined;
    const sources = snapshot?.definitions.sources;
    const result = snapshot?.result;
    const rows = React.useMemo<readonly DeploymentSavedCheck[]>(() => {
        const names = environmentName ? new Map([[environmentId, environmentName]]) : undefined;
        return sources?.flatMap(source => source.source.checks.map(check => {
            const definition = projectServiceCheckDefinition(source.source, check);
            return { source, check, title: serviceCheckTitle(definition, names).title, targetLabel: definition.targetLabel,
                href: buildServiceCheckHref({ automationId: source.automationId, triggerId: source.triggerId, checkId: check.checkId }), healthStatus: observedSavedCheckStatus(result, source, check.checkId) };
        })) ?? [];
    }, [sources, environmentId, environmentName, result]);
    const remove = React.useMemo(() => lifetime ? createRemoval(lifetime) : null, [lifetime]);
    return { status: snapshot?.definitions.status ?? 'loading', failure: snapshot?.definitions.failure, rows, retry, remove };
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
