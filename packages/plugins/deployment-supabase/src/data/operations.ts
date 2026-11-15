import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { HttpMethod, HttpResponse } from '@happier-dev/plugin-sdk/http';
import type { SharedSecretSaveResult } from '@happier-dev/plugin-sdk/secrets';
import { parseInput } from './schemas.js';
import type { Operands, Operation, Scope } from './schemas.js';

const origin = 'https://api.supabase.com';
const encode = encodeURIComponent;
type Context = PluginAccountActionContext;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function failure(code: string, phase = 'deployment.supabase.provider', caught?: Readonly<{ error: unknown }>): never {
  const result = new PluginError({ code, message: code });
  throw code === 'deployment_unavailable' ? withActionFailureDiagnostic(result, { phase,
    causeKind: caught ? 'native_failure' : 'not_found', error: caught?.error }) : result;
}
// These credential/security refusals are raised before the provider request.
// Other typed HTTP failures (including response-body failures) prove no phase.
const beforeRequestRefusals = new Set(['plugin_connected_account_binding_out_of_scope', 'plugin_connected_account_purpose_undeclared',
  'plugin_host_access_operation_denied', 'credential_unavailable', 'plugin_fetch_credential_binding_unavailable']);
function unknownCause(error: unknown): Record<string, JsonValue> {
  if (!isPluginError(error)) return {};
  const code = error.code === 'outcome_unknown'
    ? object(error.details) && text(error.details.code) ? error.details.code : undefined
    : error.code;
  return code ? { code } : {};
}
const uncertainMutation = (error: unknown) => isPluginError(error)
  && ['outcome_unknown', 'provider_response_invalid', 'deployment_conflict'].includes(error.code);
function account(input: Scope): string {
  const id = input.providerIdentity?.providerAccountId ?? input.providerAccountId;
  return id ?? failure('deployment_invalid');
}
export function resource(input: Scope) {
  if (!input.providerIdentity || input.providerEnvironment.kind !== 'custom') return failure('deployment_invalid');
  return { projectRef: input.providerIdentity.providerResourceId, branchRef: input.providerEnvironment.id };
}
async function readPassword(reference: Operands<'projects-provision'>['password'], context: Context) {
  if (!context.services.secrets) return failure('secret_use_client_required');
  try { return await context.services.secrets.readSavedSecret(reference.ref, { resourceRevision: reference.resourceRevision, signal: context.signal }); }
  catch (error) { return projectMachineProvisionerActionFailure(error, () => failure(context.signal.aborted ? 'operation_cancelled' : 'deployment_unavailable', 'deployment.supabase.secret.read', { error })); }
}

/** Official Management API v1/1.0.0, characterized 2026-10-30 (PROVIDER-API.md).
 * No provider response/error body crosses this boundary without a named projection. */
export async function request(context: Pick<Context, 'signal'> & Readonly<{ services: Pick<Context['services'], 'http'> }>, path: string, method: HttpMethod = 'GET', payload?: unknown, readOnly = false) {
  const readOnlyRequest = method === 'GET' || readOnly;
  context.signal.throwIfAborted();
  if (!context.services.http) return failure('client_required');
  let response: HttpResponse;
  try {
    response = await context.services.http.request({ url: `${origin}${path}`, method, redirect: 'error',
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage', origin, method, headerNames: ['authorization'] },
      ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(payload)) }),
    }, { signal: context.signal });
  } catch (error) {
    const code = isPluginError(error) ? error.code : undefined;
    if (readOnlyRequest) return projectMachineProvisionerActionFailure(error, () => failure(context.signal.aborted ? 'operation_cancelled' : 'deployment_unavailable', 'deployment.supabase.provider', { error }));
    if (code && beforeRequestRefusals.has(code)) throw error;
    throw new PluginError({ code: 'outcome_unknown', message: 'outcome_unknown', ...(code ? { details: { code } } : {}),
      failureCause: projectActionFailureCauseV1(error, 'deployment.supabase.provider') });
  }
  if (response.finalUrl !== `${origin}${path}`) return failure(readOnlyRequest ? 'provider_response_invalid' : 'outcome_unknown');
  if (readOnly && (response.status < 200 || response.status >= 300)) return failure(`provider_http_${response.status}`);
  if (response.status < 200 || response.status >= 300) throw new PluginError({
    code: response.status === 401 || response.status === 403 ? 'deployment_access_denied'
      : response.status === 404 ? 'deployment_unavailable'
        : method !== 'GET' && response.status >= 500 ? 'outcome_unknown' : 'provider_request_failed',
    details: { httpStatus: response.status },
    failureCause: projectActionFailureCauseV1({ response: { status: response.status } }, 'deployment.supabase.provider'),
  });
  try { return JSON.parse(new TextDecoder().decode(response.body)) as unknown; }
  catch { return failure(readOnlyRequest ? 'provider_response_invalid' : 'outcome_unknown'); }
}

function project(value: unknown, organization: string, expectedRef?: string) {
  if (!object(value) || !text(value.ref) || !text(value.organization_slug) || !text(value.name) || !text(value.status)) return failure('provider_response_invalid');
  if (value.organization_slug !== organization || (expectedRef !== undefined && value.ref !== expectedRef)) return failure('deployment_conflict');
  return { ref: value.ref, organizationSlug: value.organization_slug, name: value.name, status: value.status,
    ...(text(value.region) ? { region: value.region } : {}), ...(object(value.database) && text(value.database.version) ? { version: value.database.version } : {}) };
}
function facts(value: ReturnType<typeof project>, branchRef = value.ref) {
  return { state: 'provisioned' as const, ready: value.status === 'ACTIVE_HEALTHY', engine: 'postgres', status: value.status,
    ...(value.version ? { version: value.version } : {}),
    providerIdentity: { providerAccountId: value.organizationSlug, providerResourceId: value.ref, providerEnvironment: branchRef },
    providerEnvironment: { kind: 'custom' as const, id: branchRef },
    providerConsole: { url: `https://supabase.com/dashboard/project/${encode(branchRef)}`, label: 'Open in Supabase' } };
}
function branch(value: unknown, parent: string) {
  if (!object(value) || !text(value.id) || !text(value.project_ref) || !text(value.parent_project_ref) || !text(value.name) || typeof value.persistent !== 'boolean') return failure('provider_response_invalid');
  if (value.parent_project_ref !== parent) return failure('deployment_conflict');
  return { branchId: value.id, projectRef: value.project_ref, parentProjectRef: value.parent_project_ref, name: value.name, persistent: value.persistent,
    ...(text(value.git_branch) ? { gitBranch: value.git_branch } : {}), ...(text(value.preview_project_status) ? { status: value.preview_project_status } : {}) };
}
async function branches(input: Scope, context: Context) {
  const { projectRef } = resource(input);
  const response = await request(context, `/v1/projects/${encode(projectRef)}/branches`);
  if (!Array.isArray(response)) return failure('provider_response_invalid');
  return response.map(value => branch(value, projectRef));
}
async function options(input: Scope & Operands<'provision-options'>, context: Context) {
  const organization = account(input);
  const query = new URLSearchParams({ organization_slug: organization });
  if (input.desiredInstanceSize) query.set('desired_instance_size', input.desiredInstanceSize);
  if (input.continent) query.set('continent', input.continent);
  const [available, entitlementResult] = await Promise.all([
    request(context, `/v1/projects/available-regions?${query}`), request(context, `/v1/organizations/${encode(organization)}/entitlements`),
  ]);
  if (!object(available) || !Array.isArray(available.all) || !object(entitlementResult) || !Array.isArray(entitlementResult.entitlements)) return failure('provider_response_invalid');
  const regions = available.all.map(value => {
    if (!object(value) || !text(value.code) || !text(value.name) || !['specific', 'smartGroup'].includes(String(value.type)) || !text(value.provider)) return failure('provider_response_invalid');
    return { code: value.code, name: value.name, type: String(value.type), provider: value.provider, ...(text(value.status) ? { status: value.status } : {}) };
  });
  // Subscription is fixed by the organization. Entitlements are not a price
  // quote and their open provider payload is never copied into Action output.
  return { organizationSlug: organization, regions, subscription: 'organization', price: 'unknown',
    entitlementsObserved: true, ...(input.desiredInstanceSize ? { desiredInstanceSize: input.desiredInstanceSize } : {}) };
}
async function provision(input: Scope & Operands<'projects-provision'>, context: Context): Promise<JsonValue> {
  const organization = account(input);
  const current = await options(input, context);
  if (!current.regions.some(value => value.type === input.regionSelection.type && value.code === input.regionSelection.code && value.status !== 'unavailable')) return failure('deployment_conflict');
  const password = await readPassword(input.password, context);
  if (!password) return { status: 'unavailable', code: 'database_password_required' };
  let response: unknown;
  try {
    response = await request(context, '/v1/projects', 'POST', { organization_slug: organization, name: input.name, db_pass: password,
      region_selection: input.regionSelection, ...(input.desiredInstanceSize ? { desired_instance_size: input.desiredInstanceSize } : {}) });
    return { ...facts(project(response, organization)), providerResourceOrigin: 'created' };
  } catch (error) {
    // A successful write followed by malformed metadata is still an effect.
    // Keep only an exact native ref whose organization is independently present.
    if (uncertainMutation(error)) return { status: 'outcome_unknown', organizationSlug: organization, ...unknownCause(error),
      ...(object(response) && response.organization_slug === organization && text(response.ref) ? { projectRef: response.ref } : {}),
      recovery: 'Observe the organization catalog and explicitly link the exact project ref. Do not repeat create.' };
    throw error;
  }
}

type Pooler = { host: string; port: number; user: string; database: string; mode: 'transaction' | 'session' };
function poolers(value: unknown): Pooler[] {
  if (!Array.isArray(value)) return failure('provider_response_invalid');
  return value.map(entry => {
    if (!object(entry) || !text(entry.db_host) || typeof entry.db_port !== 'number' || !Number.isInteger(entry.db_port)
      || entry.db_port < 1 || entry.db_port > 65535 || !text(entry.db_user) || !text(entry.db_name)
      || (entry.pool_mode !== 'transaction' && entry.pool_mode !== 'session')) return failure('provider_response_invalid');
    try {
      const endpoint = new URL(`postgresql://${entry.db_host}:${entry.db_port}`);
      if (endpoint.hostname !== entry.db_host || endpoint.port !== String(entry.db_port) || endpoint.username || endpoint.password || endpoint.pathname || endpoint.search || endpoint.hash) return failure('provider_response_invalid');
    } catch { return failure('provider_response_invalid'); }
    return { host: entry.db_host, port: entry.db_port, user: entry.db_user, database: entry.db_name, mode: entry.pool_mode };
  });
}
function uri(endpoint: Pooler, password: string) {
  const url = new URL(`postgresql://${endpoint.host}:${endpoint.port}`);
  url.username = endpoint.user; url.password = password;
  url.pathname = `/${encode(endpoint.database)}`; url.searchParams.set('sslmode', 'require');
  return url.href;
}
async function save(input: Scope & Operands<'connections-save'>, context: Context): Promise<JsonValue> {
  const selected = resource(input);
  if (input.previous && (input.previous.resource.projectRef !== selected.projectRef || input.previous.resource.branchRef !== selected.branchRef
    || input.database !== undefined && input.previous.resource.database !== input.database)) return failure('deployment_conflict');
  if (input.previous?.connections.DATABASE_URL && input.previous.connections.DIRECT_URL) return { status: 'complete', resource: input.previous.resource,
    connections: input.previous.connections, incomplete: [], modes: input.previous.modes };
  const database = input.database ?? input.previous?.resource.database;
  // The database name comes from the selected provider pooler record. With no
  // user selection, only one unambiguous native database can be offered.
  const available = poolers(await request(context, `/v1/projects/${encode(selected.branchRef)}/config/database/pooler`));
  const databases = [...new Set(available.map(value => value.database))];
  const selectedDatabase = database ?? (databases.length === 1 ? databases[0] : undefined);
  if (!selectedDatabase) return { status: 'unavailable', code: 'connection_modes_unavailable', resource: selected, connections: { ...input.previous?.connections } };
  const target = { ...selected, database: selectedDatabase };
  if (input.previous && input.previous.resource.database !== target.database) return failure('deployment_conflict');
  const connections: { DATABASE_URL?: SharedSecretSaveResult; DIRECT_URL?: SharedSecretSaveResult } = { ...input.previous?.connections };
  const modes = { DATABASE_URL: 'Transaction pooler; prepared statements are unavailable', DIRECT_URL: 'Session connection (for migrations)' };
  const output = (code?: string) => {
    const incomplete = (['DATABASE_URL', 'DIRECT_URL'] as const).filter(name => !connections[name]);
    return { status: incomplete.length ? 'partial' as const : 'complete' as const, resource: target, connections, incomplete, modes, ...(code ? { code } : {}) };
  };
  if (connections.DATABASE_URL && connections.DIRECT_URL) return output();
  if (!context.services.secrets) return failure('secret_save_client_required');
  let password: string | undefined;
  if (input.password) password = await readPassword(input.password, context);
  else if (target.branchRef !== target.projectRef) {
    const config = await request(context, `/v1/branches/${encode(target.branchRef)}`);
    if (!object(config) || config.ref !== target.branchRef) return failure('provider_response_invalid');
    if (text(config.db_pass)) password = config.db_pass;
  }
  if (!password) return { status: 'unavailable', code: 'database_password_required', resource: target, connections };
  const candidates = available.filter(value => value.database === target.database);
  const application = candidates.filter(value => value.mode === 'transaction');
  const migration = candidates.filter(value => value.mode === 'session');
  if (application.length !== 1 || migration.length !== 1) return { status: 'unavailable', code: 'connection_modes_unavailable', resource: target, connections };
  const endpoints = { DATABASE_URL: application[0], DIRECT_URL: migration[0] };
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if (connections[name]) continue;
    try {
      connections[name] = await context.services.secrets.saveShared(input.id, { label: input.secrets[name].label,
        bytes: new TextEncoder().encode(uri(endpoints[name], password)), audience: {
          ...(input.audience.accountGrants ? { accountGrants: [...input.audience.accountGrants] } : {}),
          ...(input.audience.teamGrants ? { teamGrants: [...input.audience.teamGrants] } : {}),
          ...(input.audience.groupGrants ? { groupGrants: [...input.audience.groupGrants] } : {}),
        } }, { signal: context.signal });
    } catch (error) {
      // Existing completed refs remain authoritative even if cancellation or
      // custody/storage failure interrupts the second independent save.
      return withActionFailureDiagnostic(output(isPluginError(error) ? error.code : context.signal.aborted ? 'operation_cancelled' : 'deployment_unavailable'),
        { phase: 'deployment.supabase.secret.save', causeKind: 'native_failure', error });
    }
  }
  return output();
}

async function deleteProject(input: Scope, context: Context) {
  const path = `/v1/projects/${encode(input.providerIdentity!.providerResourceId)}`;
  const absent = () => ({ v: 1 as const, state: 'succeeded' as const, observedAtMs: Date.now(), providerResourceAbsent: true as const });
  const notFound = (error: unknown) => isPluginError(error) && object(error.details) && error.details.httpStatus === 404;
  let writeFailure: unknown;
  try { await request(context, path, 'DELETE'); }
  catch (error) {
    if (notFound(error)) return absent();
    if (!isPluginError(error) || error.code !== 'outcome_unknown') throw error;
    writeFailure = error;
  }
  if (!context.signal.aborted) {
    try { await request(context, path); }
    catch (error) {
      if (notFound(error)) return absent();
      writeFailure ??= error;
    }
  }
  throw new PluginError({ code: 'outcome_unknown',
    failureCause: projectActionFailureCauseV1(writeFailure ?? new PluginError({ code: 'outcome_unknown' }), 'deployment.supabase.project.delete'),
  });
}

export async function run<K extends Operation>(operation: K, value: JsonValue, context: Context): Promise<JsonValue> {
  const input = parseInput(operation, value);
  if (context.signal.aborted) return failure('operation_cancelled');
  switch (operation) {
    case 'projects-delete': return deleteProject(input, context);
    case 'projects-list': {
      const response = await request(context, '/v1/projects');
      if (!Array.isArray(response)) return failure('provider_response_invalid');
      return { projects: response.filter(value => object(value) && value.organization_slug === account(input)).map(value => project(value, account(input))) };
    }
    case 'provision-options': return options(input as Scope & Operands<'provision-options'>, context);
    case 'projects-provision': return provision(input as Scope & Operands<'projects-provision'>, context);
    case 'projects-link': {
      const { projectRef } = input as Scope & Operands<'projects-link'>;
      const observed = project(await request(context, `/v1/projects/${encode(projectRef)}`), account(input), projectRef);
      const branchRef = input.providerEnvironment.kind === 'custom' ? input.providerEnvironment.id : projectRef;
      if (branchRef !== projectRef) {
        const response = await request(context, `/v1/projects/${encode(projectRef)}/branches`);
        if (!Array.isArray(response)) return failure('provider_response_invalid');
        const selected = response.map(value => branch(value, projectRef)).find(value => value.projectRef === branchRef);
        if (!selected) return failure('deployment_unavailable', 'deployment.supabase.branch.link');
        return { ...facts(observed, branchRef), ready: selected.status === 'ACTIVE_HEALTHY', status: selected.status ?? 'unknown' };
      }
      return facts(observed);
    }
    case 'branches-list': return { branches: await branches(input, context) };
    case 'branches-create': {
      const operand = input as Scope & Operands<'branches-create'>;
      // Supabase creates from a project ref; the branch UUID is selection
      // metadata and is not a CreateBranchBody operand in Management API v1.
      const selected = { projectRef: operand.parentBranchRef?.providerProjectId ?? resource(input).projectRef };
      let response: unknown;
      try {
        response = await request(context, `/v1/projects/${encode(selected.projectRef)}/branches`, 'POST', {
          branch_name: operand.name, ...(operand.gitBranch ? { git_branch: operand.gitBranch } : {}), persistent: false, with_data: false,
        });
        const created = branch(response, selected.projectRef);
        return { ...created, status: 'provisioned', providerStatus: created.status ?? 'unknown', ready: created.status === 'ACTIVE_HEALTHY',
          providerIdentity: { providerAccountId: account(input), providerResourceId: selected.projectRef, providerEnvironment: created.projectRef },
          providerEnvironment: { kind: 'custom', id: created.projectRef } };
      } catch (error) {
        if (uncertainMutation(error)) return { status: 'outcome_unknown', parentProjectRef: selected.projectRef, ...unknownCause(error),
          ...(object(response) && response.parent_project_ref === selected.projectRef && text(response.project_ref) ? { projectRef: response.project_ref } : {}),
          recovery: 'Observe branches and explicitly adopt an exact known project ref. A name does not prove ownership.' };
        throw error;
      }
    }
    case 'branches-delete': {
      const selected = resource(input);
      if (selected.branchRef === selected.projectRef) return failure('deployment_conflict');
      // Host admission already proved the P44 preview relation and exact data
      // link. Provider metadata supplies native lineage, never caller proof.
      const observed = (await branches(input, context)).find(value => value.projectRef === selected.branchRef);
      if (!observed) return { status: 'deleted', branchProjectRef: selected.branchRef };
      if (observed.persistent) return failure('deployment_conflict');
      try {
        const response = await request(context, `/v1/branches/${encode(selected.branchRef)}`, 'DELETE');
        if (!object(response) || response.message !== 'ok') return failure('outcome_unknown');
        return { status: 'deleted', branchProjectRef: selected.branchRef };
      } catch (error) {
        if (isPluginError(error) && error.code === 'outcome_unknown') {
          if (context.signal.aborted) return { status: 'outcome_unknown', branchProjectRef: selected.branchRef, ...unknownCause(error) };
          try {
            const remaining = await branches(input, context);
            if (!remaining.some(value => value.projectRef === selected.branchRef)) return { status: 'deleted', branchProjectRef: selected.branchRef };
            return { status: 'outcome_unknown', branchProjectRef: selected.branchRef, ...unknownCause(error) };
          } catch (observeError) {
            return withActionFailureDiagnostic({ status: 'outcome_unknown', branchProjectRef: selected.branchRef, code: isPluginError(observeError) ? observeError.code : 'deployment_unavailable' },
              { phase: 'deployment.supabase.branch.observe', causeKind: 'native_failure', error: observeError });
          }
        }
        throw error;
      }
    }
    case 'connections-save': return save(input as Scope & Operands<'connections-save'>, context);
  }
  return failure('unsupported_action');
}
