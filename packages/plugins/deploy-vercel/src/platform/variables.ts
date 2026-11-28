import { vercelRoleSchema, type VercelRoleInput } from './selection.js';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetVariablesReadResultV1ProtocolSchema as readOutput,
  DeploymentTargetVariablesSyncResultV1ProtocolSchema as syncOutput, PluginError,
  type DeploymentTargetVariablesReadInputV1,
  type DeploymentTargetVariablesReadResultV1,
  type JsonValue } from '@happier-dev/plugin-sdk';
import type { DeploymentTargetVariablesSyncInputV1, DeploymentTargetVariablesSyncResultV1 }
  from '@happier-dev/plugin-sdk/deployment-targets';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { vercelEndpoint, vercelRequest } from './operations.js';
import { createDeploymentTargetVariableSyncV1, projectDeploymentTargetVariablesV1,
  type DeploymentTargetObservedVariableV1 } from '@happier-dev/deployment-protocol/v1';

type Read = VercelRoleInput<DeploymentTargetVariablesReadInputV1>;
type Sync = VercelRoleInput<DeploymentTargetVariablesSyncInputV1>;
type FailureCode = DeploymentTargetVariablesSyncResultV1['failures'][number]['code'];
function writeFailureCode(error: unknown): FailureCode {
  if (!isPluginError(error) || error.code === 'outcome_unknown') return 'outcome_unknown';
  // A received refusal carries its native HTTP status.
  return typeof error.data.failureCause?.httpStatus === 'number' ? 'provider_request_failed' : 'outcome_unknown';
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function parsed(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return null; }
}
function io(ctx: PluginAccountActionContext) {
  if (!ctx.services.http) throw new PluginError({ code: 'client_required' });
  return { http: ctx.services.http, signal: ctx.signal, now: () => Date.now() };
}
function scope(input: Read) {
  return input.providerEnvironment.selection;
}
function selected(row: Record<string, unknown>, input: Read): boolean {
  const environment = scope(input);
  if (environment.kind === 'custom') return Array.isArray(row.customEnvironmentIds) && row.customEnvironmentIds.includes(environment.id);
  const targets = typeof row.target === 'string' ? [row.target] : row.target;
  return Array.isArray(targets) && targets.includes(environment.kind)
    && (environment.kind !== 'preview' || (row.gitBranch ?? undefined) === environment.gitBranch);
}
/** Vercel GET may contain value/legacyValue fields; only masked metadata enters the Action result. */
function metadata(row: unknown, input: Read): DeploymentTargetObservedVariableV1 | null {
  if (!record(row) || !selected(row, input) || typeof row.key !== 'string' || typeof row.id !== 'string') return null;
  const providerRevision = typeof row.updatedAt === 'number' || typeof row.updatedAt === 'string' ? String(row.updatedAt) : undefined;
  return { key: row.key, providerId: row.id,
    secret: row.visibility === 'secret' || row.visibility === undefined && row.type !== 'plain',
    ...(providerRevision === undefined ? {} : { providerRevision }) };
}
async function readSnapshot(input: Read, ctx: PluginAccountActionContext) {
  const url = vercelEndpoint(`/v10/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/env`, input.providerIdentity.providerAccountId);
  const response = await vercelRequest(io(ctx), url, ['read', 'GET']);
  if (response.status < 200 || response.status >= 300) throw new PluginError({ code: 'provider_request_failed' });
  const body = parsed(response);
  const rows = record(body) && Array.isArray(body.envs) ? body.envs : Array.isArray(body) ? body : null;
  if (!rows) throw new PluginError({ code: 'provider_response_invalid' });
  const variables = rows.flatMap(row => { const value = metadata(row, input); return value ? [value] : []; });
  // Retain scope coordinates only; discard GET value fields before returning.
  const scopes = new Map(rows.flatMap(row => record(row) && typeof row.id === 'string'
    ? [[row.id, { target: (typeof row.target === 'string' ? [row.target] : Array.isArray(row.target) ? row.target : [])
        .filter((value): value is string => typeof value === 'string'),
      customEnvironmentIds: (Array.isArray(row.customEnvironmentIds) ? row.customEnvironmentIds : [])
        .filter((value): value is string => typeof value === 'string') }] as const] : []));
  return { variables, scopes };
}
async function read(input: Read, ctx: PluginAccountActionContext): Promise<DeploymentTargetVariablesReadResultV1> {
  const observed = await readSnapshot(input, ctx);
  return { v: 1, variables: projectDeploymentTargetVariablesV1(observed.variables, input.owned, { distinctRows: true }) };
}

/** Primary API: Vercel project env GET v10, upsert POST v10 and DELETE v9, checked 2026-11-10. */
async function sync(input: Sync, ctx: PluginAccountActionContext): Promise<DeploymentTargetVariablesSyncResultV1> {
  const observed = await readSnapshot(input, ctx);
  const planned = createDeploymentTargetVariableSyncV1(input, observed.variables);
  for (const binding of planned.set) {
    const key = binding.name;
    const materialized = await planned.materialize(binding, ctx);
    if (!materialized) continue;
    try {
      const environment = scope(input);
      const content = { key, value: materialized.value, type: materialized.secret ? 'sensitive' : 'plain',
        ...(environment.kind === 'custom' ? { customEnvironmentIds: [environment.id] } : { target: [environment.kind],
          ...(environment.kind === 'preview' && environment.gitBranch !== undefined ? { gitBranch: environment.gitBranch } : {}) }) };
      const url = new URL(vercelEndpoint(`/v10/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/env`, input.providerIdentity.providerAccountId));
      url.searchParams.set('upsert', 'true');
      const response = await vercelRequest(io(ctx), url.href, ['write', 'POST'], { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(content)) });
      if (response.status < 200 || response.status >= 300) { planned.fail(key, 'provider_request_failed'); continue; }
      const body = parsed(response);
      const created = record(body) ? metadata(body.created, input) : null;
      if (!created || created.key !== key) { planned.fail(key, 'outcome_unknown'); continue; }
      planned.acknowledgeSet(created);
    } catch (error) {
      planned.fail(key, writeFailureCode(error));
    }
  }
  for (const { key, providerId } of planned.remove) {
    try {
      const environment = scope(input);
      const url = new URL(vercelEndpoint(`/v9/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/env/${encodeURIComponent(providerId)}`, input.providerIdentity.providerAccountId));
      const capturedScope = observed.scopes.get(providerId);
      if (!capturedScope) { planned.fail(key, 'provider_response_invalid'); continue; }
      const target = capturedScope.target.filter(value => environment.kind === 'custom' || value !== environment.kind);
      const customEnvironmentIds = capturedScope.customEnvironmentIds.filter(value => environment.kind !== 'custom' || value !== environment.id);
      // PATCH's optional value keeps other environments' existing secret material.
      // Only a row belonging solely to this selected scope can be deleted whole.
      const response = target.length || customEnvironmentIds.length
        ? await vercelRequest(io(ctx), url.href, ['write', 'PATCH'], { headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ target, customEnvironmentIds })) })
        : await vercelRequest(io(ctx), url.href, ['write', 'DELETE']);
      if (response.status < 200 || response.status >= 300) { planned.fail(key, 'provider_request_failed'); continue; }
      planned.acknowledgeRemove(key);
    } catch (error) {
      planned.fail(key, writeFailureCode(error));
    }
  }
  return planned.result();
}

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], hostAccess: ['vercel-api', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }] } as const;
export const variableActions = {
  'variables-read': { ...common, title: 'Read Vercel variable metadata', dangerLevel: 'safe', readOnly: true,
    inputSchema: vercelRoleSchema(inputs['variables.read'].jsonSchema), resultSchema: readOutput.jsonSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => read(input as unknown as Read, ctx) },
  'variables-sync': { ...common, title: 'Synchronize the reviewed Vercel variables', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Save these variables to Vercel?' },
    inputSchema: vercelRoleSchema(inputs['variables.sync'].jsonSchema), resultSchema: syncOutput.jsonSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => sync(input as unknown as Sync, ctx) },
} as const;
