import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { MachineServiceAdoptInputV1Schema, MachineServiceAdoptResultV1Schema } from '../../../local/services/adoptionV1.js';
export * from '../../../local/services/adoptionV1.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';
import { RPC_METHODS } from '../../../rpc/methods.js';
import { actionInputServerId } from '../definition.js';

export const MACHINE_SERVICE_ADOPT_SPEC = {
  id: 'machines.services.adopt', title: 'Adopt a Compose project',
  description: 'Review a watched Compose project and create its Environment without changing the running project.',
  safety: 'danger', sideEffectClass: 'write', approval: { result: 'required' }, approvalScope: 'machine',
  approvalPolicy: { uiConfirmation: 'direct' }, executionPlacement: 'machine', placements: [],
  operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
  operationReentry: snapshot => MachineServiceAdoptResultV1Schema.safeParse(snapshot.result).data?.kind === 'partial' ? 'reinvoke' : 'replay',
  toolExposure: { agent: 'discoverable_only' },
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { rpcMethod: RPC_METHODS.MACHINES_SERVICE_ADOPT, mcpToolName: 'machines_services_adopt' },
  inputSchema: lazyZodSchema(() => MachineServiceAdoptInputV1Schema), outputSchema: lazyZodSchema(() => MachineServiceAdoptResultV1Schema),
  invocationServerIdForInput: actionInputServerId(MachineServiceAdoptInputV1Schema, input => input.serverId),
  cli: { acceptsServerId: true, commands: [{ path: ['machines', 'services', 'adopt'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
    { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
    { path: 'serviceId', title: 'Watched service', widget: 'text', required: true },
    { path: 'mode', title: 'Review or apply', widget: 'text', required: true },
    { path: 'profiles', title: 'Profiles to use from now on', widget: 'json', required: true },
  ] },
} as const satisfies PreNormalizedActionSpec;
