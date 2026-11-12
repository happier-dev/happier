import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetVariablesReadResultV1ProtocolSchema as readOutput,
  DeploymentTargetVariablesSyncResultV1ProtocolSchema as syncOutput, PluginError,
  type DeploymentTargetVariablesReadInputV1, type DeploymentTargetVariablesSyncInputV1,
  type DeploymentTargetVariablesReadResultV1, type DeploymentTargetVariablesSyncResultV1,
  type DeploymentTargetVariableMetadataV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { vercelEndpoint, vercelRequest } from './operations.js';

type Read = DeploymentTargetVariablesReadInputV1;
type Sync = DeploymentTargetVariablesSyncInputV1;
type Metadata = DeploymentTargetVariableMetadataV1;
type FailureCode = DeploymentTargetVariablesSyncResultV1['failures'][number]['code'];
function writeFailureCode(error: unknown): FailureCode {
  if (!isPluginError(error)) return 'outcome_unknown';
  if (error.code === 'secret_use_client_required' || error.code === 'secret_missing'
    || error.code === 'plugin_secret_custody_unavailable') return error.code;
  // The shared request owner retained a received provider refusal; it is not a lost acknowledgement.
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
  const environment = input.providerEnvironment;
  if (environment.kind === 'script' || 'scriptName' in environment) throw new PluginError({ code: 'unsupported_action' });
  return environment;
}
function selected(row: Record<string, unknown>, input: Read): boolean {
  const environment = scope(input);
  if (environment.kind === 'custom') return Array.isArray(row.customEnvironmentIds) && row.customEnvironmentIds.includes(environment.id);
  const targets = typeof row.target === 'string' ? [row.target] : row.target;
  return Array.isArray(targets) && targets.includes(environment.kind)
    && (environment.kind !== 'preview' || (row.gitBranch ?? undefined) === environment.gitBranch);
}
/** Vercel GET may contain value/legacyValue fields; only masked metadata enters the Action result. */
function metadata(row: unknown, input: Read): Metadata | null {
  if (!record(row) || !selected(row, input) || typeof row.key !== 'string' || typeof row.id !== 'string') return null;
  const owned = input.owned.find(value => value.key === row.key && value.providerId === row.id);
  const providerRevision = typeof row.updatedAt === 'number' || typeof row.updatedAt === 'string' ? String(row.updatedAt) : undefined;
  return { key: row.key, providerId: row.id, present: true,
    secret: row.visibility === 'secret' || row.visibility === undefined && row.type !== 'plain', owned: owned !== undefined,
    drift: !owned?.providerRevision || !providerRevision ? 'unknown' : owned.providerRevision === providerRevision ? 'current' : 'changed',
    ...(providerRevision === undefined ? {} : { providerRevision }) };
}
async function readSnapshot(input: Read, ctx: PluginAccountActionContext) {
  const url = vercelEndpoint(`/v10/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/env`, input.providerIdentity.providerAccountId);
  const response = await vercelRequest(io(ctx), url, 'GET');
  if (response.status < 200 || response.status >= 300) throw new PluginError({ code: 'provider_request_failed' });
  const body = parsed(response);
  const rows = record(body) && Array.isArray(body.envs) ? body.envs : Array.isArray(body) ? body : null;
  if (!rows) throw new PluginError({ code: 'provider_response_invalid' });
  const variables = rows.flatMap(row => { const value = metadata(row, input); return value ? [value] : []; });
  for (const owned of input.owned) if (!variables.some(value => value.providerId === owned.providerId && value.key === owned.key)) {
    variables.push({ key: owned.key, providerId: owned.providerId, owned: true, present: false, secret: true, drift: 'changed' });
  }
  // Retain scope coordinates only; discard GET value fields before returning.
  const scopes = new Map(rows.flatMap(row => record(row) && typeof row.id === 'string'
    ? [[row.id, { target: (typeof row.target === 'string' ? [row.target] : Array.isArray(row.target) ? row.target : [])
        .filter((value): value is string => typeof value === 'string'),
      customEnvironmentIds: (Array.isArray(row.customEnvironmentIds) ? row.customEnvironmentIds : [])
        .filter((value): value is string => typeof value === 'string') }] as const] : []));
  return { variables, scopes };
}
async function read(input: Read, ctx: PluginAccountActionContext): Promise<DeploymentTargetVariablesReadResultV1> {
  return { v: 1, variables: (await readSnapshot(input, ctx)).variables };
}

/** Primary API: Vercel project env GET v10, upsert POST v10 and DELETE v9, checked 2026-11-10. */
async function sync(input: Sync, ctx: PluginAccountActionContext): Promise<DeploymentTargetVariablesSyncResultV1> {
  const observed = await readSnapshot(input, ctx);
  const owned = new Map(input.owned.map(value => [value.key, value]));
  const variables = new Map<string, Metadata>();
  for (const value of observed.variables) {
    const previous = variables.get(value.key);
    if (!previous || value.present && !previous.present) variables.set(value.key, value);
  }
  const failures: DeploymentTargetVariablesSyncResultV1['failures'] = [];
  const failed = (key: string, code: FailureCode) => { failures.push({ key, code }); };
  const keep = new Set(input.keepTheirs);
  for (const key of keep) {
    owned.delete(key);
    const value = variables.get(key);
    if (value) variables.set(key, { ...value, owned: false, drift: 'unknown' });
  }
  const desired = new Map<string, Sync['set'][number]>();
  const conflicts = new Set<string>();
  for (const binding of input.set) {
    const previous = desired.get(binding.name);
    if (previous && JSON.stringify(previous.source) !== JSON.stringify(binding.source)) conflicts.add(binding.name);
    desired.set(binding.name, binding);
  }
  for (const [key, binding] of desired) {
    if (keep.has(key)) continue;
    const current = variables.get(key);
    if (conflicts.has(key) || current?.present && (current.drift === 'changed' || !current.owned) && !input.useOurs.includes(key)) {
      failed(key, 'deployment_conflict'); continue;
    }
    if (binding.source.kind !== 'secret' && binding.source.kind !== 'value') { failed(key, 'deployment_content_unavailable'); continue; }
    try {
      const environment = scope(input);
      // The invocation-bound service acquires admitted Secrets and registers
      // their raw/JSON forms with the host's result and log redactor (P42-C15).
      const value = binding.source.kind === 'secret'
        ? await ctx.services.secrets.readSavedSecret(binding.source.ref, {
          resourceRevision: binding.source.resourceRevision, signal: ctx.signal,
        })
        : binding.source.value;
      const content = { key, value, type: binding.source.kind === 'secret' ? 'sensitive' : 'plain',
        ...(environment.kind === 'custom' ? { customEnvironmentIds: [environment.id] } : { target: [environment.kind],
          ...(environment.kind === 'preview' && environment.gitBranch !== undefined ? { gitBranch: environment.gitBranch } : {}) }) };
      const url = new URL(vercelEndpoint(`/v10/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/env`, input.providerIdentity.providerAccountId));
      url.searchParams.set('upsert', 'true');
      const response = await vercelRequest(io(ctx), url.href, 'POST', { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(content)) });
      if (response.status < 200 || response.status >= 300) { failed(key, 'provider_request_failed'); continue; }
      const body = parsed(response);
      const created = record(body) ? metadata(body.created, { ...input, owned: [] }) : null;
      if (!created || created.key !== key) { failed(key, 'outcome_unknown'); continue; }
      const provenance = { key, providerId: created.providerId, desiredRevision: input.desiredRevision,
        ...(created.providerRevision === undefined ? {} : { providerRevision: created.providerRevision }) };
      owned.set(key, provenance);
      variables.set(key, { ...created, owned: true, drift: created.providerRevision === undefined ? 'unknown' : 'current' });
    } catch (error) {
      failed(key, writeFailureCode(error));
    }
  }
  for (const key of input.remove) {
    const provenance = owned.get(key);
    if (!provenance || keep.has(key) || desired.has(key)) continue;
    const current = observed.variables.find(value => value.key === key && value.providerId === provenance.providerId);
    if (current?.drift === 'changed' && current.present && !input.useOurs.includes(key)) { failed(key, 'deployment_conflict'); continue; }
    if (!current?.present) {
      owned.delete(key);
      if (variables.get(key)?.providerId === provenance.providerId) variables.delete(key);
      continue;
    }
    try {
      const environment = scope(input);
      const url = new URL(vercelEndpoint(`/v9/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/env/${encodeURIComponent(provenance.providerId)}`, input.providerIdentity.providerAccountId));
      const capturedScope = observed.scopes.get(provenance.providerId);
      if (!capturedScope) { failed(key, 'provider_response_invalid'); continue; }
      const target = capturedScope.target.filter(value => environment.kind === 'custom' || value !== environment.kind);
      const customEnvironmentIds = capturedScope.customEnvironmentIds.filter(value => environment.kind !== 'custom' || value !== environment.id);
      // PATCH's optional value keeps other environments' existing secret material.
      // Only a row belonging solely to this selected scope can be deleted whole.
      const response = target.length || customEnvironmentIds.length
        ? await vercelRequest(io(ctx), url.href, 'PATCH', { headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode(JSON.stringify({ target, customEnvironmentIds })) })
        : await vercelRequest(io(ctx), url.href, 'DELETE');
      if (response.status < 200 || response.status >= 300) { failed(key, 'provider_request_failed'); continue; }
      owned.delete(key); variables.delete(key);
    } catch (error) { failed(key, writeFailureCode(error)); }
  }
  return { v: 1, owned: [...owned.values()], variables: [...variables.values()], failures };
}

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [], hostAccess: ['vercel-api', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }] } as const;
export const variableActions = {
  'variables-read': { ...common, title: 'Read Vercel variable metadata', dangerLevel: 'safe', readOnly: true,
    inputSchema: inputs['variables.read'].jsonSchema, resultSchema: readOutput.jsonSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => read(input as unknown as Read, ctx) },
  'variables-sync': { ...common, title: 'Synchronize the reviewed Vercel variables', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Save these variables to Vercel?' },
    inputSchema: inputs['variables.sync'].jsonSchema, resultSchema: syncOutput.jsonSchema,
    run: (input: JsonValue, ctx: PluginAccountActionContext) => sync(input as unknown as Sync, ctx) },
} as const;
