import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import type { PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createRailwayProjectOperations, RailwayNativeError } from '@happier-dev/railway-api';
import { projectRailwayFailure, railwayAccountAction, railwayIdentity, railwayRequest } from './account.js';

type AccountAction = PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!;
const text = { type: 'string', minLength: 1 } as const;
const choice = { type: 'object', additionalProperties: false, properties: { id: text, name: text }, required: ['id', 'name'] } as const;
const accountFields = { credentialRef: base.credentialRef!, credentialPrincipal: base.credentialPrincipal! };
const accountKeys = Object.keys(accountFields);
const common = {
  ...railwayAccountAction, dangerLevel: 'writesRemote', readOnly: false,
  surfaces: ['ui', 'agent', 'mcp', 'cli'],
} as const;

function nameOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new PluginError({ code: 'invalid_parameters' });
  return value.trim();
}

function refusal(error: unknown): void {
  if (!(error instanceof RailwayNativeError)) return;
  const native = error.nativeErrorCode;
  const code = native === 'PROJECT_LIMIT_REACHED' || native === 'ENVIRONMENT_LIMIT_REACHED' ? 'railway_plan_limit'
    : native === 'ALREADY_EXISTS' || native === 'CONFLICT' || error.status === 409 ? 'railway_name_taken'
    : native === 'FORBIDDEN' || native === 'UNAUTHENTICATED' || error.status === 401 || error.status === 403
      ? 'deployment_access_denied' : undefined;
  if (code) throw new PluginError({ code, retryable: false });
}

export const railwayScopeCreateActions: Readonly<Record<string, AccountAction>> = {
  'project-create': {
    ...common, title: 'Create Railway project',
    description: 'Create a Railway project in the selected workspace and return its default environment.',
    confirmation: { title: 'Create this Railway project?', body: 'Railway billing may apply.',
      inputFields: [{ path: 'name', title: 'Project name' }, { path: 'workspaceId', title: 'Railway workspace' }] },
    inputHints: { fields: [
      { path: 'name', title: 'Project name', widget: 'text', required: true },
      { path: 'workspaceId', title: 'Railway workspace', widget: 'select', required: true,
        optionsDraftDependencies: [],
        inputType: { pluginId: railwayIdentity.id, localId: 'railway-workspace' } },
    ] },
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...accountFields, name: text, workspaceId: text },
      required: [...accountKeys, 'name', 'workspaceId'] },
    resultSchema: { type: 'object', additionalProperties: false, properties: { project: choice, environment: choice },
      required: ['project', 'environment'] },
    async run(value, context) {
      const input = value as Readonly<{ name: string; workspaceId: string }>;
      const name = nameOf(input.name);
      try {
        return await createRailwayProjectOperations(railwayRequest(context), context.signal).createProject({ name, workspaceId: input.workspaceId });
      } catch (error) {
        refusal(error);
        return projectRailwayFailure(error, context, 'project.create', true);
      }
    },
  },
  'environment-create': {
    ...common, title: 'Create Railway environment',
    description: 'Create an environment in the selected Railway project.',
    confirmation: { title: 'Create this Railway environment?', body: 'Railway billing may apply.',
      inputFields: [{ path: 'name', title: 'Environment name' }, { path: 'projectId', title: 'Railway project' }] },
    inputHints: { fields: [
      { path: 'projectId', title: 'Railway project', widget: 'text', required: true },
      { path: 'name', title: 'Environment name', widget: 'text', required: true },
    ] },
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...accountFields, name: text, projectId: text },
      required: [...accountKeys, 'name', 'projectId'] },
    resultSchema: choice,
    async run(value, context) {
      const input = value as Readonly<{ name: string; projectId: string }>;
      const name = nameOf(input.name);
      try {
        return await createRailwayProjectOperations(railwayRequest(context), context.signal).createEnvironment({ name, projectId: input.projectId });
      } catch (error) {
        refusal(error);
        return projectRailwayFailure(error, context, 'environment.create', true);
      }
    },
  },
};
