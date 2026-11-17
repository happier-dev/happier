import * as React from 'react';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectMachineSetupStepChecklist } from '@/components/inbox/actionOperations/actionOperationDetailPresentation';
import { MachineSetupRunRegion } from '@/components/machines/setup/MachineSetupRunRegion';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import {
  useActiveServerAccountScope,
  useAllMachines,
} from '@/sync/domains/state/storage';

export type MachineSetupRunSpecimenState =
  | 'running'
  | 'needs-you'
  | 'stopped'
  | 'done';

const OPERATION = 'machine-setup-run-specimen';
const label = (fallback: string) => ({ key: `specimen.${fallback}`, fallback });

/** The lab's Acme dev box run: Redis done, Postgres in progress (or waiting, or failed), the kept 1Password CLI last. */
function stepsFor(state: MachineSetupRunSpecimenState) {
  const postgres =
    state === 'done' ? 'succeeded' : state === 'stopped' ? 'failed' : 'running';
  return [
    {
      planIndex: 0,
      stepId: 'redis',
      label: label('Redis 7'),
      state: 'succeeded' as const,
      terminalId: 'specimen-redis-output',
    },
    {
      planIndex: 0,
      stepId: 'postgres',
      label: label('Postgres 16 → 17'),
      state: postgres,
      ...(state === 'stopped'
        ? { failureCause: 'foreign_effect_conflict' }
        : {}),
      terminalId: 'specimen-postgres-output',
    },
    {
      planIndex: 1,
      stepId: 'onepassword',
      label: label('Leave 1Password CLI installed'),
      state: state === 'done' ? ('succeeded' as const) : ('pending' as const),
    },
  ];
}

/**
 * Dev-only: the Machine Setup tab's run region (lab L7) through the real `MachineSetupRunRegion` and the real
 * operation store. `?state=running|needs-you|stopped|done`. The operation sits on one of this Home's Machines (an
 * offline one when there is one) so the live runtime keeps it; nothing here sends an Action, and the password field
 * answers nothing (do not type a real password).
 */
export function MachineSetupRunSpecimen(
  props: Readonly<{ state: MachineSetupRunSpecimenState }>,
) {
  const scope = useActiveServerAccountScope();
  const machineId = useAllMachines(
    (machines) =>
      (machines.find((machine) => !machine.active) ?? machines[0])?.id ?? null,
  );
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  React.useEffect(() => {
    if (!scope || !machineId) return;
    const now = Date.now();
    const terminal = props.state === 'stopped' || props.state === 'done';
    const snapshot = {
      version: 1,
      operationId: OPERATION,
      revision: Math.floor(now / 1000),
      actionId: 'machines.setup.apply',
      state:
        props.state === 'stopped'
          ? 'failed'
          : props.state === 'done'
            ? 'succeeded'
            : 'running',
      scope: { accountId: scope.accountId, machineId },
      title: 'Apply Acme dev box',
      createdAt: now - 95_000,
      startedAt: now - 94_000,
      cancellation: terminal ? 'unsupported' : 'supported',
      ...(terminal ? { settledAt: now - 2_000 } : {}),
      ...(props.state === 'stopped'
        ? {
            error: {
              errorCode: 'machine_setup_setup_failed',
              error: 'machine_setup_setup_failed',
            },
          }
        : {}),
      domainRef: {
        kind: 'machineSetup',
        serverId: scope.serverId,
        machineId,
        preset: { id: 'acme-dev-box', revision: 7 },
        steps: stepsFor(props.state),
        ...(props.state === 'needs-you'
          ? {
              setupTask: {
                id: 'specimen-task',
                taskKind: 'machine.setup.apply.v1',
                prompt: { kind: 'sudo.password', adminUsername: 'leeroy' },
              },
            }
          : {}),
      },
    } as ActionOperationSnapshotV1;
    actionOperationStore.mergeSnapshots({
      serverId: scope.serverId,
      snapshots: [snapshot],
    });
  }, [machineId, props.state, scope]);
  const operation = useActionOperation(
    scope ? { serverId: scope.serverId, operationId: OPERATION } : null,
  );
  const domainRef = operation?.snapshot.domainRef;
  const steps = React.useMemo(
    () =>
      domainRef?.kind === 'machineSetup'
        ? projectMachineSetupStepChecklist(domainRef, (value) =>
            localize('', value),
          )
        : null,
    [domainRef, localize],
  );
  return (
    <ItemList>
      <PageHeader
        title="Machine Setup run"
        description={`Specimen · ${props.state}`}
      />
      {operation && steps ? (
        <MachineSetupRunRegion
          serverId={operation.serverId}
          operation={operation}
          progressOperation={operation}
          steps={steps}
          machineName="devbox"
          onRetry={() => undefined}
        />
      ) : (
        <Text>Sign in to a Home with a Machine to see the run.</Text>
      )}
    </ItemList>
  );
}
