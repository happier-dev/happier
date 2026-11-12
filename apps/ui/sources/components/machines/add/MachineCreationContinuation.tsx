import * as React from 'react';
import { View } from 'react-native';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { MachineProvisionerPicker, type ManagedProvisionerSelection } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { ManagedMachineSections } from '@/components/settings/machines/managed/ManagedMachineSections';
import { ManagedMachineReadApprovalNotice } from '@/components/settings/machines/managed/ManagedMachineReadApprovalNotice';
import { managedCreationSetup, managedMachineEnrolledDetailId } from '@/components/settings/machines/managed/managedCreationPresentation';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

const SERVER_ENROLLMENT_IDENTITY = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
  role: 'server', adminAccessAtCreation: 'preauthorized' } as const satisfies ManagedMachineEnrollmentIdentityV1;

export type MachineCreationContinuationDraft = Readonly<{ kind: 'configuration'; selection: ManagedProvisionerSelection }>
  | Readonly<{ kind: 'created'; serverId: string; managedId: string }>;

/** A retained caller hosts the ordinary Machine creation and recovery owners, then uses the exact result. */
export function MachineCreationContinuation(props: Readonly<{
  serverId: string;
  testID: string;
  onArrived: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
  onCancel: () => void;
  draft: MachineCreationContinuationDraft | null;
  onDraftChange: (draft: MachineCreationContinuationDraft) => void;
}>) {
  const selection = props.draft?.kind === 'configuration' ? props.draft.selection : null;
  const created = props.draft?.kind === 'created' ? props.draft : null;
  return <View testID={props.testID}>
    {!selection ? <ItemGroup><Item testID={`${props.testID}.back`} title={t('common.back')} onPress={props.onCancel} /></ItemGroup> : null}
    {created ? <CreatedMachineContinuation {...props} created={created} /> : selection
      ? <ManagedMachineConfigurationView serverId={selection.serverId} provisioner={selection.provisioner}
          initialController={selection.controller} initialConnectPurpose={selection.connectPurpose}
          initialEnrollmentIdentity={SERVER_ENROLLMENT_IDENTITY}
          onCancel={props.onCancel} onCreated={machine => props.onDraftChange({ kind: 'created', ...machine })} />
      : <MachineProvisionerPicker serverId={props.serverId} onSelectProvisioner={selection => props.onDraftChange({ kind: 'configuration', selection })} />}
  </View>;
}

function CreatedMachineContinuation(props: Readonly<{
  created: Readonly<{ serverId: string; managedId: string }>;
  testID: string;
  onArrived: (machine: Readonly<{ machineId: string; serverId: string }>) => void;
}>) {
  const { created } = props;
  const serverId = resolveServerProfileScopeIdForIdentifier(created.serverId) || created.serverId;
  const serverIds = React.useMemo(() => [serverId], [serverId]);
  const inventory = useManagedMachineInventory(serverIds, created.managedId);
  const entry = inventory.entries[serverId];
  const [error, setError] = React.useState<string | null>(null);
  const machine = !error && entry?.status !== 'denied' && entry?.status !== 'missing' ? entry?.machines[0] : undefined;
  const enrolled = useServerScopedMachine(serverId, machine?.enrolledMachineId, Boolean);
  const enrolledId = machine && entry?.status === 'ready' && !error ? managedMachineEnrolledDetailId(machine, enrolled) : undefined;
  const setup = machine ? managedCreationSetup(machine) : null;
  // The setup owner settles independently of enrollment; failure stays here with its exact-resource repair.
  const canContinue = Boolean(enrolledId && (!setup || setup.state === 'succeeded' || setup.state === 'skipped'));
  return <>
    <ManagedMachineReadApprovalNotice serverId={serverId} entry={entry} />
    {machine ? <ManagedMachineSections machine={machine} serverId={serverId}
      binding={inventory.bindings.get(serverId)} current={entry?.status === 'ready'} executeAction={inventory.executeAction}
      onChanged={inventory.refresh} onDenied={setError}
      {...(entry?.status === 'error' ? { staleRead: { retry: inventory.refresh } } : {})} />
      : error ? null : <SurfaceStateCard testID={`${props.testID}.resource`} kind={inventory.loading ? 'loading' : 'unavailable'}
          title={t(inventory.loading ? 'common.loading' : 'managedMachines.detail.loadFailed')}
          diagnosticCode={entry?.errorCode}
          action={inventory.loading ? undefined : { label: t('common.retry'), onPress: inventory.refresh }} />}
    {error ? <SurfaceStateCard kind="error" title={t('managedMachines.detail.loadFailed')} diagnosticCode={error}
      action={{ label: t('common.retry'), onPress: () => { setError(null); inventory.refresh(); } }} /> : null}
    {canContinue ? <ItemGroup><Item testID={`${props.testID}.continue`} title={t('common.continue')}
      onPress={() => props.onArrived({ serverId: created.serverId, machineId: enrolledId! })} /></ItemGroup> : null}
  </>;
}
