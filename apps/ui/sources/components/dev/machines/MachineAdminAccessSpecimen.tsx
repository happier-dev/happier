import * as React from 'react';
import {
  presentMachineAuthorityV1,
  type MachineAuthorityInputV1,
} from '@happier-dev/protocol';

import {
  MachineAdminPowerView,
  type MachineAdminPowerControls,
  type MachineAuthorityModel,
} from '@/components/machines/security/MachineAdminPowerSection';
import {
  describeAdminAccessPreauthorization,
  type AdminAccessPreauthorizationRead,
} from '@/components/machines/security/adminPower';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';

export type MachineAdminAccessSpecimenState =
  | 'denied'
  | 'reading'
  | 'failed'
  | 'allowed'
  | 'none';

type Observation = NonNullable<MachineAuthorityInputV1['observation']>;
const observation = (
  sudo: Observation['passwordlessSudoToRoot'],
): Observation =>
  ({
    version: 1,
    observedAt: 1,
    daemonUid: 998,
    daemonUsername: 'happier',
    daemonPrimaryGroup: 'happier',
    daemonIdentity: 'nonRoot',
    rootEquivalentGroups: [],
    groupMembership: { state: 'current' },
    passwordlessSudoToRoot: sudo,
    managedDropIn: sudo === 'allowed' ? 'valid' : 'absent',
    tailscaledOperator: { authorization: 'unknown' },
    daemonService: { mode: 'system', startsAtBoot: true },
    daemonAccount: { passwordLocked: true, loginShell: '/usr/sbin/nologin' },
  }) as Observation;

const READS: Record<
  MachineAdminAccessSpecimenState,
  AdminAccessPreauthorizationRead
> = {
  denied: {
    checking: false,
    settled: {
      kind: 'read',
      issue: {
        cause: 'sudo_denied',
        remedy: {
          kind: 'console',
          where: 'target_machine_console',
          command: 'sudo visudo',
          sudoersRule: 'happier ALL=(ALL:ALL) NOPASSWD: ALL',
        },
      },
    },
  },
  reading: { checking: true, settled: null },
  failed: { checking: false, settled: { kind: 'failed', code: 'rpc_timeout' } },
  allowed: { checking: false, settled: { kind: 'read', issue: null } },
  none: { checking: false, settled: null },
  before: { checking: false, settled: null },
};

const noop = () => {};
const controls: MachineAdminPowerControls = {
  draftMode: null,
  draftUsername: '',
  onDraftMode: noop,
  onDraftUsername: noop,
  onSave: noop,
  onDiscard: noop,
  save: { kind: 'idle' },
  onOpenApproval: noop,
};

/**
 * Dev-only: Machine → Security → Administrator power through the real `MachineAdminPowerView`, with Preauthorized
 * saved while the Machine's sudo still asks for a password. `?state=denied|reading|failed|allowed|none|before`.
 */
export function MachineAdminAccessSpecimen(
  props: Readonly<{ state: MachineAdminAccessSpecimenState }>,
) {
  const mode = props.state === 'none' ? 'none' : 'preauthorized';
  const observed = observation(
    props.state === 'allowed' ? 'allowed' : 'denied',
  );
  const saved = { version: 1, mode } as const;
  const presentation = presentMachineAuthorityV1({
    freshness: 'current',
    observation: observed,
    desiredAdminAccess: saved,
    platform: 'linux',
    isolationPolicy: { enabled: false },
    isolation: { kind: 'disabled' },
  });
  const authority: MachineAuthorityModel = {
    ...presentation,
    observation: observed as MachineAuthorityModel['observation'],
  };
  const notice = describeAdminAccessPreauthorization({
    mode,
    observation: authority.observation,
    canManage: true,
    online: true,
    read: READS[props.state],
  });
  return (
    <ItemList>
      <PageHeader
        title="Security"
        description={`Specimen · administrator access · ${props.state}`}
      />
      <MachineAdminPowerView
        authority={authority}
        saved={saved}
        machineName="shop-prod"
        online
        canManage
        controls={controls}
        separateUsers={null}
        preauthorization={notice && props.state !== 'before' ? { notice, onCheckAgain: noop } : null}
      />
    </ItemList>
  );
}
