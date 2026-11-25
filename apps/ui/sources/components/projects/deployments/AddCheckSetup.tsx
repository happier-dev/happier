import * as React from 'react';
import { View } from 'react-native';
import { isActionOutcomeUnknownErrorCodeV1, UNEXPECTED_ACTION_FAILURE_CODES_V1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AUTOMATION_EVENT_WATCHER_NOT_CURRENT, AUTOMATION_EVENT_WATCHER_NOT_OWNED } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { PluginUiActionFailureV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useMachineListStatusForServer, useServerScopedMachine } from '@/sync/store/hooks';
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

const readMachineOwnership = (machine: Machine | null) => machine ? !machine.isShared : null;

/**
 * Add check (PAGE-ACCEPT-176 R10-D1): the check's own native form, opened directly on the Machine that runs it, as the
 * one surface. Its Save writes one observation-only trigger; Cancel writes nothing. While the form opens, saves or
 * cannot open, this host says which, in place.
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
  const [write, setWrite] = React.useState<
    | { status: 'saving' }
    | { status: 'failed'; settlement: Configured; failure: PluginUiActionFailureV1 }
    | null
  >(null);
  const save = useEventCallback(async (settlement: Configured) => {
    setWrite({ status: 'saving' });
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
      setWrite({ settlement, status: 'failed', failure });
      return;
    }
    fireAndForget(sync.refreshAutomations());
    props.onClose();
  });
  const onSettled = useEventCallback((settlement: Settlement) => {
    if (settlement.kind === 'cancelled') props.onClose();
    else void save(settlement);
  });
  const machineLabel = (machineName: string | null) =>
    machineName ?? t('machine.unnamedMachine');
  const seed = props.seed;
  const collectorId = props.collectorPlacement ? seed?.monitoringMachineId : undefined;
  const serverId = props.lifetime.scope.serverId;
  const ownedCollector = useServerScopedMachine(serverId, collectorId, readMachineOwnership);
  const inventoryStatus = useMachineListStatusForServer(serverId);
  const collectorRefused = collectorId && (ownedCollector === false || (ownedCollector === null && inventoryStatus === 'idle'));
  const waitingForCollector = collectorId && ownedCollector === null && inventoryStatus === 'loading';
  const failedWrite = write?.status === 'failed' ? write : null;
  const unconfirmed = isActionOutcomeUnknownErrorCodeV1(failedWrite?.failure.errorCode);
  const writeFailure = failedWrite && presentActionExecutionFailure(failedWrite.failure,
    t(unconfirmed ? 'errors.scmOutcomeUnknown' : 'common.requestFailed'), { closedCodesOnly: true });
  const writeReason = failedWrite?.failure.errorCode === AUTOMATION_EVENT_WATCHER_NOT_OWNED
    ? t('projects.deployments.monitoring.addCheckCollectorOwnership')
    : failedWrite?.failure.errorCode === AUTOMATION_EVENT_WATCHER_NOT_CURRENT
      ? t('workflows.problem.targetUnavailable')
      : writeFailure?.reason;
  return (
    <View testID={props.testID}>
      {write?.status === 'saving' ? (
        <SurfaceStateCard
          size="line"
          kind="loading"
          title={t('projects.deployments.services.addCheckSaving')}
        />
      ) : failedWrite && writeFailure ? (
        <SurfaceStateCard
          testID={`${props.testID}.failed`}
          size="line"
          kind="error"
          title={t(unconfirmed ? 'projects.deployments.stateUnknown' : 'projects.deployments.services.addCheckFailed')}
          reason={writeReason}
          diagnosticCode={failedWrite.failure.errorCode}
          diagnosticDetail={writeFailure.technicalDetails
            .filter(line => line.key !== 'code').map(line => `${line.label} ${line.value}`).join('\n')}
          action={unconfirmed || failedWrite.failure.effectAttempted === true
            ? { label: t('common.close'), onPress: props.onClose }
            : { label: t('common.retry'), onPress: () => { void save(failedWrite.settlement); } }}
        />
      ) : collectorRefused ? (
        <SurfaceStateCard
          testID={`${props.testID}.collector-refused`}
          size="line"
          kind="unavailable"
          title={t('projects.deployments.services.addCheckFailed')}
          reason={t(ownedCollector === false ? 'projects.deployments.monitoring.addCheckCollectorOwnership' : 'workflows.problem.targetUnavailable')}
          diagnosticCode={ownedCollector === false ? AUTOMATION_EVENT_WATCHER_NOT_OWNED : AUTOMATION_EVENT_WATCHER_NOT_CURRENT}
          accessibilitySemantics="alert"
          action={{ label: t('common.close'), onPress: props.onClose }}
        />
      ) : waitingForCollector ? (
        <SurfaceStateCard
          size="line"
          kind="loading"
          title={t('common.loading')}
        />
      ) : seed && (!collectorId || ownedCollector === true) ? (
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
