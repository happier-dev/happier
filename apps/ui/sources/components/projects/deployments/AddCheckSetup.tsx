import * as React from 'react';
import { View } from 'react-native';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { addWorkflowTrigger } from '@/sync/domains/workflows/workflowTriggerActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Settlement = Parameters<
  NonNullable<
    React.ComponentProps<typeof PluginEventAutomationEditor>['newSourceSetup']
  >['onSettled']
>[0];
type Configured = Extract<Settlement, { kind: 'configured' }>;

/**
 * Add check (PAGE-ACCEPT-176 R10-D1): the check's own native form, opened directly on the Machine that runs it, as the
 * one surface. Its Save writes one observation-only trigger; Cancel writes nothing. While the form opens, saves or
 * cannot open, this host says which, in place.
 */
export function AddCheckSetup(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    seed: PluginUiOpenAutomationEventRequestV1 | undefined;
    onClose: () => void;
    testID: string;
  }>,
) {
  const [write, setWrite] = React.useState<Readonly<{
    settlement: Configured;
    status: 'saving' | 'failed';
  }> | null>(null);
  const save = useEventCallback(async (settlement: Configured) => {
    setWrite({ settlement, status: 'saving' });
    try {
      await addWorkflowTrigger(
        {
          trigger: settlement.trigger,
          observationOnly: settlement.observationOnly,
        },
        { accountLifetime: props.lifetime },
      );
    } catch {
      setWrite({ settlement, status: 'failed' });
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
  return (
    <View testID={props.testID}>
      {write?.status === 'saving' ? (
        <SurfaceStateCard
          size="line"
          kind="loading"
          title={t('projects.deployments.services.addCheckSaving')}
        />
      ) : write?.status === 'failed' ? (
        <SurfaceStateCard
          testID={`${props.testID}.failed`}
          size="line"
          kind="error"
          title={t('projects.deployments.services.addCheckFailed')}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void save(write.settlement);
            },
          }}
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
            heading: { title: t('projects.deployments.settingsSections.addCheck') },
            onSettled,
            waitingTitle: (machineName, phase) => phase === 'applying'
              ? t('projects.deployments.services.addCheckSaving')
              : t('projects.deployments.services.addCheckOpening', {
                machine: machineLabel(machineName),
              }),
            renderUnavailable: (retry, machineName, failure) => {
              const presentation = failure && presentActionExecutionFailure({
                ok: false, errorCode: failure.reason, requestId: failure.requestId,
                message: failure.message, effectAttempted: failure.effectAttempted,
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
