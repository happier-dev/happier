import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { MachineScheduledInputV1Schema, MachineScheduledResultV1Schema } from '../../machines/scheduled/scheduledV1.js';
import { MACHINE_SCHEDULED_ACTION_IDS } from '../../machines/scheduled/actionIdsV1.js';
import { actionInputServerId } from './definition.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

function specs() {
  return MACHINE_SCHEDULED_ACTION_IDS.map(id => ({
    id, title: id === 'machines.scheduled.list' ? 'Read Machine schedules' : 'Follow Machine schedules',
    description: 'Read a page of native schedules with independent source availability. Definitions remain on the Machine transport.',
    safety: 'safe', sideEffectClass: 'read', approval: { result: 'none' }, placements: [], executionPlacement: 'machine',
    toolExposure: { agent: 'discoverable_only' },
    surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: MachineScheduledInputV1Schema, outputSchema: MachineScheduledResultV1Schema,
    invocationServerIdForInput: actionInputServerId(MachineScheduledInputV1Schema, input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'scheduled', id === 'machines.scheduled.list' ? 'list' : 'watch'], visibility: 'canonical' }] },
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      { path: 'pageSize', title: 'Visible rows', widget: 'number', required: true },
      { path: 'offset', title: 'Page offset', widget: 'number' },
      { path: 'sinceRevision', title: 'Observed revision', widget: 'number' },
      { path: 'refresh', title: 'Refresh native sources', widget: 'boolean' },
    ] },
  } as const satisfies PreNormalizedActionSpec));
}
export const MACHINE_SCHEDULED_ACTION_SPECS: ReturnType<typeof specs> = lazyActionSpecArray(specs);
