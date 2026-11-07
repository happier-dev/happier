import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import * as schemas from './schemas.js';
import * as provider from './provider.js';

export const accountExecution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
const common = { execution: accountExecution, scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['neon-api', provider.purpose], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: provider.purpose }] } as const;
const read = { ...common, dangerLevel: 'safe', readOnly: true } as const;
const write = { ...common, dangerLevel: 'writesRemote', readOnly: false } as const;
const branch = { ...write, surfaces: [...common.surfaces, 'agent'] } as const;
function context(value: PluginAccountActionContext): provider.Context {
  if (!value.services.http) throw new PluginError({ code: 'client_required' });
  return { signal: value.signal, services: { http: value.services.http, secrets: value.services.secrets } };
}

export const dataActions = {
  'projects-list-read': { ...read, title: 'List Neon projects', inputSchema: schemas.inputSchema(schemas.projectListInput), resultSchema: schemas.projectListResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.projects(schemas.readInput(schemas.projectListInput, input), context(ctx)) },
  'provision-options-read': { ...read, title: 'Read Neon project options', inputSchema: schemas.inputSchema(schemas.optionsInput), resultSchema: schemas.optionsResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.options(schemas.readInput(schemas.optionsInput, input), context(ctx)) },
  'projects-link': { ...read, title: 'Prepare the selected Neon project link', inputSchema: schemas.inputSchema(schemas.linkInput), resultSchema: schemas.linkResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.link(schemas.readInput(schemas.linkInput, input), context(ctx)) },
  'projects-provision': { ...write, title: 'Create a Neon project', confirmation: { title: 'Create this Neon database project?' },
    inputSchema: schemas.inputSchema(schemas.provisionInput), resultSchema: schemas.mutationResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.provision(schemas.readInput(schemas.provisionInput, input), context(ctx)) },
  'branches-list-read': { ...read, title: 'Read Neon branches and operation status', inputSchema: schemas.inputSchema(schemas.branchListInput, true), resultSchema: schemas.branchListResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.branches(schemas.readInput(schemas.branchListInput, input), context(ctx)) },
  'branches-create': { ...branch, title: 'Create a Neon preview branch', confirmation: { title: 'Create this preview database branch?' },
    inputSchema: schemas.inputSchema(schemas.createBranchInput, true), resultSchema: schemas.mutationResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.createBranch(schemas.readInput(schemas.createBranchInput, input), context(ctx)) },
  'branches-delete': { ...branch, dangerLevel: 'destructive', title: 'Delete the owned Neon preview branch', confirmation: { title: 'Delete this preview database branch and its data?' },
    inputSchema: schemas.inputSchema(schemas.deleteBranchInput, true), resultSchema: schemas.mutationResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.deleteBranch(schemas.readInput(schemas.deleteBranchInput, input), context(ctx)) },
  'connections-save': { ...write, dangerLevel: 'writesLocal', title: 'Save Neon database connections', confirmation: { title: 'Save these database connections for the reviewed audience?' },
    inputSchema: schemas.inputSchema(schemas.connectionInput, true), resultSchema: schemas.connectionResult,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => provider.saveConnections(schemas.readInput(schemas.connectionInput, input), context(ctx)) },
} as const;
