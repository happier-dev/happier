import * as React from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1, DeploymentReadSnapshotV1 } from '@happier-dev/deployments';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import type { createDeploymentActions } from './deploymentActions';
import { readDeploymentActionError, readDeploymentActionResult, type DeploymentActionOutcome } from './deploymentActionOutcome';
import { useDeploymentReceipt } from './useDeploymentReads';
import { deploymentManagedRetention, type DeploymentRetentionChoiceValue } from './DeploymentRetentionChoice';

/** Only the target-membership Actions: a page passes the subset it holds. */
type Actions = Pick<ReturnType<typeof createDeploymentActions>, 'deleteEnvironment' | 'unlink' | 'teardown' | 'link'>;
export type DeploymentEnvironmentDeleteChoice = Readonly<{ kind: 'detachKeepRunning' }>
    | Readonly<{ kind: 'afterTeardown'; deploymentIds: readonly string[] }>;
export type DeploymentTargetUnlinkChoice = Readonly<{ kind: 'detachKeepRunning' }>
    | Readonly<{ kind: 'afterTeardown'; deploymentId?: string }>;
export type DeploymentEnvironmentDeletionOutcome = DeploymentActionOutcome
    | Readonly<{ kind: 'deleted'; detached: boolean }>
    | Readonly<{ kind: 'unlinked'; targetLinkId: string; detached: boolean }>
    | Readonly<{ kind: 'linked'; targetLinkId: string }>;
/** The Machine a runtime link names, with the installation the target link records, and the retention choice made for it. */
export type DeploymentLinkMachine = Readonly<{ machineId: string; installationId: string; retention?: DeploymentRetentionChoiceValue }>;
export type DeploymentEnvironmentDeletionOptions = Readonly<{
    environmentId: string;
    lifetime: ServerAccountScopeLifetime | null;
    snapshot: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>;
    actions: Actions | null;
    controller: DeploymentReadControllerV1 | null;
    demand: DeploymentReadDemandV1;
}>;

/** Final record dispositions use Actions; receipt lifecycle stays with the shared pushed read owner. */
export function useDeploymentEnvironmentDeletion(options: DeploymentEnvironmentDeletionOptions) {
    const lifetime = options.lifetime;
    const scope = React.useMemo(() => ({ lifetime, environmentId: options.environmentId }), [lifetime, options.environmentId]);
    const flight = React.useRef<Readonly<{ scope: typeof scope; controller: AbortController }> | null>(null);
    const subscribe = React.useCallback((listener: () => void) => {
        const watch = lifetime?.onRetire(() => { flight.current?.controller.abort(); listener(); });
        return () => watch?.dispose();
    }, [lifetime]);
    const readCurrent = React.useCallback(() => lifetime?.isCurrent() === true, [lifetime]);
    const isCurrent = React.useSyncExternalStore(subscribe, readCurrent, readCurrent);
    const [state, setState] = React.useState<Readonly<{
        scope: typeof scope; busy: boolean; outcome: DeploymentEnvironmentDeletionOutcome | null;
    }> | null>(null);
    const current = React.useRef({ options, scope });
    current.current = { options, scope };
    const outcome = isCurrent && state?.scope === scope ? state.outcome : null;
    const busy = isCurrent && state?.scope === scope && state.busy;
    const detail = isCurrent && options.snapshot.value?.environment.id === options.environmentId ? options.snapshot.value : null;
    const canDelete = options.snapshot.status === 'ready' && detail?.environment.capabilities.delete === true && options.actions !== null;
    const receipt = useDeploymentReceipt(options.controller, isCurrent ? options.environmentId : null,
        outcome?.kind === 'receipt' ? outcome.deploymentId : null, options.demand);
    React.useEffect(() => () => {
        if (flight.current?.scope === scope) { flight.current.controller.abort(); flight.current = null; }
    }, [scope]);

    async function run(effect: (actions: Actions, detail: DeploymentEnvironmentDetailV1, operation: UiActionOperation) =>
        Promise<DeploymentEnvironmentDeletionOutcome>, operation?: UiActionOperation,
    capability: 'delete' | 'manageTargets' = 'delete'): Promise<DeploymentEnvironmentDeletionOutcome> {
        const now = current.current;
        const refuse = (code: string): DeploymentEnvironmentDeletionOutcome => ({ kind: 'refused', reason: 'other', code });
        if (now.scope !== scope || !lifetime?.isCurrent()) return refuse('action_account_scope_changed');
        if (flight.current?.scope === scope) return refuse('action_in_progress');
        const value = now.options.snapshot.value;
        if (now.options.snapshot.status !== 'ready' || value?.environment.id !== scope.environmentId) {
            return refuse(now.options.snapshot.failure?.code ?? 'deployment_unavailable');
        }
        if (!value.environment.capabilities[capability]) return refuse('deployment_access_denied');
        if (!now.options.actions) return refuse('client_required');
        if (operation?.signal?.aborted) return refuse('cancelled');
        const controller = new AbortController();
        const abort = () => controller.abort();
        operation?.signal?.addEventListener('abort', abort, { once: true });
        if (operation?.signal?.aborted) controller.abort();
        flight.current = { scope, controller };
        setState({ scope, busy: true, outcome: null });
        try {
            controller.signal.throwIfAborted();
            let result: DeploymentEnvironmentDeletionOutcome;
            try { result = await effect(now.options.actions, value, { ...operation, signal: controller.signal }); }
            catch (error) { result = readDeploymentActionError(error); }
            if (current.current.scope !== scope || !lifetime.isCurrent()) return refuse('action_account_scope_changed');
            if (controller.signal.aborted) result = refuse('cancelled');
            if (flight.current?.controller === controller) setState({ scope, busy: false, outcome: result });
            return result;
        } finally {
            operation?.signal?.removeEventListener('abort', abort);
            if (flight.current?.controller === controller) {
                flight.current = null;
                setState(previous => previous?.scope === scope ? { ...previous, busy: false } : previous);
            }
        }
    }

    function deleteEnvironment(choice: DeploymentEnvironmentDeleteChoice, operation?: UiActionOperation) {
        return run(async (actions, value, invoked) => {
            const result = await actions.deleteEnvironment({ environmentId: value.environment.id,
                expectedRevision: value.environment.revision, requestKey: operation?.actionRequestId ?? randomUUID(),
                ...(choice.kind === 'detachKeepRunning' ? { detachKeepRunning: true }
                    : { teardownDeploymentIds: [...choice.deploymentIds] }) }, invoked);
            return result.ok ? { kind: 'deleted', detached: result.detached } : readDeploymentActionResult(result);
        }, operation);
    }
    function unlink(targetLinkId: string, choice: DeploymentTargetUnlinkChoice, operation?: UiActionOperation) {
        return run(async (actions, value, invoked) => {
            const link = value.targetLinks.find(item => item.targetLink.id === targetLinkId)?.targetLink;
            if (!link) return { kind: 'refused', reason: 'other', code: 'deployment_unavailable' };
            const result = await actions.unlink({ environmentId: value.environment.id, expectedRevision: value.environment.revision,
                targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: operation?.actionRequestId ?? randomUUID(),
                ...(choice.kind === 'detachKeepRunning' ? { detachKeepRunning: true }
                    : choice.deploymentId ? { teardownDeploymentId: choice.deploymentId } : {}) }, invoked);
            return result.ok ? { kind: 'unlinked', targetLinkId: result.targetLinkId, detached: result.detached }
                : readDeploymentActionResult(result);
        }, operation);
    }
    /** The first runtime link: Happier's own server arm on one Machine; the Action owner authors its content. */
    function link(machine: DeploymentLinkMachine, operation?: UiActionOperation) {
        return run(async (actions, value, invoked) => {
            const result = await actions.link({ environmentId: value.environment.id, expectedRevision: value.environment.revision,
                targetId: 'own-server', role: 'runtime', machines: [{ machineId: machine.machineId, installationId: machine.installationId }],
                ...deploymentManagedRetention(machine.retention ?? 'alwaysOn'),
                requestKey: operation?.actionRequestId ?? randomUUID() }, invoked);
            return result.ok ? { kind: 'linked', targetLinkId: result.targetLinkId } : readDeploymentActionResult(result);
        }, operation, 'manageTargets');
    }
    /** Stop and remove is one admitted teardown; its owner also removes the Environment. */
    function stopAndRemove(targetLinkId: string | null, operation?: UiActionOperation) {
        return run(async (actions, value, invoked) => {
            const link = targetLinkId ?? value.environment.runtimeTargetLinkId ?? null;
            const torn = await actions.teardown({ environmentId: value.environment.id, reason: 'manual',
                ...(link ? { targetLinkId: link } : {}), requestKey: randomUUID(), removeEnvironment: true },
            { ...invoked, presentUserConfirmation: { actionId: 'deployments.teardown' } });
            if (torn.ok && 'environmentRemoved' in torn && torn.environmentRemoved === true) {
                return { kind: 'deleted', detached: false };
            }
            if (torn.ok && 'detached' in torn) return { kind: 'started' };
            return readDeploymentActionResult(torn);
        }, operation);
    }
    /** No fabricated resource inventory: the native owner must supply the exact prepared teardown operand. */
    function teardown(input: Parameters<Actions['teardown']>[0], operation?: UiActionOperation) {
        return run(async (actions, value, invoked) => {
            if (input.environmentId !== value.environment.id
                || 'expectedRevision' in input && input.expectedRevision !== value.environment.revision) {
                return { kind: 'refused', reason: 'other', code: 'deployment_conflict' };
            }
            const result = await actions.teardown(input, invoked);
            return result.ok && 'detached' in result
                ? { kind: 'unlinked', targetLinkId: result.targetLinkId, detached: result.detached }
                : readDeploymentActionResult(result);
        }, operation);
    }
    return { canDelete, busy, outcome, receipt: receipt.snapshot, refreshReceipt: receipt.refresh,
        canLink: options.snapshot.status === 'ready' && detail?.environment.capabilities.manageTargets === true
            && options.actions !== null,
        deleteEnvironment, unlink, teardown, stopAndRemove, link,
        cancel: () => { if (flight.current?.scope === scope) flight.current.controller.abort(); },
        clearOutcome: () => { if (current.current.scope === scope && !flight.current) setState(null); },
        review: {
            deleteSpec: getActionSpec('deployments.environments.delete'), unlinkSpec: getActionSpec('deployments.targets.unlink'),
            teardownSpec: getActionSpec('deployments.teardown'),
            volumeEffect: 'notTouchedByDisposition' as const,
            teardownPreparation: 'controllerPrepared' as const,
            retainedTargets: detail?.targetLinks.map(({ targetLink }) => ({ id: targetLink.id, role: targetLink.role,
                targetKind: targetLink.targetKind, state: targetLink.state, machines: targetLink.machines,
                activeDeploymentId: targetLink.activeDeploymentId ?? null })) ?? [],
            detach: { managementAndAlertsCease: true as const, runningSecretBytesMayRemain: true as const,
                rotateUpstreamToInvalidate: true as const, ongoingCosts: 'unknown' as const },
        },
    };
}
