import * as React from 'react';

import { MachineAddForm } from '@/components/machines/add/MachineAddForm';
import { MachineCreationContinuation, type MachineCreationContinuationDraft } from '@/components/machines/add/MachineCreationContinuation';
import { completeMachineAddWatch } from '@/components/machines/add/machineAddTaskLifetime';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/** The ordinary connection and creation owners return to the retained New app draft. */
export function NewAppMachineSetup(props: Readonly<{
  serverId: string;
  draft: MachineCreationContinuationDraft | null;
  onDraftChange: (draft: MachineCreationContinuationDraft) => void;
  onArrived: (machine: Readonly<{ machineId: string; serverId: string }>) => boolean;
  onCancel: () => void;
}>) {
  const accountScope = useServerCredentialAccountScopeBinding(props.serverId);
  const accountSettings = useManagedMachineAccountSettings(accountScope.binding, accountScope.resolution);
  const { onArrived } = props;
  const useMachine = React.useCallback((machine: Readonly<{ machineId: string; serverId: string }>) => {
    if (onArrived(machine)) completeMachineAddWatch();
  }, [onArrived]);
  return props.draft ? (
    <MachineCreationContinuation serverId={props.serverId} testID="newApp.machineCreation"
      draft={props.draft} onDraftChange={props.onDraftChange} onArrived={onArrived} onCancel={props.onCancel} />
  ) : (
    <MachineAddForm layout="page" testID="newApp.machineConnection" creationServerId={props.serverId}
      canCreate={accountSettings.settings?.managedMachineCreationEnabled === true}
      onSelectProvisioner={selection => props.onDraftChange({ kind: 'configuration', selection })}
      onClose={props.onCancel} onArrived={useMachine} onStartSession={useMachine} />
  );
}
