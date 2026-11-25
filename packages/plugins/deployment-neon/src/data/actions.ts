import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import * as schemas from './schemas.js';
import * as provider from './provider.js';
import { dataInputHints as hints } from './inputs.js';
import { DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';

export const accountExecution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
const common = { execution: accountExecution, scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent'], placementBindings: [],
  hostAccess: ['neon-api', provider.purpose], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: provider.purpose }] } as const;
const read = { ...common, dangerLevel: 'safe', readOnly: true } as const;
const write = { ...common, dangerLevel: 'writesRemote', readOnly: false } as const;
function context(value: PluginAccountActionContext): provider.Context {
  if (!value.services.http) throw new PluginError({ code: 'client_required' });
  return { signal: value.signal, services: { http: value.services.http, secrets: value.services.secrets } };
}

export const dataActions = {
  'projects-observe': { ...read, title: 'Observe the recorded Neon project after deletion',
    description: 'Confirm whether the Neon project named in the deployment link still exists after removal.',
    inputSchema: schemas.inputSchema(schemas.observeProjectInput, true), resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.observeProject(schemas.readInput(schemas.observeProjectInput, input), context(ctx)) },
  'projects-delete': { ...write, dangerLevel: 'destructive', title: 'Delete the recorded Neon project',
    description: 'Delete the Neon project named in the reviewed deployment link, including its data.',
    confirmation: { title: 'Delete this Neon project and all of its data?' },
    inputSchema: schemas.inputSchema(schemas.deleteProjectInput, true), resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.deleteProject(schemas.readInput(schemas.deleteProjectInput, input), context(ctx)) },
  'projects-list-read': { ...read, title: 'List Neon projects',
    description: 'Find projects accessible to the selected Neon connection that can be adopted as a database target.', inputSchema: schemas.inputSchema(schemas.projectListInput), resultSchema: schemas.projectListResult,
    inputHints: { fields: [hints.account] },
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.projects(schemas.readInput(schemas.projectListInput, input), context(ctx)) },
  'provision-options-read': { ...read, title: 'Read Neon project options',
    description: 'Read available Neon organizations and regions for a new database project.', inputSchema: schemas.inputSchema(schemas.optionsInput), resultSchema: schemas.optionsResult,
    inputHints: { fields: [hints.account] },
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.options(schemas.readInput(schemas.optionsInput, input), context(ctx)) },
  'projects-link': { ...read, title: 'Prepare the selected Neon project link',
    description: 'Verify the selected Neon project and branch and return the database target information required to link them.', inputSchema: schemas.inputSchema(schemas.linkInput), resultSchema: schemas.linkResult,
    inputHints: { fields: [hints.account, hints.project, hints.branch] },
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.link(schemas.readInput(schemas.linkInput, input), context(ctx)) },
  'projects-provision': { ...write, title: 'Create a Neon project',
    description: 'Provision a Neon project in the reviewed organization and region and return the selected database target.', confirmation: { title: 'Create this Neon database project?' },
    inputHints: { fields: [hints.account, hints.region, ...hints.save.filter(field => field.path !== 'previous')] },
    inputSchema: schemas.inputSchema(schemas.provisionInput), resultSchema: schemas.mutationResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.provision(schemas.readInput(schemas.provisionInput, input), context(ctx)) },
  'branches-list-read': { ...read, title: 'Read Neon branches and operation status',
    description: 'Read branches of the linked Neon project and identify branch operations still in progress.', inputSchema: schemas.inputSchema(schemas.branchListInput, true), resultSchema: schemas.branchListResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.branches(schemas.readInput(schemas.branchListInput, input), context(ctx)) },
  'branches-create': { ...write, title: 'Create a Neon preview branch',
    description: 'Create a preview branch from the reviewed parent branch in the linked Neon project.', confirmation: { title: 'Create this preview database branch?' },
    inputSchema: schemas.inputSchema(schemas.createBranchInput, true), resultSchema: schemas.mutationResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.createBranch(schemas.readInput(schemas.createBranchInput, input), context(ctx)) },
  'branches-delete': { ...write, dangerLevel: 'destructive', title: 'Delete the owned Neon preview branch',
    description: 'Delete the reviewed preview branch Happier owns in the linked Neon project.', confirmation: { title: 'Delete this preview database branch and its data?' },
    inputSchema: schemas.inputSchema(schemas.deleteBranchInput, true), resultSchema: schemas.mutationResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.deleteBranch(schemas.readInput(schemas.deleteBranchInput, input), context(ctx)) },
  'connections-save': { ...write, dangerLevel: 'writesLocal', title: 'Save Neon database connections',
    description: 'Save connection material for the reviewed Neon branch and database audience.', confirmation: { title: 'Save these database connections for the reviewed audience?' },
    inputHints: { fields: hints.save },
    inputSchema: schemas.inputSchema(schemas.connectionInput, true), resultSchema: schemas.connectionResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.saveConnections(schemas.readInput(schemas.connectionInput, input), context(ctx)) },
} as const;
