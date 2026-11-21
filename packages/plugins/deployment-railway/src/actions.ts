import {
  deploymentTargetRoleWithNativeSelectorV1,
  DeploymentTargetPreparationBaseV1ProtocolSchema,
  DeploymentTargetRoleInputProtocolSchemasV1,
  DeploymentTargetRoleResultV1ProtocolSchema,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { ActionInputHints, PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { RAILWAY_PROJECT_KEY } from '@happier-dev/railway-api';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { connectionReference, inspect, provision, removeDatabase, workflow } from './vendor.js';
import { ACCOUNT_PURPOSE, engines, exactSelectionSchema, nativeSelectorSchema, pluginId, railway, readFailure, selectedService, type Engine, type Scope } from './provider.js';

export const networkAccess = 'railway-api';
export const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
export const text = { type: 'string', minLength: 1 } as const;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema;
export const closed = (properties: Record<string, PluginJsonSchema>, required = Object.keys(properties)): PluginJsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });

const scope = { projectId: text, railwayEnvironmentId: text, workspaceId: text };
const selection = { ...scope, serviceId: text };
const status = (...values: string[]): PluginJsonSchema => ({ type: 'string', enum: values });
const item = closed({ id: text, name: text });
const listResult = closed({ databases: { type: 'array', items: item }, nextCursor: text }, ['databases']);
const provisionResult = { anyOf: [closed({ ...scope, status: status('adoption_required'), workflowId: text }),
  closed({ ...scope, status: status('outcome_unknown') })] } satisfies PluginJsonSchema;
const nativeEnvironment = closed({ kind: status('native'), selection: exactSelectionSchema });
const providerIdentity = closed({ providerAccountId: text, providerResourceId: text, providerEnvironment: text });
const linkResult = closed({ serviceName: text, engine: status('postgresql', 'mysql'),
  providerIdentity, providerEnvironment: nativeEnvironment,
  providerConsole: closed({ label: text, url: text }),
});

const common = { execution, scopes: ['global'] as const, surfaces: ['cli', 'plugin', 'ui', 'agent'] as const, placementBindings: [],
  hostAccess: [networkAccess, ACCOUNT_PURPOSE], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: ACCOUNT_PURPOSE }] } as const;

type SelectionInput = Scope & { workspaceId: string; projectId: string; railwayEnvironmentId: string };
type ServiceInput = SelectionInput & { serviceId: string };
type Runner<T> = (input: T, context: PluginAccountActionContext) => Promise<JsonValue>;
type AccountAction = PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>;

function action<T>(title: string, fields: Record<string, PluginJsonSchema>, resultSchema: PluginJsonSchema,
  run: Runner<T>, options: { fields?: ActionInputHints['fields']; write?: true; optional?: string[] } = {}): AccountAction {
  return {
    ...common, title, resultSchema, readOnly: !options.write,
    dangerLevel: options.write ? 'writesRemote' as const : 'safe' as const,
    ...(options.write ? { confirmation: { title } } : {}),
    ...(options.fields ? { inputHints: { fields: options.fields } } : {}),
    inputSchema: deploymentTargetRoleWithNativeSelectorV1(closed({ ...base.properties, ...fields },
      [...(base.required ?? []), ...Object.keys(fields).filter(key => !options.optional?.includes(key) && !base.required?.includes(key))]), nativeSelectorSchema),
    run: (input: JsonValue, context: PluginAccountActionContext) => run(input as T, context),
  };
}

const coordinates = (input: SelectionInput) => ({ workspaceId: input.workspaceId, projectId: input.projectId,
  environmentId: input.railwayEnvironmentId });
const serviceCoordinates = (input: ServiceInput) => ({ ...coordinates(input), serviceId: input.serviceId });

export function actionIds(engine: Engine) {
  return { list: `${engine}-list`, provision: `${engine}-provision`, link: `${engine}-link`,
    reference: `${engine}-connection-reference`, options: `${engine}-options` };
}
export const workflowActionId = 'workflow-read';
export const deleteActionId = 'database-delete';
export const observeRemovalActionId = 'database-removal-observe';

function removalAction(observeOnly: boolean): AccountAction {
  const title = observeOnly ? 'Check Railway database removal' : 'Delete the selected Railway database service';
  const role = observeOnly ? 'projects.observe' : 'projects.delete';
  return {
    ...common, title, readOnly: observeOnly, dangerLevel: observeOnly ? 'safe' as const : 'destructive' as const,
    ...(!observeOnly ? { confirmation: { title } } : {}),
    inputSchema: deploymentTargetRoleWithNativeSelectorV1(DeploymentTargetRoleInputProtocolSchemasV1[role].jsonSchema, nativeSelectorSchema),
    resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
    run: async (input: JsonValue, context: PluginAccountActionContext) => {
      return removeDatabase(selectedService(input as unknown as Scope), context, observeOnly);
    },
  };
}

export const deleteAction: AccountAction = removalAction(false);
export const observeRemovalAction: AccountAction = removalAction(true);

export function engineActions(engine: Engine): Record<string, AccountAction> {
  const ids = actionIds(engine);
  const label = engines[engine].label;
  const fields = [
    { path: 'workspaceId', title: 'Railway workspace', inputType: { pluginId, localId: engine + '-workspace' }, widget: 'select', required: true },
    { path: 'projectId', title: 'Railway project', inputType: { pluginId, localId: engine + '-project' }, widget: 'select', required: true, optionsDraftDependencies: ['workspaceId'],
      visibleWhen: { op: 'truthy', path: 'workspaceId' } },
    { path: 'railwayEnvironmentId', title: 'Railway environment', inputType: { pluginId, localId: engine + '-environment' },
      widget: 'select', required: true, optionsDraftDependencies: ['projectId'],
      visibleWhen: { op: 'truthy', path: 'projectId' } },
    { path: 'serviceId', title: label + ' service', inputType: { pluginId, localId: engine + '-service' },
      widget: 'select', required: true, optionsDraftDependencies: ['projectId', 'railwayEnvironmentId'],
      visibleWhen: { op: 'truthy', path: 'railwayEnvironmentId' } },
  ] as const;
  return {
    [ids.list]: action<SelectionInput & { cursor?: string }>(`Find Railway ${label} databases`, { ...scope, cursor: text }, listResult,
      async (input, context) => {
        const page = await railway(context).project.readEnvironmentServicesPage(input.projectId, input.railwayEnvironmentId,
          input.cursor ?? null, engines[engine].template).catch(readFailure);
        return { databases: page.choices, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      }, { fields: fields.slice(0, 3), optional: ['cursor'] }),
    [ids.provision]: action<SelectionInput>(`Create Railway ${label} database`, scope, provisionResult,
      (input, context) => provision(engine, coordinates(input), context), { write: true, fields: fields.slice(0, 3) }),
    [ids.link]: action<ServiceInput>(`Inspect Railway ${label} database for adoption`, selection, linkResult, async (input, context) => {
      const service = await inspect(engine, serviceCoordinates(input), context);
      const project = encodeURIComponent(input.projectId);
      const serviceId = encodeURIComponent(service.id);
      const environment = encodeURIComponent(input.railwayEnvironmentId);
      return { engine, serviceName: service.name, providerIdentity: { providerAccountId: input.projectId,
        providerResourceId: service.id, providerEnvironment: input.railwayEnvironmentId },
      providerEnvironment: { kind: 'native', selection: { projectId: input.projectId,
        environmentId: input.railwayEnvironmentId, serviceId: service.id } },
      providerConsole: { label: 'Railway', url: `https://railway.com/project/${project}/service/${serviceId}?environmentId=${environment}` } };
    }, { fields }),
    [ids.reference]: action<Scope & { runtimeProviderIdentity: NonNullable<Scope['providerIdentity']>;
      runtimeProviderEnvironment: Scope['providerEnvironment'] }>(
      `Read a Railway app variable reference for ${label}`,
      { runtimeProviderIdentity: providerIdentity, runtimeProviderEnvironment: nativeEnvironment }, closed({ reference: text }),
      (input, context) => connectionReference(engine, selectedService(input), selectedService({
        providerIdentity: input.runtimeProviderIdentity, providerEnvironment: input.runtimeProviderEnvironment,
      }), context)),
    [ids.options]: {
      ...common, title: `List Railway ${label} picker options`, readOnly: true, dangerLevel: 'safe' as const,
      inputSchema: closed({ credentialRef: base.properties!.credentialRef!, credentialPrincipal: base.properties!.credentialPrincipal!,
        fieldPath: status('workspaceId', 'projectId', 'railwayEnvironmentId', 'serviceId'), ...scope, cursor: text, query: { type: 'string' } },
      ['credentialRef', 'credentialPrincipal', 'fieldPath']),
      resultSchema: closed({ options: { type: 'array', items: closed({ value: text, label: text }) }, nextCursor: text }, ['options']),
      run: (input: JsonValue, context: PluginAccountActionContext) => options(engine, input as OptionsInput, context),
    },
  };
}

type OptionsInput = { fieldPath: 'workspaceId' | 'projectId' | 'railwayEnvironmentId' | 'serviceId';
  workspaceId?: string; projectId?: string; railwayEnvironmentId?: string; query?: string; cursor?: string };
function required(value: string | undefined, requiredDraftPath: string) {
  if (!value) throw new PluginError({ code: 'missing_option_dependency', details: { requiredDraftPath } });
  return value;
}

async function options(engine: Engine, input: OptionsInput, context: PluginAccountActionContext) {
  const { project } = railway(context);
  const after = input.cursor ?? null;
  const page = async () => {
    if (input.fieldPath === 'workspaceId') {
      const [workspaces, externalWorkspaces] = await Promise.all([
        project.listGrantedWorkspaces(), project.listGrantedProjectWorkspaces(),
      ]);
      const choices = new Map([...externalWorkspaces, ...workspaces].map(({ id, name }) => [id, { id, name }]));
      return { choices: [...choices.values()], nextCursor: null };
    }
    if (input.fieldPath === 'projectId') {
      const workspaceId = required(input.workspaceId, 'workspaceId');
      // Machine Railway selects the exact granted project during OAuth setup.
      const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
        { kind: 'environment', keys: [RAILWAY_PROJECT_KEY] }, { signal: context.signal });
      if (material.kind !== 'environment') throw new PluginError({ code: 'credential_unavailable' });
      const projectId = material.env[RAILWAY_PROJECT_KEY];
      if (!projectId) return project.readProjectsPage(after, workspaceId);
      const binding = await context.services.connectedAccounts.getBinding(ACCOUNT_PURPOSE, { signal: context.signal });
      if (!binding) throw new PluginError({ code: 'credential_unavailable' });
      return { choices: [{ id: projectId, name: binding.target.displayName }], nextCursor: null };
    }
    const projectId = required(input.projectId, 'projectId');
    if (input.fieldPath === 'railwayEnvironmentId') return project.readEnvironmentsPage(projectId, after);
    return project.readEnvironmentServicesPage(projectId, required(input.railwayEnvironmentId, 'railwayEnvironmentId'), after,
      engines[engine].template);
  };
  const { choices, nextCursor } = await page().catch(readFailure);
  const needle = input.query?.toLowerCase();
  return { options: choices.filter(choice => !needle || choice.name.toLowerCase().includes(needle))
    .map(choice => ({ value: choice.id, label: input.fieldPath === 'serviceId' ? `${choice.name} (${choice.id})` : choice.name })), ...(nextCursor ? { nextCursor } : {}) };
}

export const workflowAction: AccountAction = action<{ workflowId: string }>('Read Railway database creation progress',
  { workflowId: text }, closed({ status: status('Running', 'Complete', 'Error', 'NotFound') }),
  (input, context) => workflow(input.workflowId, context));
