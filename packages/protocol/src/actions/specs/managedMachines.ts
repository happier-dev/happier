import {
  MANAGED_MACHINE_ACTION_IDS_V1,
  ManagedMachineActionInputSchemasV1,
  ManagedMachineActionOutputSchemasV1,
  managedMachineActionEndpointPathV1,
  type ManagedMachineActionIdV1,
} from '../../machines/managed/actionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const titles: Record<ManagedMachineActionIdV1, string> = {
  'machines.provisioners.list': 'List machine provisioners',
  'machines.provisioners.check': 'Check machine provisioner',
  'machines.provisioners.options': 'Get machine provisioner choices',
  'machines.managed.acquire': 'Create managed machine',
  'machines.managed.list': 'List managed machines',
  'machines.managed.get': 'Get managed machine',
  'machines.managed.references.get': 'Review managed machine dependencies',
  'machines.managed.inspect': 'Check managed machine now',
  'machines.managed.bootstrap.retry': 'Retry Happier installation',
  'machines.managed.cancel': 'Cancel managed machine creation',
  'machines.managed.power.set': 'Change machine power',
  'machines.managed.rebuild': 'Rebuild Dev Container',
  'machines.managed.retention.update': 'Change when a machine stops',
  'machines.managed.delete': 'Delete managed machine',
  'machines.managed.controller.update': 'Move machine management',
  'machines.managed.retire': 'Hide managed machine with manual responsibility',
};

export const MANAGED_MACHINE_ACTION_SPECS = MANAGED_MACHINE_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
  const effect = actionId === 'machines.managed.acquire'
    || actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.cancel'
    || ['machines.managed.power.set', 'machines.managed.rebuild', 'machines.managed.retention.update', 'machines.managed.delete', 'machines.managed.controller.update', 'machines.managed.retire'].includes(actionId);
  const account = actionId === 'machines.provisioners.list'
    || actionId === 'machines.managed.list' || actionId === 'machines.managed.get'
    || actionId === 'machines.managed.cancel' || actionId === 'machines.managed.references.get';
  return {
    id: actionId,
    title: titles[actionId],
    description: actionId === 'machines.managed.acquire'
      ? 'Create compute and install Happier using the reviewed selection on the exact Home and controller.'
      : actionId === 'machines.managed.bootstrap.retry'
        ? 'Retry installation on the same managed resource using its current enrollment attempt.'
        : actionId === 'machines.managed.cancel'
          ? 'Cancel the admitted creation request and retain the resulting resource cleanup disposition.'
          : effect ? `${titles[actionId]} on the retained resource through current approval and controller admission; acceptance does not confirm a native effect.`
            : `${titles[actionId]} on the exact Home without starting or waking compute.`,
    safety: effect ? 'danger' : 'safe',
    sideEffectClass: effect ? 'danger' : 'read',
    executionPlacement: account ? 'account' : 'machine',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), rpcMethod: actionId },
    cli: { acceptsServerId: true, commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputHints: { title: titles[actionId], fields: [] },
    inputSchema: ManagedMachineActionInputSchemasV1[actionId],
    outputSchema: ManagedMachineActionOutputSchemasV1[actionId],
    // This requester-private census is assembled by the Account's existing
    // readers; it has no server endpoint that could read E2EE references.
    ...(actionId === 'machines.managed.references.get' ? {} : {
      serverTransport: { method: 'POST' as const, path: managedMachineActionEndpointPathV1(actionId) },
    }),
    ...(effect ? { operation: {
      version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
    } as const } : {}),
  };
});
