import type { MachineServiceRowV1 } from '@happier-dev/protocol/actions/specs/machine/services';
import { t } from '@/text';

export function machineServiceKind(
  row: Pick<MachineServiceRowV1, 'authority' | 'environmentId' | 'nativeInstance'>,
): string | null {
  if (row.nativeInstance) return row.nativeInstance.adapter.localId;
  return row.authority === 'project' && row.environmentId ? 'compose' : null;
}

/** What the service is, from its producer's kind and native display name ("systemd · caddy.service"). */
export function machineServiceIdentityLine(row: Pick<MachineServiceRowV1, 'authority' | 'environmentId' | 'nativeInstance' | 'native'>): string | null {
  const kind = machineServiceKind(row);
  const parts = [
    kind === null ? null : kind === 'systemd' || kind === 'compose' ? t(`machineServices.kind.${kind}`) : kind,
    row.native?.displayName ?? null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}
