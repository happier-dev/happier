import { lazyActionSpecArray , type ActionSpecArrayConcat } from '../lazyActionSpecValue.js';
import { MACHINE_PRESET_INPUT_FIELDS, MACHINE_POOL_INPUT_FIELDS } from './machineInputHints.js';
import { declareDeploymentPreparationScopeV1 } from './deploymentPreparationScope.js';
import { isMachineSetupPlanOrApplyActionIdV1, isMachineSetupCombinedActionIdV1, isMachineSetupOperationActionIdV1, MACHINE_SETUP_APPLY_ACTION_ID_V1, MACHINE_SETUP_REMOVE_ACTION_ID_V1, MACHINE_SETUP_UPDATES_APPLY_ACTION_ID_V1, MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import { ActionOperationCompletionOutputV1Schema, type ActionCompletionDeclaration } from '../actionCompletion.js';
import { MachineSetupApplyResultV1Schema } from '../../machines/setup/machineSetupOperationV1.js';
import { ActionOperationAcceptedResultSchema } from '../actionExecutionResult.js';
import { MACHINE_POOL_ACTION_IDS_V1, MachinePoolActionInputSchemasV1, MachinePoolActionOutputSchemasV1, machinePoolActionEndpointPathV1, type MachinePoolActionIdV1 } from '../../machines/pools/actionsV1.js';
import { MACHINE_PRESET_ACTION_IDS_V1, MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1, machinePresetActionEndpointPathV1 } from '../../machines/managed/machinePresetActionsV1.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1, EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1, EphemeralRunnerActionInputSchemasV1, EphemeralRunnerActionOutputSchemasV1, type EphemeralRunnerActionIdV1 } from '../../ephemeralRunner/actionsV1.js';
import {
  MANAGED_MACHINE_ACTION_IDS_V1,
  MANAGED_CONTROL_ACTION_IDS_V1,
  ManagedMachineActionInputSchemasV1,
  ManagedMachineActionOutputSchemasV1,
  managedMachineActionEndpointPathV1,
  type ManagedAcquireInputV1,
  type ManagedMachineActionIdV1,
} from '../../machines/managed/actionsV1.js';
import { resolveManagedMachineEnrollmentAdminAccessV1, resolveManagedMachineEnrollmentAgentIsolationV1 } from '../../machines/managed/enrollmentIdentityV1.js';
import { readMachineProvisionerActionRolesV1 } from '../../plugins/contributions/machineProvisioners.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { MANAGED_MACHINE_INPUT_FIELDS } from './machineInputHints.js';
import { managedAcquireApprovalPresentation } from './managedAcquireApproval.js';
import { isManagedResizeActionIdV1 } from '../../machines/managed/actionIdsV1.js';

const titles: Record<ManagedMachineActionIdV1, string> = {
  'machines.provisioners.list': 'List machine provisioners',
  'machines.provisioners.check': 'Check machine provisioner',
  'machines.provisioners.options': 'Get machine provisioner choices',
  'machines.managed.acquire': 'Create managed machine',
  'machines.managed.credentials.install': 'Install credential delivery',
  'machines.managed.list': 'List managed machines',
  'machines.managed.get': 'Get managed machine',
  'machines.managed.birth.get': 'Read managed machine creation source',
  'machines.managed.references.get': 'Review managed machine dependencies',
  'machines.managed.inspect': 'Check managed machine now',
  'machines.managed.bootstrap.retry': 'Retry Happier installation',
  'machines.managed.setup.skip': 'Continue without setup',
  'machines.setup.plan': 'Review machine setup',
  'machines.setup.apply': 'Apply machine setup',
  'machines.setup.remove': 'Remove machine setup items',
  'machines.setup.updates.apply': 'Install machine updates',
  'machines.setup.updates.rollout': 'Update a fleet of Machines',
  'machines.managed.cancel': 'Cancel managed machine creation',
  'machines.managed.power.set': 'Change machine power',
  'machines.managed.rebuild': 'Rebuild Dev Container',
  'machines.managed.resize': 'Resize managed machine',
  'machines.managed.retention.update': 'Change when a machine stops',
  'machines.managed.delete': 'Delete managed machine',
  'machines.managed.controller.update': 'Move machine management',
  'machines.managed.retire': 'Hide managed machine with manual responsibility',
};

/** Setup acceptance names a finite native operation; it never settles a Workflow leaf. */
function machineSetupCompletion(actionId: typeof MACHINE_SETUP_APPLY_ACTION_ID_V1 | typeof MACHINE_SETUP_REMOVE_ACTION_ID_V1 | typeof MACHINE_SETUP_UPDATES_APPLY_ACTION_ID_V1
  | typeof MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1): ActionCompletionDeclaration {
  return {
    awaits: 'action_operations', terminalOutputSchema: ActionOperationCompletionOutputV1Schema,
    launched: (output, context) => {
      const input = ManagedMachineActionInputSchemasV1[actionId].parse(context?.input);
      const accepted = ActionOperationAcceptedResultSchema.safeParse(output);
      const receipt = accepted.success ? accepted.data : MachineSetupApplyResultV1Schema.parse(output);
      return { operations: [{ key: 'setup', serverId: context?.serverId ?? input.homeId,
        machineId: input.machineId, operationId: receipt.operationId }] };
    },
    terminal: (_output, operations) => ({ operation: operations[0]!.operation }),
  };
}

function createManagedMachineActionSpecs() {
  return MANAGED_MACHINE_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
  const effect = actionId === 'machines.managed.acquire'
    || actionId === 'machines.managed.credentials.install'
    || actionId === 'machines.setup.apply' || actionId === 'machines.setup.remove' || actionId === 'machines.setup.updates.apply' || actionId === MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 || actionId === 'machines.managed.setup.skip'
    || actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.cancel'
    || MANAGED_CONTROL_ACTION_IDS_V1.some(control => control === actionId);
  const account = actionId === 'machines.provisioners.list'
    || actionId === 'machines.provisioners.check' || actionId === 'machines.provisioners.options' || actionId === 'machines.managed.acquire'
    || actionId === 'machines.managed.list' || actionId === 'machines.managed.get' || actionId === 'machines.managed.birth.get'
    || actionId === 'machines.managed.cancel' || actionId === 'machines.managed.references.get' || actionId === 'machines.managed.setup.skip'
    || actionId === 'machines.managed.power.set' || isManagedResizeActionIdV1(actionId) || actionId === 'machines.managed.inspect'
    || actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.delete' || actionId === 'machines.managed.retire';
  return {
    id: actionId, approval: { result: 'required' }, originalExecution: { terminalRoot: 'allowed' },
    ...(isMachineSetupPlanOrApplyActionIdV1(actionId) || isMachineSetupCombinedActionIdV1(actionId) ? { deploymentPreparationScope: declareDeploymentPreparationScopeV1('setup') } : {}),
    ...(isMachineSetupCombinedActionIdV1(actionId) ? { requesterAccountContentDemandForInput: () => true } : {}),
    ...(actionId === 'machines.managed.acquire' ? { hostReviewedChildren: (normalizedInput: unknown) => {
      const input = normalizedInput as ManagedAcquireInputV1;
      if (!('enrollmentIdentity' in input)) {
        // The preset declaration is private. Its custodian opens the exact
        // admitted carrier before issuing provider children through the
        // opaque-preset reviewed-child owner; this public Action can declare
        // only its structural Session request.
        return input.agentStart ? [{ action: 'session.spawn_new' as const, role: 'session.spawn_new' }] : [];
      }
      // The guest operands arrive after enrollment. Declare only work already
      // demanded by this normalized creation, without inventing guest inputs.
      return [
        ...(input.reviewedFacts?.provisioner
          ? readMachineProvisionerActionRolesV1(input.reviewedFacts.provisioner)
            .filter(({ role }) => role === 'acquire' || role === 'bootstrap' || role === 'inspect' || role === 'destroy'
              || role === 'exec' || role === 'putFile' || role === 'reconcile' || role === 'cleanup')
            .map(({ action, role }) => ({ action: { pluginId: input.reviewedFacts!.launch.provider.pluginId, localId: action }, role }))
          : []),
        ...(resolveManagedMachineEnrollmentAdminAccessV1(input.enrollmentIdentity)
          ? [{ action: 'machines.setup.adminAccess.set' as const, role: 'machines.setup.adminAccess.set' }] : []),
        ...(resolveManagedMachineEnrollmentAgentIsolationV1(input.enrollmentIdentity)
          ? [{ action: 'machines.agentIsolation.preview' as const, role: 'machines.agentIsolation.preview' },
            { action: 'machines.agentIsolation.set' as const, role: 'machines.agentIsolation.set' }] : []),
        ...(input.agentStart ? [{ action: 'session.spawn_new' as const, role: 'session.spawn_new' }] : []),
      ];
    } } : {}),
    ...(actionId === 'machines.managed.acquire' || actionId === 'machines.managed.bootstrap.retry'
      || actionId === 'machines.managed.power.set'
      || actionId === 'machines.managed.retention.update' || actionId === 'machines.managed.controller.update'
      || actionId === 'machines.managed.setup.skip'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } }
      : effect ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
    title: titles[actionId],
    ...(actionId === 'machines.managed.acquire' ? { approvalPresentation: managedAcquireApprovalPresentation } : {}),
    ...(actionId === 'machines.setup.apply' || actionId === 'machines.setup.remove' || actionId === 'machines.setup.updates.apply' || actionId === MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 ? { approvalScope: 'machine' as const } : {}),
    ...({
      'machines.managed.bootstrap.retry': { confirmVerb: { key: 'common.retry', fallback: 'Retry' } },
      // Its own words, not "Cancel": the dialog's dismiss button already says Cancel.
      'machines.managed.cancel': { confirmVerb: { key: 'managedMachines.actions.cancelCreation', fallback: 'Cancel creation' } },
      'machines.setup.apply': { confirmVerb: { key: 'common.run', fallback: 'Run' } },
      'machines.setup.remove': { confirmVerb: { key: 'common.remove', fallback: 'Remove' } },
      'machines.setup.updates.apply': { confirmVerb: { key: 'common.install', fallback: 'Install' } },
      'machines.managed.rebuild': { confirmVerb: { key: 'common.update', fallback: 'Update' } },
      'machines.managed.delete': { confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true },
      'machines.managed.retire': { confirmVerb: { key: 'common.remove', fallback: 'Remove' } },
    } as Partial<Record<typeof actionId, Pick<PreNormalizedActionSpec, 'confirmVerb' | 'irreversible'>>>)[actionId],
    description: actionId === 'machines.managed.acquire'
      ? 'Create Account-owned compute and install Happier using the reviewed provider, price and lifetime on the selected Home. For a one-off selection, read descriptor.launchSchema on the selected entry from machines.provisioners.list and resolve its options with machines.provisioners.options. Supply schema-shaped launch.choices; an option display label is not a launch input. Retain the reviewed facts from that configuration.'
      : actionId === 'machines.managed.bootstrap.retry'
        ? 'Retry installation on the same managed resource using its current enrollment attempt.'
        : actionId === 'machines.managed.cancel'
          ? 'Cancel the admitted creation request and retain the resulting resource cleanup disposition.'
          : actionId === 'machines.setup.apply'
            ? 'Apply the reviewed setup sources on the exact Machine through current approval and native admission; acceptance does not confirm a native effect.'
          : actionId === 'machines.setup.remove'
            ? 'Remove only reviewed, declared, native-owned setup or software effects on this Machine; apps, scripts, toolchains and user data are not removal operands.'
          : actionId === 'machines.setup.updates.apply'
            ? 'Install the exact reviewed security or all OS package updates through native setup admission. Package updates may restart services; this operation never reboots the Machine.'
          : actionId === 'machines.managed.power.set'
            ? 'Apply the admitted power intent to the retained native resource; acceptance does not confirm a native effect.'
          : actionId === 'machines.managed.inspect'
            ? 'Check the retained resource without starting or waking compute. Set includeGuestDiagnostics to read redacted daemon logs as its custodian; unavailable transport or guest identity is returned explicitly.'
          : effect ? `${titles[actionId]} on the retained resource through its admitted operation; acceptance does not confirm a native effect.`
            : `${titles[actionId]} on the exact Home without starting or waking compute.`,
    safety: effect ? 'danger' : 'safe',
    sideEffectClass: effect ? 'danger' : 'read',
    executionPlacement: account ? 'account' : 'machine',
    ...(actionId === 'machines.managed.power.set' || isManagedResizeActionIdV1(actionId) || actionId === 'machines.managed.inspect'
      || actionId === 'machines.managed.bootstrap.retry' || actionId === 'machines.managed.delete'
      ? { executionPlacements: ['account', 'machine'] as const } : {}),
    ...(actionId === 'machines.provisioners.list' || actionId === 'machines.provisioners.check'
      || actionId === 'machines.provisioners.options' || actionId === 'machines.managed.acquire' ? {
      executionPlacements: ['account', 'machine'] as const,
      executionPlacementForInput: (input: unknown) => {
        if (!input || typeof input !== 'object') return 'account' as const;
        if ('controller' in input && input.controller !== undefined) return 'machine' as const;
        const selection = 'selection' in input ? input.selection : undefined;
        return selection && typeof selection === 'object' && 'controller' in selection && selection.controller !== undefined
          ? 'machine' as const : 'account' as const;
      },
    } : {}),
    placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_'), rpcMethod: actionId },
    cli: { acceptsServerId: true, commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputHints: { title: titles[actionId], fields: MANAGED_MACHINE_INPUT_FIELDS[actionId] },
    inputSchema: ManagedMachineActionInputSchemasV1[actionId],
    outputSchema: ManagedMachineActionOutputSchemasV1[actionId],
    ...(isMachineSetupOperationActionIdV1(actionId)
      ? { completion: machineSetupCompletion(actionId) } : {}),
    // This requester-private census is assembled by the Account's existing
    // readers; it has no server endpoint that could read E2EE references.
    ...(actionId === 'machines.managed.references.get' || actionId === 'machines.setup.plan'
      || actionId === 'machines.setup.apply' || actionId === 'machines.setup.remove' || actionId === 'machines.setup.updates.apply' || actionId === MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1 ? {} : {
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
}

export const MANAGED_MACHINE_ACTION_SPECS: ReturnType<typeof createManagedMachineActionSpecs> = lazyActionSpecArray(createManagedMachineActionSpecs);


export const MACHINE_PRESET_ACTION_SPECS: ActionSpecArrayConcat<readonly [
  PreNormalizedActionSpec[],
]> = lazyActionSpecArray(() => Object.freeze([
  ...(MACHINE_PRESET_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
    const verb = id.slice('machines.presets.'.length);
    const read = id === 'machines.presets.list' || id === 'machines.presets.get';
    const title = `${verb[0]!.toUpperCase()}${verb.slice(1)} Machine preset`;
    return {
      id, executionPlacement: 'account', approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'direct' }, title, description: `${title} on the exact authenticated Home. Preset changes affect future machines only.`,
      safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'danger', placements: [],
      bindings: { mcpToolName: `machines_presets_${verb}`, voiceClientToolName: `machines_presets_${verb}` },
      surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
      cli: { acceptsServerId: true, commands: [{ path: ['machines', 'presets', verb], visibility: 'canonical' }] },
      inputHints: { title, fields: MACHINE_PRESET_INPUT_FIELDS[id] },
      inputSchema: MachinePresetActionInputSchemasV1[id], outputSchema: MachinePresetActionOutputSchemasV1[id],
      serverTransport: { method: 'POST', path: machinePresetActionEndpointPathV1(id) },
    };
  }) satisfies readonly PreNormalizedActionSpec[]),
] as const));


export const EPHEMERAL_RUNNER_ACTION_SPECS: ActionSpecArrayConcat<readonly [
  PreNormalizedActionSpec[],
]> = lazyActionSpecArray(() => Object.freeze([
  ...(EPHEMERAL_RUNNER_ACTION_IDS_V1.map((actionId): PreNormalizedActionSpec => {
    const titles: Record<EphemeralRunnerActionIdV1, string> = {
      'sessions.runner.activation.create': 'Create Temporary computer request',
      'sessions.runner.activation.get': 'Get Temporary computer request',
      'sessions.runner.activation.cancel': 'Cancel Temporary computer request',
    };
    const isRead = actionId === 'sessions.runner.activation.get';
    return {
      id: actionId, executionPlacement: 'account', approval: isRead ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
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
] as const));


export const MACHINE_POOL_ACTION_SPECS: ActionSpecArrayConcat<readonly [
  PreNormalizedActionSpec[],
]> = lazyActionSpecArray(() => Object.freeze([
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
      id: actionId, executionPlacement: 'account', approval: isRead ? { result: 'required' } : { result: 'optional', flow: 'deferred' },
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
] as const));
