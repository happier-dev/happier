import * as React from 'react';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { readMachinePresetRevisionsSnapshot, retainMachinePresets, subscribeMachinePresets } from '@/sync/engine/machines/machinePresetsResource';
import { useMachineField } from '@/sync/store/hooks';

export type MachineSetupPresetUpdateV1 =
  | Readonly<{ kind: 'changed'; presetId: string; presetRevision: number; setupRevision: number }>
  | Readonly<{ kind: 'unavailable'; presetId: string; reason: 'preset_not_found' | 'preset_archived' }>;

/**
 * The one decision whether a preset attached to this Machine moved on since the Machine applied it: the daemon's
 * observed `setupRevision` against the preset's current revision header. The Machine Setup tab and Team setup read it.
 */
export function useMachinePresetUpdates(input: Readonly<{ serverId: string; machineId: string; active: boolean }>):
  readonly MachineSetupPresetUpdateV1[] {
  const { serverId, machineId, active } = input;
  const observation = useMachineField(machineId, 'daemonState', 'setup', { serverId, enabled: active });
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const homeId = getServerProfileById(serverId)?.serverIdentityId ?? null;
  const hasAttachedPresets = observation?.attachedPresets?.some(source => source.kind === 'accountPreset') === true;
  React.useEffect(() => active && homeId && binding && hasAttachedPresets
    ? retainMachinePresets(binding, homeId, undefined, { projection: 'revisions' }) : undefined,
  [active, homeId, binding, hasAttachedPresets]);
  const subscribeRevisions = React.useCallback((listener: () => void) =>
    active && hasAttachedPresets ? subscribeMachinePresets([serverId], listener) : () => {},
  [active, hasAttachedPresets, serverId]);
  const readRevisions = React.useCallback(() => readMachinePresetRevisionsSnapshot(serverId, homeId ?? '', binding?.accountId),
    [serverId, homeId, binding?.accountId]);
  const revisions = React.useSyncExternalStore(subscribeRevisions, readRevisions, readRevisions);
  const previousPresetUpdates = React.useRef<readonly MachineSetupPresetUpdateV1[]>([]);
  const notices: MachineSetupPresetUpdateV1[] = [];
  if (active && revisions.value !== null) for (const source of observation?.attachedPresets ?? []) {
    if (source.kind !== 'accountPreset') continue;
    const header = revisions.value[source.presetId];
    if (!header || header.archivedAt !== undefined) notices.push({ kind: 'unavailable', presetId: source.presetId,
      reason: header ? 'preset_archived' : 'preset_not_found' });
    else if (source.setupRevision !== undefined && header.setupRevision > source.setupRevision) notices.push({
      kind: 'changed', presetId: source.presetId, presetRevision: header.revision, setupRevision: header.setupRevision,
    });
  }
  const presetUpdates = retainKeyedRows(previousPresetUpdates.current, notices, notice => notice.presetId);
  previousPresetUpdates.current = presetUpdates;
  return presetUpdates;
}
