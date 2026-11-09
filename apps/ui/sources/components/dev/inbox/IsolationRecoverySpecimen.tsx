import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineAgentIsolationPreviewResultV1Schema } from '@happier-dev/protocol/machines/agentIsolationV1';

import { Text } from '@/components/ui/text/Text';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';

/**
 * Dev-only: the Action-operation detail of an Agent isolation change that settled "not confirmed", over the
 * state the reconnect CHECK found. `?state=needs|satisfied|off|applying|unavailable|pending|effective` (`pending`: qualification pending, so Apply again; `effective`: admitted roots, satisfied, no retry); `?state=held` is the held review itself
 * (what Approve and apply decides). Do not press Approve on a live Machine: it submits the real Action. The live runtime only keeps
 * operations of this Home's own Machines, so the operation sits on one (an offline one when there is one, so the
 * modal's own CHECK has nothing to ask) and shows the CHECK's published answer, or "can't check" when there is none.
 * The pending state is covered by the modal test.
 */
const OPERATION = 'isolation-recovery-specimen';

const plan = (digest: string, roots: readonly string[]) => ({
  roots: roots.map((path, index) => ({ rootId: `root-${index}`, path, changes: ['group', 'gitShared'] as const })),
  ancestorAcls: roots.length > 0 ? [{ path: '/srv', add: 'x' as const }] : [],
  sessionsToReplace: roots.length > 0 ? 2 : 0,
  requiresAdmin: roots.length > 0,
  planDigest: digest,
});

/** The CHECK answers S0-FX-RECOVER registered: admitted roots stay listed as inventory, only the status differs. */
const ADMITTED_ROOTS = { roots: [{ rootId: 'checkout', path: '/srv/happier/checkout', changes: [] as const }],
  ancestorAcls: [{ path: '/srv/happier', add: 'x' as const }], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'native-check-digest' };

function recoveryFor(state: string) {
  if (state === 'unavailable') return null;
  if (state === 'pending') {
    return { enabled: true, preview: MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled: true }, metadataVersion: 5,
      status: { kind: 'unavailable', code: 'provisioning_unavailable' }, plan: ADMITTED_ROOTS }) };
  }
  if (state === 'effective') {
    return { enabled: true, preview: MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled: true }, metadataVersion: 5,
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, plan: ADMITTED_ROOTS }) };
  }
  if (state === 'needs') {
    return { enabled: true, preview: MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled: false }, metadataVersion: 7,
      status: { kind: 'enable_required', reason: 'existing_machine_workspace_migration' }, plan: plan('digest-needs', ['/srv/shop', '/srv/site']) }) };
  }
  if (state === 'applying') {
    return { enabled: true, preview: MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled: true }, metadataVersion: 8,
      status: { kind: 'applying', phase: 'runtime_replacement' }, plan: plan('digest-applying', []) }) };
  }
  const enabled = state !== 'off';
  return { enabled, preview: MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled }, metadataVersion: 8,
    status: enabled ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } : { kind: 'disabled' }, plan: plan('digest-done', []) }) };
}

export function IsolationRecoverySpecimen(props: Readonly<{ state: string }>) {
  const scope = useActiveServerAccountScope();
  const machineId = useAllMachines(machines => (machines.find(machine => !machine.active) ?? machines[0])?.id ?? null);
  React.useEffect(() => {
    if (!scope || !machineId) return;
    const { serverId, accountId } = scope;
    const now = Date.now();
    const held = props.state === 'held';
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1, operationId: OPERATION, requestId: 'request-original',
      revision: 2, actionId: 'machines.agentIsolation.set', state: 'running', scope: { accountId, machineId },
      title: 'Change Agent isolation', createdAt: now - 95_000, startedAt: now - 94_000, cancellation: 'unsupported',
      observation: held
        ? { kind: 'review_required', code: 'agent_isolation_effect_changed', machineId, enabled: true,
          current: MachineAgentIsolationPreviewResultV1Schema.parse({ kind: 'ready', policy: { enabled: false }, metadataVersion: 7,
            status: { kind: 'enable_required', reason: 'existing_machine_workspace_migration' }, plan: plan('digest-held', ['/srv/shop', '/srv/site', '/srv/infra']) }) }
        : { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } } as ActionOperationSnapshotV1] });
    const recovery = held ? null : recoveryFor(props.state);
    if (recovery) actionOperationStore.reobserveMachineAgentIsolation({ serverId, accountId, machineId, operationId: OPERATION, recovery });
    openActionOperationDetail({ serverId, operationId: OPERATION });
  }, [machineId, props.state, scope]);
  return <View style={styles.page}><Text>Agent isolation recovery specimen: {props.state}</Text></View>;
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, padding: theme.space.s20 },
}));
