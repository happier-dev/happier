import { DeploymentTargetPreparationBaseV1ProtocolSchema, type DefinePluginInput, type JsonValue } from '@happier-dev/plugin-sdk';
import type { InputOption, PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createDeploymentTargetOptionsResource } from '@happier-dev/plugin-sdk/resources';
import { RAILWAY_PROJECT_KEY, createRailwayProjectOperations } from '@happier-dev/railway-api';
import { ACCOUNT_PURPOSE, projectRailwayFailure, railwayAccountAction, railwayIdentity, railwayRequest } from './account.js';
import { railwayRoleInput } from './coordinates.js';

const paths = ['providerAccountId', 'railwayEnvironmentId', 'providerEnvironment', 'workspaceId'] as const;
const base = railwayRoleInput(DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema).properties!;
const id = { type: 'string', minLength: 1 } as const;
const actionId = 'target-options-read';
export const railwayEnvironmentOptionSchema = id;

function missing(requiredDraftPath: string): never {
  throw new PluginError({ code: 'missing_option_dependency', details: { requiredDraftPath } });
}

type OptionsInput = Readonly<{ fieldPath: typeof paths[number]; providerAccountId?: string;
  railwayEnvironmentId?: string; creating?: true; query?: string; cursor?: string }>;

async function options(input: OptionsInput, context: PluginAccountActionContext) {
  const matches = (option: InputOption) => !input.query || option.label.toLowerCase().includes(input.query.toLowerCase());
  const after = input.cursor ?? null;
  const projectPage = (page: { choices: { id: string; name: string }[]; nextCursor: string | null },
    source?: InputOption['source'],
    toValue: (id: string) => InputOption['value'] = id => id) => ({
    options: page.choices.map(choice => ({ value: toValue(choice.id), label: choice.name, ...(source ? { source } : {}) })).filter(matches),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  });
  const choices = () => createRailwayProjectOperations(railwayRequest(context), context.signal);
  try {
    if (input.fieldPath === 'workspaceId') {
      return projectPage({ choices: [...await choices().listGrantedWorkspaces()], nextCursor: null });
    }
    if (input.fieldPath === paths[0]) {
      const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
        { kind: 'environment', keys: [RAILWAY_PROJECT_KEY] }, { signal: context.signal });
      if (material.kind !== 'environment') throw new PluginError({ code: 'credential_unavailable' });
      const savedProject = material.env[RAILWAY_PROJECT_KEY];
      if (!savedProject) {
        const page = await choices().readAccountProjectsPage(after);
        return projectPage(page, page.workspaceId ? { kind: 'railway-workspace', locator: page.workspaceId } : undefined);
      }
      const binding = await context.services.connectedAccounts.getBinding(ACCOUNT_PURPOSE, { signal: context.signal });
      if (!binding) throw new PluginError({ code: 'credential_unavailable' });
      return { options: [{ value: savedProject, label: binding.target.displayName }].filter(matches) };
    }
    const projectId = input.providerAccountId ?? missing(paths[0]);
    if (input.fieldPath === paths[1]) {
      return projectPage(await choices().readEnvironmentsPage(projectId, after));
    }
    if (input.creating) {
      return projectPage(await choices().readEnvironmentsPage(projectId, after), undefined,
        environmentId => ({ kind: 'native', selection: { projectId, environmentId } }));
    }
    const environmentId = input.railwayEnvironmentId ?? missing(paths[1]);
    return projectPage(await choices().readEnvironmentServicesPage(projectId, environmentId, after), undefined,
      serviceId => ({ kind: 'native', selection: { projectId, environmentId, serviceId } }));
  } catch (error) {
    return projectRailwayFailure(error, context, 'options');
  }
}

export const optionsAction: PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>> = {
  ...railwayAccountAction, title: 'Read Railway target options', dangerLevel: 'safe', readOnly: true,
  inputSchema: { type: 'object', additionalProperties: false, properties: { credentialRef: base.credentialRef!,
    credentialPrincipal: base.credentialPrincipal!, fieldPath: { type: 'string', enum: [...paths] },
    providerAccountId: id, railwayEnvironmentId: id, creating: { type: 'boolean', const: true }, query: { type: 'string' }, cursor: id },
  required: ['credentialRef', 'credentialPrincipal', 'fieldPath'] },
  resultSchema: { type: 'object', additionalProperties: false, properties: { options: { type: 'array', items: {
    type: 'object', properties: { value: { oneOf: [id, base.providerEnvironment!] }, label: id,
      source: { type: 'object', additionalProperties: false, properties: { kind: id, locator: id }, required: ['kind', 'locator'] },
    },
    required: ['value', 'label'], additionalProperties: false,
  } }, nextCursor: id }, required: ['options'] },
  run: (input: JsonValue, context: PluginAccountActionContext) => options(input as unknown as OptionsInput, context),
};

const optionResource = (creating: boolean) => ({
  source: 'dynamic', kind: 'config', scope: 'global',
  execution: railwayAccountAction.execution, contentType: 'application/json',
  runtime: createDeploymentTargetOptionsResource({ pluginId: railwayIdentity.id, localId: actionId },
    'deployment.railway.options', draft => ({
      ...(creating ? { creating: true } : {}),
      ...(typeof draft.providerAccountId === 'string' ? { providerAccountId: draft.providerAccountId } : {}),
      ...(typeof draft.railwayEnvironmentId === 'string' ? { railwayEnvironmentId: draft.railwayEnvironmentId } : {}),
    })),
} as const);
export const optionsResources = {
  'target-options': optionResource(false), 'create-options': optionResource(true),
} satisfies NonNullable<DefinePluginInput['resources']>;
const types = ['railway-project', 'railway-environment', 'railway-service'] as const;
const titles = ['Railway project', 'Railway environment', 'Railway service'] as const;
export const optionsInputTypes = {
  'railway-workspace': { title: 'Railway workspace', semantic: 'railway-workspace', valueSchema: id,
    options: { resource: 'target-options' } },
  [types[0]]: { title: titles[0], semantic: types[0], valueSchema: id, options: { resource: 'target-options' } },
  [types[1]]: { title: titles[1], semantic: types[1], valueSchema: id, options: { resource: 'target-options' } },
  [types[2]]: { title: titles[2], semantic: types[2], valueSchema: base.providerEnvironment!, options: { resource: 'target-options' } },
  'railway-create-environment': { title: titles[1], semantic: 'railway-create-environment',
    valueSchema: base.providerEnvironment!, options: { resource: 'create-options' } },
} satisfies NonNullable<DefinePluginInput['inputTypes']>;

export const optionsInputHints = { fields: paths.slice(0, 3).map((path, index) => ({ path, title: titles[index]!, required: true,
  widget: 'select' as const, inputType: { pluginId: railwayIdentity.id, localId: types[index]! },
  optionsDraftDependencies: paths.slice(0, index),
  ...(index === 0 ? {} : { visibleWhen: { op: 'truthy' as const, path: paths[index - 1]! } }),
})) };

export const createOptionsInputHints = { fields: [
  optionsInputHints.fields[0]!,
  { path: 'providerEnvironment', title: titles[1], required: true, widget: 'select' as const,
    inputType: { pluginId: railwayIdentity.id, localId: 'railway-create-environment' },
    optionsDraftDependencies: [paths[0]],
    visibleWhen: { op: 'truthy' as const, path: 'providerAccountId' } },
  { path: 'resourceName', title: 'Service name', widget: 'text' as const, required: true },
  { path: 'productionBranch', title: 'GitHub branch', widget: 'text' as const, required: true },
] };
