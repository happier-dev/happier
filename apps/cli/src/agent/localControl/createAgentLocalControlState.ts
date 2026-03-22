import type { AgentState } from '@/api/types';

type LocalControlTopology = NonNullable<NonNullable<AgentState['localControl']>['topology']>;

export function createAgentLocalControlState(params: Readonly<{
  attached: boolean;
  topology: LocalControlTopology;
  canAttach?: boolean;
  canDetach?: boolean;
  remoteWritable?: boolean;
}>): NonNullable<AgentState['localControl']> {
  const attached = params.attached === true;
  const topology = params.topology === 'shared' ? 'shared' : 'exclusive';
  return {
    attached,
    topology,
    remoteWritable: typeof params.remoteWritable === 'boolean' ? params.remoteWritable : (!attached || topology === 'shared'),
    canAttach: typeof params.canAttach === 'boolean' ? params.canAttach : !attached,
    canDetach: typeof params.canDetach === 'boolean' ? params.canDetach : attached,
  };
}
