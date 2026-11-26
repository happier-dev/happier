import * as React from 'react';
import { View } from 'react-native';
import { isActionOutcomeUnknownErrorCodeV1, UNEXPECTED_ACTION_FAILURE_CODES_V1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AUTOMATION_EVENT_WATCHER_NOT_CURRENT, AUTOMATION_EVENT_WATCHER_NOT_OWNED } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { PluginUiActionFailureV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import type { PluginEventAutomationSetupSurfaceRefusal } from '@/components/automations/editor/presentPluginEventAutomationSetupSurface';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useMachineListForServer, useMachineListStatusForServer, useServerScopedMachine } from '@/sync/store/hooks';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { sync } from '@/sync/sync';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Settlement = Parameters<
  NonNullable<
    React.ComponentProps<typeof PluginEventAutomationEditor>['newSourceSetup']
  >['onSettled']
>[0];
type Configured = Extract<Settlement, { kind: 'configured' }>;

const NO_CHECK_MACHINE_CANDIDATES: readonly string[] = [];
const readMachineOwnership = (machine: Machine | null) => machine ? !machine.isShared : null;

/** The write owner's typed failure as this host says it: its reason sentence and whether the outcome is known. */
function presentAddCheckWriteFailure(failure: PluginUiActionFailureV1) {
  const unconfirmed = isActionOutcomeUnknownErrorCodeV1(failure.errorCode);
  const presentation = presentActionExecutionFailure(failure,
    t(unconfirmed ? 'errors.scmOutcomeUnknown' : 'common.requestFailed'), { closedCodesOnly: true });
  const reason = failure.errorCode === AUTOMATION_EVENT_WATCHER_NOT_OWNED
    ? t('projects.deployments.monitoring.addCheckCollectorOwnership')
    : failure.errorCode === AUTOMATION_EVENT_WATCHER_NOT_CURRENT
      ? t('workflows.problem.targetUnavailable')
      : presentation.reason;
  return { unconfirmed, presentation, reason };
}

/**
 * Add check (PAGE-ACCEPT-176 R10-D1): the check's own native form, opened directly on the Machine that runs it, as the
 * one surface. Its Save writes one observation-only trigger while the form stays open and busy; Cancel writes nothing.
 * A refused write goes back to the open form (R17-D3). While the form opens or cannot open, and after a write whose
 * outcome is unknown, this host says which, in place.
 */
export function AddCheckSetup(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    deploymentEnvironment: DeploymentEnvironmentRefV1;
    seed: PluginUiOpenAutomationEventRequestV1 | undefined;
    collectorPlacement?: boolean;
    onClose: () => void;
    testID: string;
  }>,
) {
  // Only a write that may have landed leaves the form: it cannot be corrected and saved again.
  const [unsettledWrite, setUnsettledWrite] = React.useState<PluginUiActionFailureV1 | null>(null);
  const save = useEventCallback(async (settlement: Configured): Promise<PluginEventAutomationSetupSurfaceRefusal | undefined> => {
    try {
      await addWorkflowTrigger(
        {
          trigger: settlement.trigger,
          observationOnly: { ...settlement.observationOnly, deploymentEnvironment: props.deploymentEnvironment },
        },
        { accountLifetime: props.lifetime },
      );
    } catch (error) {
      const workflow = error instanceof WorkflowActionError ? error : null;
      const failure = workflow?.failure ?? {
        ok: false as const, errorCode: workflow?.rawCode ?? UNEXPECTED_ACTION_FAILURE_CODES_V1[1],
        details: workflow?.rawDetails, requestId: workflow?.requestId,
      };
      const presented = presentAddCheckWriteFailure(failure);
      if (presented.unconfirmed || failure.effectAttempted === true) {
        setUnsettledWrite(failure);
        return undefined;
      }
      return { failure, reason: presented.reason };
    }
    fireAndForget(sync.refreshAutomations());
    props.onClose();
    return undefined;
  });
  const onSettled = useEventCallback((settlement: Settlement) => {
    if (settlement.kind !== 'cancelled') return save(settlement);
    props.onClose();
    return undefined;
  });
  const machineLabel = (machineName: string | null) =>
    machineName ?? t('machine.unnamedMachine');
  const collectorId = props.collectorPlacement ? props.seed?.monitoringMachineId : undefined;
  const serverId = props.lifetime.scope.serverId;
  const ownedCollector = useServerScopedMachine(serverId, collectorId, readMachineOwnership);
  const inventoryStatus = useMachineListStatusForServer(serverId);
  const needsOwnedMachine = Boolean(collectorId) && ownedCollector !== true;
  const inventory = useMachineListForServer(serverId, needsOwnedMachine, true, 'launch');
  const ownedMachineIds = React.useMemo(() => inventory
    ? inventory.filter(machine => !machine.isShared).map(machine => machine.id)
    : NO_CHECK_MACHINE_CANDIDATES, [inventory]);
  const presence = useMachinePresenceSummaries(serverId, ownedMachineIds, props.lifetime);
  const fallbackMachineId = ownedMachineIds[presence.findIndex(machine => machine.reachability === 'reachable')];
  const waitingForCollector = needsOwnedMachine && !fallbackMachineId && inventoryStatus === 'loading';
  const seed = React.useMemo(() => props.seed && fallbackMachineId
    ? { ...props.seed, monitoringMachineId: fallbackMachineId }
    : props.seed, [props.seed, fallbackMachineId]);
  const writeFailure = unsettledWrite && presentAddCheckWriteFailure(unsettledWrite);
  return (
    <View testID={props.testID}>
      {unsettledWrite && writeFailure ? (
        <SurfaceStateCard
          testID={`${props.testID}.failed`}
          size="line"
          kind="error"
          title={t(writeFailure.unconfirmed ? 'projects.deployments.stateUnknown' : 'projects.deployments.services.addCheckFailed')}
          reason={writeFailure.reason}
          diagnosticCode={unsettledWrite.errorCode}
          diagnosticDetail={writeFailure.presentation.technicalDetails
            .filter(line => line.key !== 'code').map(line => `${line.label} ${line.value}`).join('\n')}
          action={{ label: t('common.close'), onPress: props.onClose }}
        />
      ) : waitingForCollector ? (
        <SurfaceStateCard
          size="line"
          kind="loading"
          title={t('common.loading')}
        />
      ) : seed ? (
        <PluginEventAutomationEditor
          automationId="new"
          clientId="add-check"
          value={null}
          seed={null}
          serverId={props.lifetime.scope.serverId}
          authoringMachineId={seed.monitoringMachineId ?? null}
          newSourceSetup={{
            seed,
            // The sheet is named for what the person is doing, not the Event it enrolls ("Health status changed").
            heading: { title: t('projects.deployments.settingsSections.addCheck'), originLabel: t('projects.deployments.services.checkFrom') },
            onSettled,
            waitingTitle: (machineName, phase) => phase === 'applying'
              ? t('projects.deployments.services.addCheckSaving')
              : t('projects.deployments.services.addCheckOpening', {
                machine: machineLabel(machineName),
              }),
            renderUnavailable: (retry, machineName, failure) => {
              const presentation = failure && presentActionExecutionFailure({
                ok: false, errorCode: failure.reason, requestId: failure.requestId,
                message: failure.message, details: failure.details, effectAttempted: failure.effectAttempted,
                failureCause: failure.failureCause, remediation: failure.remediation,
              }, resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: failure.code }).body);
              return <SurfaceStateCard
                testID={`${props.testID}.unavailable`}
                size="line"
                kind="unavailable"
                title={t(
                  'projects.deployments.services.addCheckUnavailableOnMachine',
                  { machine: machineLabel(machineName) },
                )}
                reason={presentation?.reason}
                diagnosticCode={failure?.code}
                diagnosticDetail={presentation?.technicalDetails
                  .filter(line => line.key !== 'code').map(line => `${line.label} ${line.value}`).join('\n')}
                action={failure?.retryable === false
                  ? { label: t('common.close'), onPress: props.onClose }
                  : { label: t('common.retry'), onPress: retry }}
              />;
            },
          }}
          onComplete={() => {}}
          onCancel={props.onClose}
        />
      ) : (
        <SurfaceStateCard
          testID={`${props.testID}.unavailable`}
          size="line"
          kind="unavailable"
          title={t(
            'projects.deployments.services.addCheckUnavailableOnMachine',
            { machine: t('machine.unnamedMachine') },
          )}
        />
      )}
    </View>
  );
}
