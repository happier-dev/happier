import { readRecord } from '../../inputs/inputRecords.js';
import type { ApprovalActionReference } from '../actionApprovalPresentation.js';

/** Home, Team, and Group defaults share the same placement document. */
export function readDefaultsPlacementApprovalReference(
  path: string, value: unknown, parent: unknown,
): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const placement = /^(?:sessionDefaults|managedDefaults\.(?:team|groups\.\[\]\.defaults)|managedGroupDefaults\.defaults)\.placement\.(.+)$/.exec(path)?.[1];
  if (!placement) return undefined;
  const id = value.trim();
  const { kind, homeId, serverId } = readRecord(parent);
  if (placement === 'presetId' && kind === 'preset' && typeof homeId === 'string') {
    return { kind: 'machinePreset', id, homeId };
  }
  if (placement === 'homeId' || placement === 'target.serverId' || placement === 'projectFilesSource.target.serverId') {
    return { kind: 'home', id, unavailableWithoutName: true };
  }
  if ((placement === 'target.machineId' || placement === 'projectFilesSource.target.machineId') && typeof serverId === 'string') {
    return { kind: 'machine', id, serverId, unavailableWithoutName: true };
  }
}
