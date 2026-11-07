import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { describeMachineShareTrust } from '@/components/sharing/machines/machineShareTrust';

/** The Machine a setup review runs on, as the review names it; a teammate's shared Machine also names its OS user. */
export function useProjectSetupMachine(serverId: string | null, machineId: string | null) {
  const machine = useServerScopedMachine(serverId, machineId ?? '');
  const machineName = machine ? getMachineSentenceName(machine) : machineId ?? '';
  const isolation = machine?.daemonState?.agentIsolation;
  const { placement } = presentMachineAuthorityV1({ platform: machine?.metadata?.platform,
    isolationPolicy: machine?.metadata?.agentIsolation, isolation }).separateUsers;
  return {
    machineName,
    sharedRunAs: machine?.isShared
      ? placement === 'daemon' ? machine.metadata?.username ?? null
        : placement === 'sharedAgent' && isolation?.kind === 'effective' ? isolation.agentUser : null
      : null,
    sharedTrustDetail: machine?.isShared ? describeMachineShareTrust(placement, true, machineName).detail : null,
  };
}
