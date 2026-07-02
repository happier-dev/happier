import type { AgentState } from '@/api/types';

type RuntimeSwitchTopology = NonNullable<NonNullable<AgentState['localControl']>['topology']>;

export function createAgentRuntimeSwitchState(params: Readonly<{
  attached: boolean;
  topology: RuntimeSwitchTopology;
  canAttach?: boolean;
  canDetach?: boolean;
  remoteWritable?: boolean;
}>): NonNullable<AgentState['localControl']> {
  const attached = params.attached === true;
  const topology = params.topology === 'shared' ? 'shared' : 'exclusive';
  return {
    attached,
    topology,
    remoteWritable: params.remoteWritable === true,
    canAttach: typeof params.canAttach === 'boolean' ? params.canAttach : !attached,
    canDetach: typeof params.canDetach === 'boolean' ? params.canDetach : attached,
  };
}
