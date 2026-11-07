import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import {
  MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerCheckResultV1Schema,
  MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { CRABBOX_PLUGIN_ID, CRABBOX_COORDINATOR_PROVISIONER_ID, CRABBOX_CONNECTION_PURPOSE } from './constants.js';
import { CrabboxOptionsInputV1Schema, CRABBOX_ROLE_SCHEMAS, CRABBOX_RECONCILIATION } from './schemas.js';
import type { CrabboxLaunchV1, CrabboxResourceV1 } from './schemas.js';
import { CRABBOX_OPTIONS_INPUT_HINTS } from './configuration.js';
import {
  acquireCrabbox, bootstrapCrabbox, checkCrabboxCoordinator, crabboxOptions, destroyCrabbox,
  inspectedCrabboxProvider, inspectCrabbox, reconcileCrabbox,
} from './roles.js';

const reference = { pluginId: CRABBOX_PLUGIN_ID, localId: CRABBOX_COORDINATOR_PROVISIONER_ID };
const defaults = { scopes: ['machine'], surfaces: ['plugin'],
  execution: { target: 'account', account: { artifactId: 'coordinator', exportName: 'activate' } },
  hostAccess: [CRABBOX_CONNECTION_PURPOSE, 'crabbox-native-http'] } as const;
const confirmation = { title: 'Approve this Crabbox operation?',
  body: 'Operate the reviewed coordinator lease using its selected connection and host-owned SSH credential.', confirmLabel: 'Continue' };

async function coordinatorProvider(selection: CrabboxLaunchV1 | CrabboxResourceV1, context: PluginAccountActionContext) {
  if (selection.transport !== 'coordinator') throw new Error('native_route_unavailable');
  return inspectedCrabboxProvider(context, reference);
}

/** Portable bindings consume the same role bodies as native/direct; no native adapter is imported. */
export const CRABBOX_COORDINATOR_ACTIONS = {
  'coordinator-check': { ...defaults, title: 'Check Crabbox coordinator', dangerLevel: 'safe',
    inputSchema: CRABBOX_ROLE_SCHEMAS.checkInput, resultSchema: MachineProvisionerCheckResultV1Schema,
    async run(_input: ProtocolSchemaOutput<typeof CRABBOX_ROLE_SCHEMAS.checkInput>, context: PluginAccountActionContext) {
      return checkCrabboxCoordinator(context);
    } },
  'coordinator-options': { ...defaults, title: 'List Crabbox coordinator routes', dangerLevel: 'safe',
    inputSchema: CrabboxOptionsInputV1Schema, resultSchema: MachineProvisionerOptionsResultV1Schema,
    inputHints: CRABBOX_OPTIONS_INPUT_HINTS,
    async run(input: ProtocolSchemaOutput<typeof CrabboxOptionsInputV1Schema>, context: PluginAccountActionContext) {
      return crabboxOptions(input, context);
    } },
  'coordinator-acquire': { ...defaults, title: 'Acquire Crabbox coordinator lease', dangerLevel: 'writesRemote', confirmation,
    inputSchema: CRABBOX_ROLE_SCHEMAS.acquireInput, resultSchema: CRABBOX_ROLE_SCHEMAS.acquireResult,
    async run(input: ProtocolSchemaOutput<typeof CRABBOX_ROLE_SCHEMAS.acquireInput>, context: PluginAccountActionContext) {
      return acquireCrabbox(input, context, coordinatorProvider);
    } },
  'coordinator-bootstrap': { ...defaults, title: 'Resolve private Crabbox SSH carrier', dangerLevel: 'writesRemote', confirmation,
    inputSchema: CRABBOX_ROLE_SCHEMAS.bootstrapInput, resultSchema: MachineProvisionerBootstrapCarrierV1Schema,
    async run(input: ProtocolSchemaOutput<typeof CRABBOX_ROLE_SCHEMAS.bootstrapInput>, context: PluginAccountActionContext) {
      return bootstrapCrabbox(input, context, coordinatorProvider);
    } },
  'coordinator-inspect': { ...defaults, title: 'Inspect Crabbox coordinator lease', dangerLevel: 'safe',
    inputSchema: CRABBOX_ROLE_SCHEMAS.resourceInput, resultSchema: MachineProvisionerObservationV1Schema,
    async run(input: ProtocolSchemaOutput<typeof CRABBOX_ROLE_SCHEMAS.resourceInput>, context: PluginAccountActionContext) {
      return inspectCrabbox(input, context, coordinatorProvider);
    } },
  'coordinator-reconcile': { ...defaults, title: 'Recover exact Crabbox coordinator lease', dangerLevel: 'safe',
    inputSchema: CRABBOX_RECONCILIATION.input, resultSchema: CRABBOX_RECONCILIATION.result,
    async run(input: ProtocolSchemaOutput<typeof CRABBOX_RECONCILIATION.input>, context: PluginAccountActionContext) {
      return reconcileCrabbox(input, context, coordinatorProvider, reference);
    } },
  'coordinator-destroy': { ...defaults, title: 'Release Crabbox coordinator lease', dangerLevel: 'destructive',
    confirmation: { title: 'Delete this Crabbox lease?',
      body: 'Delete this exact lease and its non-retained filesystem.', confirmLabel: 'Delete lease' },
    inputSchema: CRABBOX_RECONCILIATION.destroyInput, resultSchema: CRABBOX_RECONCILIATION.destroyResult,
    async run(input: ProtocolSchemaOutput<typeof CRABBOX_RECONCILIATION.destroyInput>, context: PluginAccountActionContext) {
      return destroyCrabbox(input, context, coordinatorProvider);
    } },
} as const;

/** Exact portable artifact ABI; the host uses the manifest's canonical schemas. */
export function activate(api: PluginAccountApi) {
  api.actions.register('coordinator-check', CRABBOX_COORDINATOR_ACTIONS['coordinator-check'].run);
  api.actions.register('coordinator-options', CRABBOX_COORDINATOR_ACTIONS['coordinator-options'].run);
  api.actions.register('coordinator-acquire', CRABBOX_COORDINATOR_ACTIONS['coordinator-acquire'].run);
  api.actions.register('coordinator-bootstrap', CRABBOX_COORDINATOR_ACTIONS['coordinator-bootstrap'].run);
  api.actions.register('coordinator-inspect', CRABBOX_COORDINATOR_ACTIONS['coordinator-inspect'].run);
  api.actions.register('coordinator-reconcile', CRABBOX_COORDINATOR_ACTIONS['coordinator-reconcile'].run);
  api.actions.register('coordinator-destroy', CRABBOX_COORDINATOR_ACTIONS['coordinator-destroy'].run);
}
