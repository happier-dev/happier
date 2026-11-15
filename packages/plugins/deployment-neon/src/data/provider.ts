import { PluginError, isPluginError, type DeploymentTargetPreparationBaseV1 } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import type { HttpMethod, HttpService } from '@happier-dev/plugin-sdk/http';
import type { SecretsService } from '@happier-dev/plugin-sdk/secrets';
import type { ConnectionResource, ConnectionResult, Correlation, CreateBranchInput, CreatedSaveIntent, SaveIntent } from './schemas.js';

export const origin = 'https://console.neon.tech';
export const api = `${origin}/api/v2`;
export const purpose = 'deploy-manage';
export type Context = Readonly<{ signal: AbortSignal; services: Readonly<{ http: HttpService; secrets?: SecretsService }> }>;
function secrets(context: Context) {
  if (!context.services.secrets) throw new PluginError({ code: 'secret_save_client_required' });
  return context.services.secrets;
}
function sharedAudience(value: SaveIntent['audience']) {
  return { ...(value.accountGrants ? { accountGrants: [...value.accountGrants] } : {}),
    ...(value.teamGrants ? { teamGrants: [...value.teamGrants] } : {}),
    ...(value.groupGrants ? { groupGrants: [...value.groupGrants] } : {}) };
}
type Input = DeploymentTargetPreparationBaseV1;
type RecordValue = Readonly<Record<string, unknown>>;
export function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError({ code: 'provider_response_invalid' });
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new PluginError({ code: 'provider_response_invalid' });
  return value;
}
function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new PluginError({ code: 'provider_response_invalid' });
  return value;
}
function next(value: RecordValue, kind: 'projects' | 'branches') {
  const pagination = value.pagination === undefined ? {} : record(value.pagination);
  const cursor = pagination[kind === 'projects' ? 'cursor' : 'next'];
  return typeof cursor === 'string' && cursor ? { nextCursor: cursor } : {};
}
function httpStatus(error: unknown, status: number) {
  const details = isPluginError(error) ? error.details : undefined;
  return Boolean(details && typeof details === 'object' && !Array.isArray(details) && 'httpStatus' in details && details.httpStatus === status);
}
const segment = encodeURIComponent;
const projectPath = (id: string) => `/projects/${segment(id)}`;
// Positively pre-target refusals from the host purpose/materialization owners.
// Other HTTP PluginErrors (redirect refusal, response-size failure) may follow a write.
const beforeSendCredentialCodes = new Set(['plugin_connected_account_binding_out_of_scope',
  'plugin_connected_account_purpose_undeclared', 'plugin_host_access_operation_denied', 'credential_unavailable',
  'plugin_fetch_credential_binding_unavailable']);
function unknownCode(error: unknown) {
  if (!isPluginError(error)) return 'outcome_unknown';
  const details = error.details;
  return details && typeof details === 'object' && !Array.isArray(details) && 'causeCode' in details && typeof details.causeCode === 'string'
    ? details.causeCode : error.code;
}
function account(input: Input) { return input.providerIdentity?.providerAccountId ?? input.providerAccountId!; }
function selection(input: Input) {
  // The canonical role admission has already established these selected-link coordinates.
  const identity = input.providerIdentity!;
  return { providerProjectId: identity.providerResourceId,
    branchId: input.providerEnvironment.kind === 'custom' ? input.providerEnvironment.id : identity.providerEnvironment };
}
export async function request(context: Context, path: string, method: HttpMethod = 'GET', body?: unknown): Promise<RecordValue> {
  context.signal.throwIfAborted();
  let response;
  try {
    response = await context.services.http.request({ url: `${api}${path}`, method, redirect: 'error',
      credentialBinding: { kind: 'connectedAccountPurpose', purpose, origin, method, headerNames: ['authorization'] },
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) }) },
    { signal: context.signal });
  } catch (error) {
    if (isPluginError(error) && beforeSendCredentialCodes.has(error.code)) throw error;
    if (method === 'GET') context.signal.throwIfAborted();
    if (method === 'GET' && isPluginError(error)) throw error;
    throw new PluginError({ code: method === 'GET' ? 'provider_request_failed' : 'outcome_unknown',
      ...(isPluginError(error) ? { details: { causeCode: error.code } } : {}),
      failureCause: projectActionFailureCauseV1(error, 'deployment.neon.provider') });
  }
  if (response.finalUrl !== `${api}${path}` || response.status >= 300 && response.status < 400) {
    throw new PluginError({ code: method === 'GET' ? 'provider_response_invalid' : 'outcome_unknown' });
  }
  if (response.status < 200 || response.status >= 300) throw new PluginError({
    code: response.status === 401 || response.status === 403 ? 'deployment_access_denied'
      : method !== 'GET' && response.status >= 500 && response.status !== 503 ? 'outcome_unknown' : 'provider_request_failed',
    details: { httpStatus: response.status }, failureCause: projectActionFailureCauseV1({ response: { status: response.status } }, 'deployment.neon.provider') });
  if (!response.body.byteLength && method === 'DELETE') return {};
  try { return record(JSON.parse(new TextDecoder().decode(response.body))); }
  catch { throw new PluginError({ code: method === 'GET' ? 'provider_response_invalid' : 'outcome_unknown' }); }
}
function projectIdentity(item: RecordValue, organizationId: string) {
  if (item.org_id !== organizationId) throw new PluginError({ code: 'deployment_conflict' });
  return text(item.id);
}
function project(value: unknown, organizationId: string) {
  const item = record(value);
  const id = projectIdentity(item, organizationId);
  return { providerProjectId: id, providerAccountId: organizationId, name: text(item.name), regionId: text(item.region_id),
    engine: 'postgres' as const, ...(typeof item.pg_version === 'number' ? { engineVersion: item.pg_version } : {}),
    providerConsole: { url: `https://console.neon.tech/app/projects/${segment(id)}`, label: 'Open in Neon' } };
}
function branchIdentity(item: RecordValue, projectId: string) {
  if (item.project_id !== projectId) throw new PluginError({ code: 'deployment_conflict' });
  return text(item.id);
}
function branch(value: unknown, projectId: string, operations: readonly { status: string }[] = []) {
  const item = record(value);
  const id = branchIdentity(item, projectId);
  if (typeof item.default !== 'boolean' || typeof item.protected !== 'boolean') throw new PluginError({ code: 'provider_response_invalid' });
  return { branchId: id, providerProjectId: projectId, name: text(item.name), status: text(item.current_state),
    ready: item.current_state === 'ready' && !item.pending_state && operations.every(item => item.status === 'finished' || item.status === 'skipped'),
    ...(typeof item.parent_id === 'string' ? { parentBranchId: item.parent_id } : {}),
    isDefault: item.default === true, protected: item.protected === true };
}
function operations(body: RecordValue) {
  return list(body.operations ?? []).map(value => { const operation = record(value); return { id: text(operation.id), status: text(operation.status) }; });
}
export async function projects(input: Input & { cursor?: string; search?: string; projectId?: string; includeBranches?: boolean }, context: Context) {
  if (input.projectId) {
    const body = await request(context, projectPath(input.projectId));
    const found = project(body.project, account(input));
    if (found.providerProjectId !== input.projectId) throw new PluginError({ code: 'deployment_conflict' });
    if (!input.includeBranches) return { projects: [found], unavailableProjectIds: [] };
    const query = new URLSearchParams();
    if (input.cursor) query.set('cursor', input.cursor);
    const observed = await request(context, `${projectPath(input.projectId)}/branches${query.size ? `?${query}` : ''}`);
    return { projects: [found], unavailableProjectIds: [], branches: list(observed.branches).map(value => branch(value, input.projectId!)),
      ...next(observed, 'branches') };
  }
  const query = new URLSearchParams({ org_id: account(input) });
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.search) query.set('search', input.search);
  const body = await request(context, `/projects?${query}`);
  return { projects: list(body.projects).map(value => project(value, account(input))),
    unavailableProjectIds: list(body.unavailable_project_ids ?? []).map(text), ...next(body, 'projects') };
}
export async function options(input: Input, context: Context) {
  const organizationId = account(input);
  const [organization, regions] = await Promise.all([request(context, `/organizations/${segment(organizationId)}`),
    request(context, `/regions?${new URLSearchParams({ org_id: organizationId })}`)]);
  if (organization.id !== organizationId) throw new PluginError({ code: 'deployment_conflict' });
  return { providerAccountId: organizationId, plan: text(organization.plan), price: 'unknown' as const,
    regions: list(regions.regions).map(value => { const item = record(value); return { id: text(item.region_id), title: text(item.name) }; }) };
}
export async function link(input: Input & { projectId: string; branchId: string }, context: Context) {
  const [projectBody, branchBody] = await Promise.all([request(context, projectPath(input.projectId)),
    request(context, `${projectPath(input.projectId)}/branches/${segment(input.branchId)}`)]);
  const foundProject = project(projectBody.project, account(input));
  const foundBranch = branch(branchBody.branch, input.projectId);
  if (foundProject.providerProjectId !== input.projectId || foundBranch.branchId !== input.branchId) throw new PluginError({ code: 'deployment_conflict' });
  return { status: 'configured' as const, providerProjectId: input.projectId, branchId: input.branchId,
    providerIdentity: { providerAccountId: account(input), providerResourceId: input.projectId, providerEnvironment: input.branchId },
    providerEnvironment: { kind: 'custom' as const, id: input.branchId }, engine: foundProject.engine,
    ...(foundProject.engineVersion === undefined ? {} : { engineVersion: foundProject.engineVersion }),
    providerConsole: foundProject.providerConsole, ready: foundBranch.ready };
}
export async function branches(input: Input & { cursor?: string; search?: string; branchId?: string; operationIds?: readonly string[] }, context: Context) {
  const selected = selection(input);
  const path = `${projectPath(selected.providerProjectId)}/branches`;
  const query = new URLSearchParams();
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.search) query.set('search', input.search);
  const [body, observedOperations] = await Promise.all([
    request(context, input.branchId ? `${path}/${segment(input.branchId)}` : `${path}${query.size ? `?${query}` : ''}`).catch((error): RecordValue => {
      // A deleted branch may disappear before its returned delete operation settles.
      if (input.branchId && input.operationIds?.length && httpStatus(error, 404)) return {};
      throw error;
    }),
    Promise.all((input.operationIds ?? []).map(async id => {
      const body = await request(context, `${projectPath(selected.providerProjectId)}/operations/${segment(id)}`);
      const value = record(body.operation);
      if (value.id !== id || value.project_id !== selected.providerProjectId || value.branch_id !== (input.branchId ?? selected.branchId)) {
        throw new PluginError({ code: 'deployment_conflict' });
      }
      return { id, status: text(value.status) };
    })),
  ]);
  const found = (input.branchId ? body.branch ? [body.branch] : [] : list(body.branches)).map(value => branch(value, selected.providerProjectId, observedOperations));
  if (input.branchId && found.length && found[0]?.branchId !== input.branchId) throw new PluginError({ code: 'deployment_conflict' });
  return { branches: found, operations: observedOperations, ...next(body, 'branches') };
}
/** Branch and project lifecycle keep their Environment coordinate; only provider inspection may omit it. */
function lifecycleEnvironmentId(input: Input): string {
  if (!input.environmentId) throw new PluginError({ code: 'invalid_parameters' });
  return input.environmentId;
}
function annotation(input: Input, correlation: Correlation) {
  // P44 creates the child Environment first, with a same-Environment link to
  // the parent branch. Create returns the preview branch for association there;
  // recovery and teardown keep that child's exact Environment annotation.
  return { 'happier.environment': lifecycleEnvironmentId(input), 'happier.scm.kind': correlation.repository.kind,
    'happier.scm.deployment': correlation.repository.deployment, 'happier.scm.repository': correlation.repository.repository,
    'happier.pullRequest': correlation.pullRequestId };
}
function matches(value: unknown, id: string, expected: Readonly<Record<string, string>>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as RecordValue;
  if (!item.object || typeof item.object !== 'object' || record(item.object).id !== id || !item.value || typeof item.value !== 'object') return false;
  const values = record(item.value);
  return Object.entries(expected).every(([key, value]) => values[key] === value);
}
function savedResult(resource: ConnectionResource, intent: SaveIntent, refs: ConnectionResult['connections'], code?: string): ConnectionResult {
  const incomplete = (['DATABASE_URL', 'DIRECT_URL'] as const).filter(name => !refs[name]);
  return { ...resource, secretId: intent.id, audience: intent.audience, status: incomplete.length ? 'partial' : 'complete',
    connections: refs, incomplete, applicationMode: 'transaction-pooler', migrationMode: 'direct', ...(code ? { code } : {}) };
}
function uri(value: unknown): string {
  const result = text(value);
  let parsed;
  try { parsed = new URL(result); } catch { throw new PluginError({ code: 'provider_response_invalid' }); }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new PluginError({ code: 'provider_response_invalid' });
  return result;
}
export async function saveConnections(input: Input & SaveIntent & { endpointId: string; previous?: ConnectionResult }, context: Context) {
  const resource = { ...selection(input), endpointId: input.endpointId, database: input.database, role: input.role };
  const previous = input.previous;
  if (previous && (Object.entries(resource).some(([key, value]) => previous[key as keyof ConnectionResource] !== value)
    || previous.secretId !== input.id || JSON.stringify(previous.audience) !== JSON.stringify(input.audience))) {
    throw new PluginError({ code: 'deployment_conflict' });
  }
  const refs = { ...previous?.connections };
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    if (refs[name]) continue;
    try {
      const query = new URLSearchParams({ branch_id: resource.branchId, endpoint_id: resource.endpointId,
        database_name: resource.database, role_name: resource.role, pooled: String(name === 'DATABASE_URL') });
      const body = await request(context, `${projectPath(resource.providerProjectId)}/connection_uri?${query}`);
      const bytes = new TextEncoder().encode(uri(body.uri));
      try {
        context.signal.throwIfAborted();
        refs[name] = await secrets(context).saveShared(input.id, { label: input.labels[name], bytes, audience: sharedAudience(input.audience) }, { signal: context.signal });
      }
      finally { bytes.fill(0); }
    } catch (error) {
      if (!refs.DATABASE_URL && !refs.DIRECT_URL) throw error;
      return savedResult(resource, input, refs, context.signal.aborted ? 'cancelled' : isPluginError(error) ? error.code : 'plugin_secret_custody_unavailable');
    }
  }
  return savedResult(resource, input, refs);
}
async function captureCreated(body: RecordValue, projectId: string, branchId: string, input: CreatedSaveIntent, context: Context) {
  let endpointId: string | undefined;
  const refs: { DATABASE_URL?: { ref: string; resourceRevision: number }; DIRECT_URL?: { ref: string; resourceRevision: number } } = {};
  let rolePassword: { role: string; ref: string; resourceRevision: number } | undefined;
  let code: string | undefined;
  try {
    const endpoints = list(body.endpoints ?? []).map(record).filter(endpoint => endpoint.branch_id === branchId && endpoint.type === 'read_write');
    endpointId = endpoints.length === 1 ? text(endpoints[0]!.id) : undefined;
    const returned = list(body.connection_uris ?? []).map(record);
    const selected = returned.filter(item => {
      const parameters = record(item.connection_parameters);
      return parameters.database === input.database && parameters.role === input.role;
    });
    if (selected.length && !endpointId) throw new PluginError({ code: 'provider_response_invalid' });
    // Validate the entire selected set before transferring any one-time bytes.
    const connections: Partial<Record<'DATABASE_URL' | 'DIRECT_URL', string>> = {};
    for (const item of selected) {
      const parameters = record(item.connection_parameters);
      const raw = uri(item.connection_uri);
      const hostname = new URL(raw).hostname;
      const pooled = hostname === parameters.pooler_host;
      const direct = hostname === parameters.host;
      if (pooled === direct) throw new PluginError({ code: 'provider_response_invalid' });
      const name = pooled ? 'DATABASE_URL' : 'DIRECT_URL';
      if (connections[name]) throw new PluginError({ code: 'provider_response_invalid' });
      connections[name] = raw;
    }
    const roles = selected.length ? [] : list(body.roles ?? []).map(record)
      .filter(role => role.branch_id === branchId && role.name === input.role && role.password !== undefined);
    if (roles.length > 1) throw new PluginError({ code: 'provider_response_invalid' });
    const password = roles.length ? text(roles[0]!.password) : undefined;
    if (returned.length && !selected.length && password === undefined) throw new PluginError({ code: 'provider_response_invalid' });
    const save = async (value: string, label: string) => {
      const bytes = new TextEncoder().encode(value);
      try {
        context.signal.throwIfAborted();
        return await secrets(context).saveShared(input.id, { label, bytes, audience: sharedAudience(input.audience) }, { signal: context.signal });
      } finally { bytes.fill(0); }
    };
    // A URI already preserves the selected password. Roles-only responses need
    // separately reviewed custody, never an invented connection string.
    if (password !== undefined) rolePassword = { role: input.role, ...await save(password, input.rolePasswordLabel) };
    for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
      const value = connections[name];
      if (value === undefined) continue;
      context.signal.throwIfAborted();
      refs[name] = await save(value, input.labels[name]);
    }
  } catch (error) {
    code = context.signal.aborted ? 'cancelled' : isPluginError(error) ? error.code : 'plugin_secret_custody_unavailable';
  }
  return { ...(endpointId ? { endpointId, connectionSave: savedResult({ providerProjectId: projectId, branchId, endpointId,
    database: input.database, role: input.role }, input, refs, code) } : {}), ...(rolePassword ? { rolePassword } : {}), ...(code ? { code } : {}) };
}
function configured(input: Input, projectId: string, branchId: string, body: RecordValue, recovered = false) {
  const observedOperations = operations(body);
  const found = branch(body.branch, projectId, observedOperations);
  return { status: 'provisioned' as const, providerProjectId: projectId, branchId, ready: found.ready,
    operationIds: observedOperations.map(item => item.id), recovered, engine: 'postgres' as const,
    providerIdentity: { providerAccountId: account(input), providerResourceId: projectId, providerEnvironment: branchId },
    providerEnvironment: { kind: 'custom' as const, id: branchId } };
}
/** A successful write with unusable metadata is not proof that nothing changed. */
function mutationResponse<T>(project: () => T): T {
  try { return project(); }
  catch (error) { throw new PluginError({ code: 'outcome_unknown',
    details: { causeCode: isPluginError(error) ? error.code : 'provider_response_invalid' } }); }
}
function sameKnownNative(known: { providerProjectId?: string; branchId?: string }, recovered: { providerProjectId: string; branchId: string }) {
  return (known.providerProjectId === undefined || known.providerProjectId === recovered.providerProjectId)
    && (known.branchId === undefined || known.branchId === recovered.branchId);
}
async function recoverBranch(input: Input & CreateBranchInput, context: Context) {
  const selected = input.parentBranchRef ?? selection(input);
  const query = new URLSearchParams({ search: input.name });
  if (input.cursor) query.set('cursor', input.cursor);
  const body = await request(context, `${projectPath(selected.providerProjectId)}/branches?${query}`);
  const expected = annotation(input, input.correlation);
  const annotations = record(body.annotations ?? {});
  const candidates = list(body.branches).map(record).filter(item => item.project_id === selected.providerProjectId
    && item.parent_id === selected.branchId && matches(annotations[text(item.id)], text(item.id), expected));
  const page = next(body, 'branches');
  if (input.cursor || candidates.length !== 1 || page.nextCursor) return { status: 'outcome_unknown' as const, code: 'outcome_unknown', ...page };
  return { ...configured(input, selected.providerProjectId, text(candidates[0]!.id), { branch: candidates[0], operations: [] }, true),
    correlation: input.correlation };
}
// Admission parsed the union; its base branch structurally includes the save branch.
function hasCreatedSaveIntent(input: CreateBranchInput): input is CreateBranchInput & CreatedSaveIntent {
  return 'id' in input;
}
export async function createBranch(input: Input & CreateBranchInput, context: Context) {
  if (input.recover) return recoverBranch(input, context);
  const selected = input.parentBranchRef ?? selection(input);
  const known: { providerProjectId: string; branchId?: string } = { providerProjectId: selected.providerProjectId };
  let captured: Awaited<ReturnType<typeof captureCreated>> = {};
  try {
    const body = await request(context, `${projectPath(selected.providerProjectId)}/branches`, 'POST', {
      branch: { name: input.name, parent_id: selected.branchId, init_source: input.initialization },
      endpoints: [{ type: 'read_write' }], annotation_value: annotation(input, input.correlation) });
    const branchId = mutationResponse(() => branchIdentity(record(body.branch), selected.providerProjectId));
    known.branchId = branchId;
    if (hasCreatedSaveIntent(input)) captured = await captureCreated(body, selected.providerProjectId, branchId, input, context);
    return { ...mutationResponse(() => configured(input, selected.providerProjectId, branchId, body)), correlation: input.correlation, ...captured };
  } catch (error) {
    if (!isPluginError(error) || error.code !== 'outcome_unknown') throw error;
    if (context.signal.aborted) return { status: 'outcome_unknown' as const, ...known, ...captured, code: unknownCode(error) };
    try {
      const recovered = await recoverBranch(input, context);
      if (recovered.status === 'outcome_unknown') return { ...known, ...recovered, ...captured, code: unknownCode(error) };
      if (!sameKnownNative(known, recovered)) return { status: 'outcome_unknown' as const, ...known, ...captured, code: unknownCode(error) };
      return { ...recovered, ...captured };
    } catch { return { status: 'outcome_unknown' as const, ...known, ...captured, code: unknownCode(error) }; }
  }
}
export async function deleteBranch(input: Input & { branchId: string; correlation: Correlation }, context: Context) {
  const selected = selection(input);
  const path = `${projectPath(selected.providerProjectId)}/branches/${segment(input.branchId)}`;
  const body = await request(context, path);
  const found = branch(body.branch, selected.providerProjectId);
  if (found.branchId !== selected.branchId || input.branchId !== selected.branchId || found.isDefault || found.protected
    || !matches(body.annotation, input.branchId, annotation(input, input.correlation))) throw new PluginError({ code: 'deployment_conflict' });
  try {
    const deleted = await request(context, path, 'DELETE');
    const observed = mutationResponse(() => operations(deleted));
    const ready = observed.every(item => item.status === 'finished' || item.status === 'skipped');
    return { status: ready ? 'deleted' as const : 'provisioned' as const, providerProjectId: selected.providerProjectId,
      branchId: input.branchId, ready, operationIds: observed.map(item => item.id) };
  }
  catch (error) {
    if (!isPluginError(error) || error.code !== 'outcome_unknown') throw error;
    if (!context.signal.aborted) {
      try { await request(context, path); }
      catch (observed) {
        if (httpStatus(observed, 404)) {
          return { status: 'deleted' as const, providerProjectId: selected.providerProjectId, branchId: input.branchId, ready: true, operationIds: [] };
        }
      }
    }
    return { status: 'outcome_unknown' as const, providerProjectId: selected.providerProjectId, branchId: input.branchId, code: unknownCode(error) };
  }
}
/** The admitted link owns the exact project identity; names never select deletion. */
export async function deleteProject(input: Input, context: Context) {
  const path = projectPath(input.providerIdentity!.providerResourceId);
  const absent = () => ({ v: 1 as const, state: 'succeeded' as const, observedAtMs: Date.now(), providerResourceAbsent: true as const });
  let writeFailure: unknown;
  try { await request(context, path, 'DELETE'); }
  catch (error) {
    if (httpStatus(error, 404)) return absent();
    if (!isPluginError(error) || error.code !== 'outcome_unknown' && !httpStatus(error, 503)) throw error;
    writeFailure = error;
  }
  if (!context.signal.aborted) {
    try { await request(context, path); }
    catch (error) {
      if (httpStatus(error, 404)) return absent();
      writeFailure ??= error;
    }
  }
  throw new PluginError({ code: 'outcome_unknown',
    failureCause: projectActionFailureCauseV1(writeFailure ?? new PluginError({ code: 'outcome_unknown' }), 'deployment.neon.project.delete'),
  });
}
async function recoverProject(input: Input & { name: string; requestKey: string; cursor?: string }, context: Context) {
  const page = await projects({ ...input, search: input.name }, context);
  const matchesFound: { projectId: string; branch: RecordValue }[] = [];
  let incomplete = Boolean(input.cursor || page.nextCursor);
  for (const candidate of page.projects) {
    const body = await request(context, `${projectPath(candidate.providerProjectId)}/branches`);
    incomplete ||= Boolean(next(body, 'branches').nextCursor);
    const annotations = record(body.annotations ?? {});
    for (const item of list(body.branches).map(record)) {
      if (item.project_id === candidate.providerProjectId && matches(annotations[text(item.id)], text(item.id), {
        'happier.environment': lifecycleEnvironmentId(input), 'happier.operation': input.requestKey,
      })) matchesFound.push({ projectId: candidate.providerProjectId, branch: item });
    }
  }
  if (matchesFound.length !== 1 || incomplete) return { status: 'outcome_unknown' as const, code: 'outcome_unknown', ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  const found = matchesFound[0]!;
  return { ...configured(input, found.projectId, text(found.branch.id), { branch: found.branch, operations: [] }, true),
    providerResourceOrigin: 'created' as const };
}
export async function provision(input: Input & CreatedSaveIntent & { name: string; regionId: string; requestKey: string; recover?: true; cursor?: string }, context: Context) {
  if (input.recover) return recoverProject(input, context);
  const current = await options(input, context);
  if (!current.regions.some(item => item.id === input.regionId)) throw new PluginError({ code: 'deployment_conflict' });
  const known: { providerProjectId?: string; branchId?: string } = {};
  let captured: Awaited<ReturnType<typeof captureCreated>> = {};
  try {
    const body = await request(context, '/projects', 'POST', { project: { name: input.name, org_id: account(input), region_id: input.regionId,
      branch: { database_name: input.database, role_name: input.role,
        annotations: { 'happier.environment': lifecycleEnvironmentId(input), 'happier.operation': input.requestKey } } } });
    const projectId = mutationResponse(() => projectIdentity(record(body.project), account(input)));
    known.providerProjectId = projectId;
    const branchId = mutationResponse(() => branchIdentity(record(body.branch), projectId));
    known.branchId = branchId;
    captured = await captureCreated(body, projectId, branchId, input, context);
    return { ...mutationResponse(() => {
      const created = project(body.project, account(input));
      return { ...configured(input, projectId, branchId, body),
        ...(created.engineVersion === undefined ? {} : { engineVersion: created.engineVersion }), providerConsole: created.providerConsole };
    }), ...captured, providerResourceOrigin: 'created' as const };
  } catch (error) {
    if (!isPluginError(error) || error.code !== 'outcome_unknown') throw error;
    if (context.signal.aborted) return { status: 'outcome_unknown' as const, ...known, ...captured, code: unknownCode(error) };
    try {
      const recovered = await recoverProject(input, context);
      if (recovered.status === 'outcome_unknown') return { ...known, ...recovered, ...captured, code: unknownCode(error) };
      if (!sameKnownNative(known, recovered)) return { status: 'outcome_unknown' as const, ...known, ...captured, code: unknownCode(error) };
      return { ...recovered, ...captured };
    } catch { return { status: 'outcome_unknown' as const, ...known, ...captured, code: unknownCode(error) }; }
  }
}
