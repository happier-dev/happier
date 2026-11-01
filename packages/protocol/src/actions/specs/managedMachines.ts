import { MACHINE_PRESET_INPUT_FIELDS, MACHINE_POOL_INPUT_FIELDS } from './machineInputHints.js';
import { MACHINE_POOL_ACTION_IDS_V1, MachinePoolActionInputSchemasV1, MachinePoolActionOutputSchemasV1, machinePoolActionEndpointPathV1, type MachinePoolActionIdV1 } from '../../machines/pools/actionsV1.js';
import { MACHINE_PRESET_ACTION_IDS_V1, MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1, machinePresetActionEndpointPathV1 } from '../../machines/managed/machinePresetActionsV1.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1, EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1, EphemeralRunnerActionInputSchemasV1, EphemeralRunnerActionOutputSchemasV1, type EphemeralRunnerActionIdV1 } from '../../ephemeralRunner/actionsV1.js';
import {
  MANAGED_MACHINE_ACTION_IDS_V1,
  ManagedMachineActionInputSchemasV1,
  ManagedMachineActionOutputSchemasV1,
  managedMachineActionEndpointPathV1,
  type ManagedMachineActionIdV1,
} from '../../machines/managed/actionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { MANAGED_MACHINE_INPUT_FIELDS } from './machineInputHints.js';

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
  'machines.managed.setup.skip': 'Continue without setup',
  'machines.setup.plan': 'Review machine setup',
  'machines.setup.apply': 'Apply machine setup',
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
    || actionId === 'machines.setup.apply' || actionId === 'machines.managed.setup.skip'
    || actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.cancel'
    || ['machines.managed.power.set', 'machines.managed.rebuild', 'machines.managed.retention.update', 'machines.managed.delete', 'machines.managed.controller.update', 'machines.managed.retire'].includes(actionId);
  const account = actionId === 'machines.provisioners.list'
    || actionId === 'machines.managed.list' || actionId === 'machines.managed.get'
    || actionId === 'machines.managed.cancel' || actionId === 'machines.managed.references.get' || actionId === 'machines.managed.setup.skip';
  return {
    id: actionId, approval: { result: 'required' }, originalExecution: { terminalRoot: 'allowed' },
    ...(actionId === 'machines.managed.acquire' || actionId === 'machines.managed.bootstrap.retry'
      || actionId === 'machines.managed.power.set'
      || actionId === 'machines.managed.retention.update' || actionId === 'machines.managed.controller.update'
      || actionId === 'machines.managed.setup.skip'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } }
      : effect ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
    title: titles[actionId],
    ...(actionId === 'machines.setup.apply' ? { approvalScope: 'machine' as const } : {}),
    ...({
      'machines.managed.bootstrap.retry': { confirmVerb: { key: 'common.retry', fallback: 'Retry' } },
      // Its own words, not "Cancel": the dialog's dismiss button already says Cancel.
      'machines.managed.cancel': { confirmVerb: { key: 'managedMachines.actions.cancelCreation', fallback: 'Cancel creation' } },
      'machines.setup.apply': { confirmVerb: { key: 'common.run', fallback: 'Run' } },
      'machines.managed.rebuild': { confirmVerb: { key: 'common.update', fallback: 'Update' } },
      'machines.managed.delete': { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true },
      'machines.managed.retire': { confirmVerb: { key: 'common.remove', fallback: 'Remove' } },
    } as Partial<Record<typeof actionId, Pick<PreNormalizedActionSpec, 'confirmVerb' | 'irreversible'>>>)[actionId],
    description: actionId === 'machines.managed.acquire'
      ? 'Create compute and install Happier using the reviewed selection on the exact Home and controller.'
      : actionId === 'machines.managed.bootstrap.retry'
        ? 'Retry installation on the same managed resource using its current enrollment attempt.'
        : actionId === 'machines.managed.cancel'
          ? 'Cancel the admitted creation request and retain the resulting resource cleanup disposition.'
          : actionId === 'machines.setup.apply'
            ? 'Apply the reviewed setup sources on the exact Machine through current approval and native admission; acceptance does not confirm a native effect.'
          : effect ? `${titles[actionId]} on the retained resource through current approval and controller admission; acceptance does not confirm a native effect.`
            : `${titles[actionId]} on the exact Home without starting or waking compute.`,
    safety: effect ? 'danger' : 'safe',
    sideEffectClass: effect ? 'danger' : 'read',
    executionPlacement: account ? 'account' : 'machine',
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_'), rpcMethod: actionId },
    cli: { acceptsServerId: true, commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputHints: { title: titles[actionId], fields: MANAGED_MACHINE_INPUT_FIELDS[actionId] },
    inputSchema: ManagedMachineActionInputSchemasV1[actionId],
    outputSchema: ManagedMachineActionOutputSchemasV1[actionId],
    // This requester-private census is assembled by the Account's existing
    // readers; it has no server endpoint that could read E2EE references.
    ...(actionId === 'machines.managed.references.get' || actionId === 'machines.setup.plan' || actionId === 'machines.setup.apply' ? {} : {
      serverTransport: { method: 'POST' as const, path: managedMachineActionEndpointPathV1(actionId) },
    }),
    ...(effect ? { operation: {
      version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
    } as const } : {}),
    ...(actionId === 'machines.managed.acquire' ? { operationReentry: (snapshot) => (
      snapshot.state === 'running' && snapshot.observation?.kind === 'outcome_uncertain' ? 'reinvoke'
        : snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'replay' : 'refuse'
    ) } : actionId === 'machines.managed.bootstrap.retry' ? { operationReentry: (snapshot) => (
      snapshot.observation?.kind === 'outcome_uncertain' || snapshot.state === 'failed' || snapshot.state === 'cancelled' ? 'fresh'
        : snapshot.state === 'succeeded' ? 'replay' : 'refuse'
    ) } : {}),
  };
});


export const MACHINE_PRESET_ACTION_SPECS = Object.freeze([
  ...(MACHINE_PRESET_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const verb = id.slice('machines.presets.'.length);
    const read = id === 'machines.presets.list' || id === 'machines.presets.get';
    const title = `${verb[0]!.toUpperCase()}${verb.slice(1)} Machine preset`;
    return {
      id, approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'direct' }, title, description: `${title} on the exact authenticated Home. Preset changes affect future machines only.`,
      safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'danger', placements: [],
      bindings: { mcpToolName: `machines_presets_${verb}`, voiceClientToolName: `machines_presets_${verb}` },
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
      cli: { acceptsServerId: true, commands: [{ path: ['machines', 'presets', verb], visibility: 'canonical' }] },
      inputHints: { title, fields: MACHINE_PRESET_INPUT_FIELDS[id] },
      inputSchema: MachinePresetActionInputSchemasV1[id], outputSchema: MachinePresetActionOutputSchemasV1[id],
      serverTransport: { method: 'POST', path: machinePresetActionEndpointPathV1(id) },
    };
  }) satisfies readonly PreNormalizedActionSpec[]),
] as const);


export const EPHEMERAL_RUNNER_ACTION_SPECS = Object.freeze([
  ...(EPHEMERAL_RUNNER_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const titles: Record<EphemeralRunnerActionIdV1, string> = {
      'sessions.runner.activation.create': 'Create Temporary computer request',
      'sessions.runner.activation.get': 'Get Temporary computer request',
      'sessions.runner.activation.cancel': 'Cancel Temporary computer request',
    };
    const isRead = actionId === 'sessions.runner.activation.get';
    return {
      id: actionId, approval: isRead ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
      title: titles[actionId],
      description: `${titles[actionId]} on the exact authenticated Home.`,
      safety: actionId === 'sessions.runner.activation.cancel' ? 'danger' : 'safe',
      sideEffectClass: isRead ? 'read' : actionId === 'sessions.runner.activation.cancel' ? 'danger' : 'write',
      placements: [],
      bindings: {},
      surfaces: { ui: true, voice: false, agent: false, mcp: false, cli: false, rpc: false },
      inputHints: { title: titles[actionId], fields: [] },
      inputSchema: EphemeralRunnerActionInputSchemasV1[actionId],
      outputSchema: EphemeralRunnerActionOutputSchemasV1[actionId],
      serverTransport: EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1[actionId],
    };
  }) satisfies readonly PreNormalizedActionSpec[]),
] as const);


export const MACHINE_POOL_ACTION_SPECS = Object.freeze([
  ...(MACHINE_POOL_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const verb = actionId.slice('machines.pools.'.length);
    const isDelete = actionId === 'machines.pools.delete';
    const isRead = actionId === 'machines.pools.list'
      || actionId === 'machines.pools.get'
      || actionId === 'machines.pools.resolve';
    const titles: Record<MachinePoolActionIdV1, string> = {
      'machines.pools.list': 'List Machine Pools',
      'machines.pools.get': 'Get Machine Pool',
      'machines.pools.create': 'Create Machine Pool',
      'machines.pools.update': 'Update Machine Pool',
      'machines.pools.delete': 'Delete Machine Pool',
      'machines.pools.resolve': 'Resolve Machine Pool target',
    };
    return {
      id: actionId, approval: isRead ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
      ...(isDelete ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
      ...(isDelete ? { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true as const } : {}),
      title: titles[actionId],
      description: `${titles[actionId]} on the authenticated Home.`,
      safety: isDelete ? 'danger' : 'safe',
      sideEffectClass: isDelete ? 'danger' : isRead ? 'read' : 'write',
      placements: [],
      bindings: { mcpToolName: `machines_pools_${verb}` },
      surfaces: {
        ui: true,
        voice: false,
        agent: true,
        mcp: true,
        cli: true,
        rpc: false,
      },
      cli: {
        acceptsServerId: true,
        commands: [{
          path: ['machines', 'pools', verb],
          visibility: 'canonical',
        }],
      },
      inputHints: { title: titles[actionId], fields: MACHINE_POOL_INPUT_FIELDS[actionId] },
      inputSchema: MachinePoolActionInputSchemasV1[actionId],
      outputSchema: MachinePoolActionOutputSchemasV1[actionId],
      serverTransport: {
        method: 'POST',
        path: machinePoolActionEndpointPathV1(actionId),
      },
    };
  }) satisfies readonly PreNormalizedActionSpec[]),
] as const);

