import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import axios from '@/api/client/credentialAxios';

import {
  PROJECT_ACCOUNT_ROWS_ROUTE_V1, PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1,
  ProjectAccountRowListResponseV1Schema, ProjectAccountRowReadResponseV1Schema, ProjectAccountRowMutationRequestV1Schema,
  ProjectAccountRowMutationResponseV1Schema,
  assertProjectAccountRowPayloadBindingV1,
  buildProjectAccountRowPhysicalKeyV1,
  type ProjectAccountRowKeyV1, type ProjectAccountRowPayloadV1,
  type ProjectAccountRowContentV1, type ProjectAccountOrganizationV1,
  type ProjectAccountRowMutationRequestV1, type ProjectAccountRowMutationResponseV1,
  type ProjectAccountRowListRequestV1, type ProjectAccountRowV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import {
  assertProjectAccountSnapshotTransition, parseProjectAccountSnapshotV1,
  type ProjectAccountSnapshotV1,
} from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import type { StoredCredentials } from '@/persistence';
import { AccountSettingsEncryptionMaterialUnavailableError, hasUsableAccountSettingsEncryptionMaterial, requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { isPromptStackSystemAppendPlacementV1 } from '@happier-dev/protocol/prompts/library/promptPlacementV1';
import { migrateStackSkillRulesV1, readStackSkillIdsV1, unconsumedStackSkillEntriesV1 } from '@happier-dev/protocol/prompts/library/skills/convertStackSkillEntriesV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { refreshActivePromptLibraryCatalogAfterChange } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createHttpStatusError } from '@/api/client/httpStatusError';

export type OpenedProjectAccountRow = Readonly<{ key: ProjectAccountRowKeyV1; revision: number; payload: ProjectAccountRowPayloadV1 | null }>;
export type ActiveProjectAccountRowsSnapshot = ProjectAccountSnapshotV1 & Readonly<{
  source: 'network';
  organizations: readonly Readonly<{
    key: Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>;
    revision: number;
    value: ProjectAccountOrganizationV1;
  }>[];
  rows: readonly OpenedProjectAccountRow[];
  graphRevision: number | 'absent';
  loadedAtMs: number;
  scopeKey: string;
}>;
export type ProjectAccountRowsSnapshotListener = (previous: ActiveProjectAccountRowsSnapshot | null, next: ActiveProjectAccountRowsSnapshot | null) => void;
let active: ActiveProjectAccountRowsSnapshot | null = null;
const listeners = new Set<ProjectAccountRowsSnapshotListener>();
export function getActiveProjectAccountRowsSnapshot(): ActiveProjectAccountRowsSnapshot | null { return active; }
export function subscribeActiveProjectAccountRowsSnapshot(listener: ProjectAccountRowsSnapshotListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function replaceProjectFacts<T>(previous: readonly T[], incoming: readonly T[], changed: ReadonlySet<string>, order: Iterable<string>, identity: (value: T) => string): readonly T[] {
  if (changed.size === 0) return previous;
  const facts = new Map(previous.map(value => [identity(value), value]));
  const replacements = new Map(incoming.filter(value => changed.has(identity(value))).map(value => [identity(value), value]));
  for (const key of changed) {
    const replacement = replacements.get(key);
    if (replacement === undefined) facts.delete(key); else facts.set(key, replacement);
  }
  // Tombstones retain their physical slot; restoring one also restores its
  // projection position rather than appending after unaffected facts.
  const result: T[] = [];
  for (const key of order) {
    const fact = facts.get(key);
    if (fact !== undefined) result.push(fact);
  }
  return result;
}
function mergeProjectSnapshots(previous: ActiveProjectAccountRowsSnapshot, incoming: ActiveProjectAccountRowsSnapshot): ActiveProjectAccountRowsSnapshot {
  const rows = new Map(previous.rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row]));
  const refs = new Set<string>();
  const organizations = new Set<string>();
  let graphChanged = false;
  for (const row of incoming.rows) {
    const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
    const known = rows.get(identity);
    if (!known || row.revision > known.revision) {
      rows.set(identity, row);
      if (row.key.kind === 'workspace-ref') refs.add(identity);
      else if (row.key.kind === 'project-organization') organizations.add(identity);
      else graphChanged = true;
    }
  }
  // Admitted rows and their projected facts are immutable within a revision.
  if (refs.size === 0 && organizations.size === 0 && !graphChanged) return previous;
  const workspaceRefs = replaceProjectFacts(previous.workspaceRefs, incoming.workspaceRefs, refs, rows.keys(),
    ref => buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id: ref.id }));
  const relationships = graphChanged ? incoming.relationships : previous.relationships;
  // Organization updates cannot change topology. Validate the winning graph
  // and endpoints together only when one of those domains actually changed.
  const topology = refs.size > 0 || graphChanged ? parseProjectAccountSnapshotV1({ workspaceRefs, relationships }) : previous;
  return { ...incoming, workspaceRefs: topology.workspaceRefs, relationships: topology.relationships,
    rows: [...rows.values()], graphRevision: graphChanged ? incoming.graphRevision : previous.graphRevision,
    organizations: replaceProjectFacts(previous.organizations, incoming.organizations, organizations, rows.keys(),
      organization => buildProjectAccountRowPhysicalKeyV1(organization.key)) };
}
function publish(snapshot: ActiveProjectAccountRowsSnapshot): ActiveProjectAccountRowsSnapshot;
function publish(snapshot: null): null;
function publish(snapshot: ActiveProjectAccountRowsSnapshot | null): ActiveProjectAccountRowsSnapshot | null {
  const previous = active;
  if (snapshot === previous) return previous;
  if (snapshot && previous?.scopeKey === snapshot.scopeKey) {
    snapshot = mergeProjectSnapshots(previous, snapshot);
    if (snapshot === previous) return previous;
  }
  active = snapshot;
  for (const listener of listeners) {
    try { listener(previous, snapshot); }
    catch { /* Publication is already accepted; a consumer wake cannot roll it back. */ }
  }
  return snapshot;
}
export function withdrawActiveProjectAccountRowsSnapshot(): void { publish(null); }
function rowError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
/** Private admitted Session custody, separate from a finite Action's signed HTTP port. */
export type ProjectAccountSessionCustody = Readonly<{ serverId: string; accountId: string; serverHttpBaseUrl: string; isCurrent(): Promise<boolean> }>;
export type ProjectAccountRowsInput = Readonly<({ credentials: StoredCredentials; sessionCustody?: ProjectAccountSessionCustody; authorization?: never; effectActionId?: never }
  | { credentials?: never; sessionCustody?: never; authorization: ExternalActionExecutionAuthorizationV1; effectActionId: string })
  & { serverId?: string; signal?: AbortSignal;
    /** Installed Account owners may establish or recover the global projection. Other raw reads must match its scope. */
    publication?: 'installed';
    /** A host-owned effect also retains its captured Machine/lifecycle authority at each HTTP admission. */
    assertCurrentAuthority?: () => Promise<void> }>;
export type ProjectAccountRowsSelection = Readonly<{ key: ProjectAccountRowKeyV1 }>
  | Readonly<{ kinds: NonNullable<ProjectAccountRowListRequestV1['kinds']>; serverId?: string }>;
export type ProjectAccountRowsReadInput = ProjectAccountRowsInput & (
  Readonly<{ selection: ProjectAccountRowsSelection; changedKeys?: never }>
  // Only the installed owner establishes or recovers completeness. A finite
  // requester must name its projection, even when its Account is installed.
  | Readonly<{ publication: 'installed'; sessionCustody?: never; authorization?: never; selection?: never;
    changedKeys?: readonly ProjectAccountRowKeyV1[] }>
);
export type ProjectRuntimeAccountAccess = Readonly<{ credentials: StoredCredentials; sessionCustody?: ProjectAccountSessionCustody; accountAuthorization?: never }>
  | Readonly<{ credentials?: never; accountAuthorization: ExternalActionExecutionAuthorizationV1 }>;

/** Preparation reads spend the captured root, which may enclose an approved unsigned effect. */
export function projectRuntimeAccountRowsInput(runtime: ProjectRuntimeAccountAccess): ProjectAccountRowsInput {
  return runtime.accountAuthorization ? { authorization: runtime.accountAuthorization,
    effectActionId: runtime.accountAuthorization.binding.actionId }
    : { credentials: runtime.credentials, ...(runtime.sessionCustody ? { sessionCustody: runtime.sessionCustody } : {}) };
}
type ReadInput = ProjectAccountRowsInput;
async function assertRequesterCurrent(input: ReadInput): Promise<void> {
  await input.assertCurrentAuthority?.();
  if (input.sessionCustody && (!await input.sessionCustody.isCurrent()
    || input.serverId && !await isServerProfileHomeIdentity(input.sessionCustody.serverId, input.serverId))) {
    throw rowError('project_requester_authority_unavailable');
  }
  input.signal?.throwIfAborted();
  if (!input.authorization) return;
  const account = input.authorization.requesterAccountProjection;
  const http = input.authorization.requesterHttpProjection;
  if (!account || !http || account.accountId !== input.authorization.binding.accountId || http.accountId !== account.accountId
    || account.serverId !== http.serverId || input.serverId && !await isServerProfileHomeIdentity(account.serverId, input.serverId)
    || http.accountEncryptionMode !== undefined && account.accountEncryptionMode !== http.accountEncryptionMode
    || input.authorization.binding.accountEncryptionMode !== undefined && account.accountEncryptionMode !== input.authorization.binding.accountEncryptionMode
    || !await account.isCurrent() || !await http.isCurrent()) throw rowError('project_requester_authority_unavailable');
  input.signal?.throwIfAborted();
}
async function requestHeaders(input: ReadInput, path: string, body: unknown) {
  await assertRequesterCurrent(input);
  if (!input.authorization) return headers(input.credentials);
  const result = await input.authorization.requesterHttpProjection!.createRequestHeaders({
    effectActionId: input.effectActionId, method: 'POST', path, body, ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!result) throw rowError('project_requester_authority_unavailable');
  return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...result, 'Content-Type': 'application/json' };
}
function baseUrl(input: ReadInput) { return input.authorization?.requesterHttpProjection?.serverHttpBaseUrl
  ?? input.sessionCustody?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(); }
function scopeKey(input: ReadInput) {
  return `${input.serverId ?? configuration.activeServerId}:${input.authorization?.requesterAccountProjection?.accountId ?? input.sessionCustody?.accountId
    ?? resolveAccountSettingsScopeKey(input.credentials!)}`;
}
function canPublish(input: ReadInput): boolean {
  // Credentials alone establish read authority, never a new daemon Account scope.
  return !input.authorization && !input.sessionCustody
    && (input.publication === 'installed' || active?.scopeKey === scopeKey(input));
}
async function withSnapshotReadFailurePolicy<T>(input: ReadInput, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    // Transient refresh failure retains accepted rows; hard admission/content refusal withdraws them.
    if (!classifyServerEndpointError(error).retryable
      && canPublish(input) && (!active || active.scopeKey === scopeKey(input))) withdrawActiveProjectAccountRowsSnapshot();
    throw error;
  }
}
function acceptSnapshot(input: ReadInput & Readonly<{ selection?: ProjectAccountRowsSelection }>, snapshot: ActiveProjectAccountRowsSnapshot) {
  if (input.selection) {
    // An isolated ref deletion cannot be merged against an older graph. Only
    // complete topology reads may refresh its installed projection; finite
    // refs/organization consumers still receive their freshly admitted rows.
    const selection = input.selection;
    const completeTopology = !('key' in selection) && !selection.serverId
      && selection.kinds.includes('workspace-ref') && selection.kinds.includes('relationship-graph');
    if (completeTopology && canPublish(input) && active?.scopeKey === snapshot.scopeKey) publish(snapshot);
    return snapshot;
  }
  return canPublish(input) ? publish(snapshot) : snapshot;
}
async function acceptMutationSnapshot(input: ReadInput, snapshot: ActiveProjectAccountRowsSnapshot) {
  // A retained requester Session writes with its own Account custody. Its
  // acknowledged rows also settle an already installed projection of that
  // same Account/Home; private reads still cannot establish that projection.
  const installed = active;
  if (input.sessionCustody && installed
    && installed.scopeKey === `${configuration.activeServerId}:${resolveAccountSettingsScopeKey(input.credentials)}`
    && await isServerProfileHomeIdentity(configuration.activeServerId, input.serverId ?? input.sessionCustody.serverId)
    && active?.scopeKey === installed.scopeKey) {
    publish({ ...snapshot, scopeKey: installed.scopeKey });
    return snapshot;
  }
  return acceptSnapshot(input, snapshot);
}
function selectedProjection(snapshot: ActiveProjectAccountRowsSnapshot, selection: ProjectAccountRowsSelection) {
  if ('key' in selection) {
    const key = selection.key;
    if (key.kind === 'workspace-ref') return resolveWorkspaceRefById(snapshot.workspaceRefs, key.id, key.serverId);
    if (key.kind === 'relationship-graph') return snapshot.relationships;
    return snapshot.organizations.find(row => row.key.serverId === key.serverId && row.key.projectKey === key.projectKey);
  }
  // The installed owner already projects these domains. A refs-only fence must
  // not scan unrelated organization rows merely to observe its selected refs.
  return {
    workspaceRefs: selection.kinds.includes('workspace-ref')
      ? selection.serverId ? snapshot.workspaceRefs.filter(ref => ref.serverId === selection.serverId) : snapshot.workspaceRefs : undefined,
    relationships: selection.kinds.includes('relationship-graph') ? snapshot.relationships : undefined,
    organizations: selection.kinds.includes('project-organization')
      ? selection.serverId ? snapshot.organizations.filter(row => row.key.serverId === selection.serverId) : snapshot.organizations : undefined,
  };
}
function headers(credentials: StoredCredentials) {
  return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' };
}
function cryptoMaterial(credentials: StoredCredentials) {
  const encryption = requireAccountSettingsEncryptionCredentials(credentials).encryption;
  return encryption.type === 'legacy'
    ? { type: 'legacy' as const, secret: encryption.secret }
    : { type: 'dataKey' as const, machineKey: encryption.machineKey };
}
/**
 * `identity` (snapshot reads only) borrows the held Account observation; mutations keep the
 * default fresh read until their seal moves under the server write fence (P03 R2).
 */
async function readMode(input: ReadInput, usage: 'identity' | 'fresh-authority' = 'fresh-authority'): Promise<'plain' | 'e2ee'> {
  await assertRequesterCurrent(input);
  if (input.authorization) {
    return input.authorization.requesterAccountProjection!.accountEncryptionMode;
  }
  const result = await readAccountEncryptionModeOnce({
    credentials: input.credentials, usage,
    ...(input.credentials ? { scope: { token: input.credentials.token, serverBaseUrl: baseUrl(input), signal: input.signal } } : {}),
    request: () => axios.get(`${baseUrl(input)}/v1/account/encryption`, {
    headers: headers(input.credentials), validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}),
  }) });
  if (result.kind === 'http_error') throw createHttpStatusError(result.status, 'Project Account mode is unavailable',
    result.status >= 500 ? 'project_account_rows_unavailable' : 'project_account_mode_unavailable');
  if (result.kind !== 'resolved') throw rowError('project_account_mode_unavailable');
  if (result.mode === 'e2ee' && !hasUsableAccountSettingsEncryptionMaterial(input.credentials)) throw new AccountSettingsEncryptionMaterialUnavailableError();
  return result.mode;
}
function openRow(key: ProjectAccountRowKeyV1, content: ProjectAccountRowContentV1, mode: 'plain' | 'e2ee', input: ReadInput): ProjectAccountRowPayloadV1 {
  if ((mode === 'plain') !== (content.t === 'plain')) throw rowError('project_account_mode_mismatch');
  const cipher = input.authorization?.requesterAccountProjection?.projectAccountRowCipher
    ?? createProjectAccountRowCipherV1({ mode, material: mode === 'plain' ? null : cryptoMaterial(input.credentials!), randomBytes: n => new Uint8Array(randomBytes(n)) });
  try { return cipher.open(key, content); }
  catch { throw rowError('project_account_row_invalid'); }
}
function sealRow(payload: ProjectAccountRowPayloadV1, mode: 'plain' | 'e2ee', input: ReadInput): ProjectAccountRowContentV1 {
  return (input.authorization?.requesterAccountProjection?.projectAccountRowCipher
    ?? createProjectAccountRowCipherV1({ mode, material: mode === 'plain' ? null : cryptoMaterial(input.credentials!), randomBytes: n => new Uint8Array(randomBytes(n)) })).seal(payload);
}
export type OpenedProjectAccountRowMutationRequest = Readonly<{
  mutations: readonly Readonly<{
    key: ProjectAccountRowKeyV1;
    expectedRevision: number | 'absent';
    payload: ProjectAccountRowPayloadV1 | null;
  }>[];
  expectedRefs: ProjectAccountRowMutationRequestV1['expectedRefs'];
  topologyChange: boolean;
}>;
export type OpenedProjectAccountRowMutationResponse = Exclude<ProjectAccountRowMutationResponseV1, { status: 'updated' }>
  | (Extract<ProjectAccountRowMutationResponseV1, { status: 'updated' }> & Readonly<{ openedRows: readonly OpenedProjectAccountRow[] }>);
async function submitOpenedRows(input: ReadInput & Readonly<{ request: OpenedProjectAccountRowMutationRequest }>, mode: 'plain' | 'e2ee'): Promise<OpenedProjectAccountRowMutationResponse> {
  const request = ProjectAccountRowMutationRequestV1Schema.parse({
    ...input.request,
    mutations: input.request.mutations.map(mutation => ({
      key: mutation.key, expectedRevision: mutation.expectedRevision,
      content: mutation.payload === null ? null : sealRow(assertProjectAccountRowPayloadBindingV1(mutation.key, mutation.payload), mode, input),
    })),
  });
  input.signal?.throwIfAborted();
  const path = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`;
  const admittedHeaders = await requestHeaders(input, path, request);
  try {
    const response = await axios.post(`${baseUrl(input)}${path}`, request, {
      headers: admittedHeaders, validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}),
    });
    const result = ProjectAccountRowMutationResponseV1Schema.parse(response.data);
    if (result.status !== 'updated') return result;
    const pending = new Map(input.request.mutations.map(mutation => [buildProjectAccountRowPhysicalKeyV1(mutation.key), mutation]));
    const openedRows = result.rows.map(row => {
      const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
      const mutation = pending.get(identity);
      if (!mutation || row.revision !== (mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1)) {
        throw rowError('project_account_row_acknowledgement_invalid');
      }
      pending.delete(identity);
      const payload = row.content === null ? null : openRow(row.key, row.content, mode, input);
      if (!isDeepStrictEqual(payload, mutation.payload === null ? null : assertProjectAccountRowPayloadBindingV1(mutation.key, mutation.payload))) {
        throw rowError('project_account_row_acknowledgement_invalid');
      }
      return { key: row.key, revision: row.revision, payload };
    });
    if (pending.size !== 0) throw rowError('project_account_row_acknowledgement_invalid');
    // This validated receipt belongs to the captured admitted write, even if
    // observation retires while it returns. New reads/effects still re-admit.
    return { ...result, openedRows };
  } catch { throw rowError('project_account_row_outcome_unknown'); }
}
/** Physical batch port shared by semantic owners and the bounded retained-data cutover. */
export async function mutateProjectAccountRows(input: ReadInput & Readonly<{
  request: OpenedProjectAccountRowMutationRequest;
  /** A semantic owner can publish its acknowledged transition without reopening the network after commit. */
  snapshot?: ActiveProjectAccountRowsSnapshot;
}>): Promise<OpenedProjectAccountRowMutationResponse> {
  if (input.snapshot && input.snapshot.scopeKey !== scopeKey(input)) throw rowError('project_requester_authority_unavailable');
  return await runWithServerHttpBaseUrl(resolveServerHttpBaseUrl(), async () => {
    const result = await submitOpenedRows(input, await readMode(input));
    if (result.status === 'updated' && input.snapshot) await acceptMutationSnapshot(input, applyAcknowledgedRows(input.snapshot, result.openedRows));
    return result;
  });
}
async function fetchRows(input: ReadInput, mode: 'plain' | 'e2ee', selection: ProjectAccountRowListRequestV1 | Readonly<{ key: ProjectAccountRowKeyV1 }>): Promise<readonly OpenedProjectAccountRow[]> {
  const path = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/${'key' in selection ? 'read' : 'list'}`;
  const admittedHeaders = await timeWebLatencyPhase('projectRows.requestAdmission', () => requestHeaders(input, path, selection));
  const response = await timeWebLatencyPhase('projectRows.http', () => axios.post(`${baseUrl(input)}${path}`, selection, {
    headers: admittedHeaders, validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}),
  }));
  // The predecessor Home has no Project-row route. Keep unsupported distinct
  // from an empty census; explicit accepted Project addresses must still refuse.
  if (response.status === 404) throw rowError('project_account_rows_unsupported');
  if (response.status !== 200) throw createHttpStatusError(response.status, 'Project rows are unavailable', 'project_account_rows_unavailable');
  let selectedRows: readonly ProjectAccountRowV1[];
  if ('key' in selection) {
    const result = ProjectAccountRowReadResponseV1Schema.parse(response.data);
    if (result.status === 'present') {
      if (buildProjectAccountRowPhysicalKeyV1(result.row.key) !== buildProjectAccountRowPhysicalKeyV1(selection.key)) {
        throw rowError('project_account_row_invalid');
      }
      selectedRows = [result.row];
    } else if (result.status === 'deleted') selectedRows = [{ key: selection.key, revision: result.revision, content: null }];
    else if (result.status === 'absent') selectedRows = [];
    else throw rowError(`project_account_rows_${result.status}`);
  } else {
    const result = ProjectAccountRowListResponseV1Schema.parse(response.data);
    if (result.status !== 'listed') throw rowError(`project_account_rows_${result.status}`);
    selectedRows = result.rows;
  }
  await timeWebLatencyPhase('projectRows.responseAdmission', () => assertRequesterCurrent(input));
  return selectedRows.map(row => ({ key: row.key, revision: row.revision, payload: row.content === null ? null : openRow(row.key, row.content, mode, input) }));
}
async function fetchSnapshot(input: ReadInput, mode: 'plain' | 'e2ee', selection: ProjectAccountRowListRequestV1 | Readonly<{ key: ProjectAccountRowKeyV1 }>): Promise<ActiveProjectAccountRowsSnapshot> {
  return projectSnapshotFromRows(await fetchRows(input, mode, selection), scopeKey(input));
}
async function fetchChangedSnapshot(input: ProjectAccountRowsReadInput, mode: 'plain' | 'e2ee', keys: readonly ProjectAccountRowKeyV1[]): Promise<ActiveProjectAccountRowsSnapshot> {
  if (input.publication !== 'installed' || !canPublish(input) || input.selection) throw rowError('project_requester_authority_unavailable');
  // Pinned services are not part of the daemon's Project projection; their hints change nothing it holds.
  const uniqueKeys = [...new Map(keys.filter(key => key.kind !== 'services-organization')
    .map(key => [buildProjectAccountRowPhysicalKeyV1(key), key])).values()];
  // Graph endpoints and their hints may straddle feed pages. Read their complete
  // domain together, never an isolated graph against potentially missing refs.
  const topologyRequired = uniqueKeys.some(key => key.kind !== 'project-organization');
  const selections: NonNullable<ProjectAccountRowsReadInput['selection']>[] = uniqueKeys
    .filter(key => key.kind === 'project-organization').map(key => ({ key }));
  if (topologyRequired) selections.unshift({ kinds: ['workspace-ref', 'relationship-graph'] });
  const batches = await Promise.all(selections.map(selection => fetchRows(input, mode, selection)));
  await assertRequesterCurrent(input);
  // Keep the fetched delta separate until publication merges it into the
  // then-current admitted projection, preserving concurrent winning revisions.
  if (active?.scopeKey !== scopeKey(input)) throw rowError('project_requester_authority_unavailable');
  return projectSnapshotFromRows(batches.flat(), scopeKey(input));
}
function projectSnapshotFromRows(rows: readonly OpenedProjectAccountRow[], scopeKey: string, previous?: ActiveProjectAccountRowsSnapshot): ActiveProjectAccountRowsSnapshot {
  const workspaceRefs: ProjectAccountSnapshotV1['workspaceRefs'][number][] = [];
  const relationships: ProjectAccountSnapshotV1['relationships'][number][] = [];
  const organizations: ActiveProjectAccountRowsSnapshot['organizations'][number][] = [];
  const keys = new Set<string>();
  let graphRevision: number | 'absent' = 'absent';
  for (const row of rows) {
    const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
    if (keys.has(identity)) throw rowError('project_account_row_duplicate');
    keys.add(identity);
    const payload = row.payload;
    if (!payload) {
      if (row.key.kind === 'relationship-graph') throw rowError('project_account_graph_deleted');
      continue;
    }
    if (row.key.kind === 'workspace-ref') {
      const bound = assertProjectAccountRowPayloadBindingV1(row.key, payload);
      if ('id' in bound.value) workspaceRefs.push(bound.value);
    } else if (row.key.kind === 'relationship-graph') {
      graphRevision = row.revision;
      if ('relationships' in payload.value) relationships.push(...payload.value.relationships);
    } else if (row.key.kind === 'project-organization') {
      const value = payload.value;
      if (!('id' in value) && !('relationships' in value) && !('pinnedEnvironmentIds' in value)) organizations.push({ key: row.key, revision: row.revision, value });
    }
  }
  const snapshot: ActiveProjectAccountRowsSnapshot = { workspaceRefs, relationships, source: 'network', organizations, rows, graphRevision,
    loadedAtMs: Date.now(), scopeKey };
  return previous ? mergeProjectSnapshots(previous, snapshot)
    : { ...snapshot, ...parseProjectAccountSnapshotV1({ workspaceRefs, relationships }) };
}
function applyAcknowledgedRows(snapshot: ActiveProjectAccountRowsSnapshot, rows: readonly OpenedProjectAccountRow[]): ActiveProjectAccountRowsSnapshot {
  return projectSnapshotFromRows(rows, snapshot.scopeKey, snapshot);
}
/**
 * Private Session reads held per Account and Home while a live Session owner receives the Account
 * wakes that announce project-row changes (`holdSessionProjectAccountRows`). The owner drops them
 * on a wake naming a project row (or a coarse wake) and on disconnect; with no owner every read goes
 * to the Home as before. Held reads never publish into the daemon's Active Account projection.
 */
type HeldSessionProjectRows = { owners: number; generation: number; reads: Map<string, ActiveProjectAccountRowsSnapshot> };
const heldSessionProjectRows = new Map<string, HeldSessionProjectRows>();
const heldSessionScopeKey = (custody: Readonly<{ serverHttpBaseUrl: string; accountId: string }>) =>
  JSON.stringify([normalizeServerHttpBaseUrl(custody.serverHttpBaseUrl), custody.accountId]);
const heldSelectionKey = (serverId: string, selection: unknown) => JSON.stringify([serverId, selection]);

export type SessionProjectAccountRowsHold = Readonly<{ invalidate(): void; release(): void }>;
export function holdSessionProjectAccountRows(custody: Readonly<{ serverHttpBaseUrl: string; accountId: string }>): SessionProjectAccountRowsHold {
  const key = heldSessionScopeKey(custody);
  const held = heldSessionProjectRows.get(key) ?? { owners: 0, generation: 0, reads: new Map() };
  heldSessionProjectRows.set(key, held);
  held.owners++;
  let released = false;
  const invalidate = () => { held.generation++; held.reads.clear(); };
  return {
    invalidate,
    release() {
      if (released) return;
      released = true;
      invalidate();
      if (--held.owners === 0 && heldSessionProjectRows.get(key) === held) heldSessionProjectRows.delete(key);
    },
  };
}

/** An Account wake that may change project rows: it names a project row, or it names nothing. */
export function isProjectAccountRowsAccountWake(body: unknown): boolean {
  if (!body || typeof body !== 'object' || (body as { t?: unknown }).t !== 'account-change') return false;
  const entityIds = (body as { entityIds?: unknown }).entityIds;
  return !Array.isArray(entityIds)
    || entityIds.some(entityId => typeof entityId === 'string' && entityId.startsWith(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1));
}

function heldSessionReadSlot(input: ReadInput, serverId: string, selection: unknown) {
  const held = input.sessionCustody ? heldSessionProjectRows.get(heldSessionScopeKey(input.sessionCustody)) : undefined;
  if (!held) return null;
  const key = heldSelectionKey(serverId, selection);
  const generation = held.generation;
  return {
    read: () => held.reads.get(key) ?? null,
    store(snapshot: ActiveProjectAccountRowsSnapshot) { if (held.generation === generation) held.reads.set(key, snapshot); },
    invalidate() { held.generation++; held.reads.clear(); },
    current: (snapshot: ActiveProjectAccountRowsSnapshot) => held.reads.get(key) === snapshot,
  };
}

export type ProjectAccountRowsObservation = Readonly<{
  snapshot: ActiveProjectAccountRowsSnapshot;
  isCurrent(): Promise<boolean>;
}>;

export async function readProjectAccountRowsObservation(input: ProjectAccountRowsReadInput): Promise<ProjectAccountRowsObservation> {
  const bound = { ...input, serverId: input.serverId ?? input.authorization?.requesterAccountProjection?.serverId ?? configuration.activeServerId };
  if (bound.selection ? !('key' in bound.selection) && !bound.selection.kinds
    : bound.publication !== 'installed' || !canPublish(bound)) throw rowError('project_account_rows_selection_required');
  const trace = <T>(stage: string, operation: () => T | Promise<T>) => runTracedExternalActionStage(
    bound.authorization?.binding.actionId ?? '', bound.authorization?.binding.requestId, stage, operation);
  const installedBeforeRead = bound.selection && canPublish(bound) && active?.scopeKey === scopeKey(bound)
    ? { value: selectedProjection(active, bound.selection) } : null;
  const heldSlot = bound.selection ? heldSessionReadSlot(bound, bound.serverId, bound.selection) : null;
  const heldSnapshot = heldSlot?.read();
  if (heldSlot && heldSnapshot) {
    await assertRequesterCurrent(bound);
    return { snapshot: heldSnapshot, isCurrent: async () => {
      try { await assertRequesterCurrent(bound); }
      catch { return false; }
      return heldSlot.current(heldSnapshot);
    } };
  }
  const observation = await runWithServerHttpBaseUrl(baseUrl(bound), () => withSnapshotReadFailurePolicy(bound, async () => {
      input.signal?.throwIfAborted();
      const mode = await timeWebLatencyPhase('projectRows.mode', () => trace('project_rows.mode', () => readMode(bound, 'identity')));
      // Only a complete installed baseline can consume incremental hints.
      // Connect/reconnect, withdrawn state and a changed Account still recover.
      if (bound.changedKeys && (bound.publication !== 'installed' || !canPublish(bound) || bound.selection)) {
        throw rowError('project_requester_authority_unavailable');
      }
      const changedKeys = active?.scopeKey === scopeKey(bound) ? bound.changedKeys : undefined;
      const snapshot = await trace('project_rows.fetch', () => changedKeys === undefined
        ? fetchSnapshot(bound, mode, bound.selection ?? {}) : fetchChangedSnapshot(bound, mode, changedKeys));
      // Source-backed Projects take their current context from shared attachments;
      // the personal organization remains stored but is not their context layer.
      if (bound.credentials && !bound.selection && canPublish(bound)) {
        const workspaceRefs = changedKeys?.every(key => key.kind === 'project-organization')
          ? active?.workspaceRefs ?? snapshot.workspaceRefs : snapshot.workspaceRefs;
        // Incremental snapshots contain only fetched organizations; recovery
        // snapshots contain the complete organization domain.
        for (const organization of snapshot.organizations) {
          if (workspaceRefs.some(ref => ref.serverId === organization.key.serverId
            && ref.projectKey === organization.key.projectKey && ref.source)) continue;
          await migrateProjectPromptStackSkillRules({ credentials: bound.credentials, serverId: organization.key.serverId,
            projectKey: organization.key.projectKey, entries: organization.value.promptStack ?? [],
            serverHttpBaseUrl: baseUrl(bound), signal: bound.signal });
        }
      }
      input.signal?.throwIfAborted();
      if (changedKeys !== undefined) {
        await assertRequesterCurrent(bound);
        if (active?.scopeKey !== scopeKey(bound)) throw rowError('project_requester_authority_unavailable');
      }
      // Never hand a raw consumer an older response after its admitted facts
      // changed in flight. Check before our own complete-topology publication;
      // an unrelated organization update does not retire a refs observation.
      if (installedBeforeRead && bound.selection && (!active || active.scopeKey !== snapshot.scopeKey
        || !isDeepStrictEqual(selectedProjection(active, bound.selection), installedBeforeRead.value))) return null;
      const published = !bound.selection && canPublish(bound);
      const accepted = acceptSnapshot(bound, snapshot);
      // Follow the consumed rows, not unrelated organization changes. A finite
      // read never establishes a scope, but keeps its installed-currentness
      // fence when the same Account already has an admitted projection.
      const installedSelection = bound.selection && canPublish(bound) && active?.scopeKey === accepted.scopeKey
        ? { value: selectedProjection(active, bound.selection) } : null;
      return { snapshot: accepted, isCurrent: async () => {
        try { await assertRequesterCurrent(bound); }
        catch { return false; }
        if (installedSelection && bound.selection) return active !== null && active.scopeKey === accepted.scopeKey
          && isDeepStrictEqual(selectedProjection(active, bound.selection), installedSelection.value);
        // A private read without an installed baseline belongs only to its
        // captured invocation. Complete published reads follow topology changes.
        return !published || active !== null && active.scopeKey === accepted.scopeKey
          && isDeepStrictEqual(active.workspaceRefs, accepted.workspaceRefs)
          && isDeepStrictEqual(active.relationships, accepted.relationships);
      } };
  }));
  // Retirement is not an authentication/content failure: preserve any newer
  // admitted projection instead of withdrawing it through the failure policy.
  if (!observation) throw rowError('project_account_rows_changed');
  heldSlot?.store(observation.snapshot);
  return observation;
}

export async function readProjectAccountRows(input: ProjectAccountRowsReadInput): Promise<ActiveProjectAccountRowsSnapshot> {
  return (await readProjectAccountRowsObservation(input)).snapshot;
}

export type ProjectStackSkillMigrationResult = Readonly<{ status: 'ready' | 'unavailable' }>;

/** Add a viewer's rules through the existing Account CAS; retained entries keep Session exclusion custody. */
export async function migrateProjectPromptStackSkillRules(input: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string; projectKey: string;
  entries: readonly PromptStackEntryV1[]; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
}>): Promise<ProjectStackSkillMigrationResult> {
  input.signal?.throwIfAborted();
  if (!input.entries.some(entry => entry.ref.kind === 'bundle' && isPromptStackSystemAppendPlacementV1(entry.placement))) return { status: 'ready' };
  return await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async (): Promise<ProjectStackSkillMigrationResult> => {
    try {
      const store = createCliPromptLibraryStore(input);
      const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
      const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      const catalog = await store.readPromptLibraryCatalog();
      const rules = readPromptLibraryCatalogRecordV1({ catalog, key: 'skill-rules' });
      if (rules.status !== 'ready' || rules.record.key !== 'skill-rules') return { status: 'unavailable' };
      const layer = { kind: 'project' as const, projectKey: input.projectKey };
      const entries = unconsumedStackSkillEntriesV1(input.entries, layer, rules.record.value.consumedLegacyEntryIds);
      if (entries.length === 0) return { status: 'ready' };
      const resolved = await withCliPromptLibraryArtifactReader(reader => readStackSkillIdsV1(entries,
        { readArtifact: reader.readArtifact }), input);
      if (resolved.status !== 'ready') return { status: 'unavailable' };
      const next = migrateStackSkillRulesV1(rules.record.value, entries, layer, { skillIds: resolved.skillIds, nowMs: Date.now() });
      if (next === rules.record.value) return { status: 'ready' };
      const result = await store.writeRecord({ record: { key: 'skill-rules', value: next },
        expectedRevision: rules.revision });
      if (result.status !== 'updated') return { status: 'unavailable' };
      if (input.operationContext) {
        const catalog = await store.readPromptLibraryCatalog();
        const snapshot = input.operationContext.readSnapshot();
        if (!snapshot || !await input.operationContext.commitPromptLibraryCatalog({ expectedSettingsVersion: snapshot.settingsVersion, catalog })) {
          return { status: 'unavailable' };
        }
      } else {
        const catalog = await refreshActivePromptLibraryCatalogAfterChange({ credentials: input.credentials, scopeKey, lifetimeToken });
        if (readPromptLibraryCatalogRecordV1({ catalog, key: 'skill-rules' }).status !== 'ready') return { status: 'unavailable' };
      }
      return { status: 'ready' };
    } catch { input.signal?.throwIfAborted(); return { status: 'unavailable' }; }
  });
}

export async function mutateProjectAccountOrganization(input: ReadInput & Readonly<{
  serverId: string;
  projectKey: string;
  expectedRevision?: number | 'absent';
  mutate(value: ProjectAccountOrganizationV1): ProjectAccountOrganizationV1;
}>): Promise<Readonly<{ status: 'updated'; key: Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>; revision: number; value: ProjectAccountOrganizationV1 }> | Readonly<{ status: 'conflict'; revision: number }>> {
  return await runWithServerHttpBaseUrl(resolveServerHttpBaseUrl(), async () => {
    const key = { kind: 'project-organization' as const, serverId: input.serverId, projectKey: input.projectKey };
    const heldSlot = input.expectedRevision === undefined ? heldSessionReadSlot(input, input.serverId, { key }) : null;
    const heldSnapshot = heldSlot?.read();
    if (heldSnapshot) {
      // A held organization row this mutation would not change publishes nothing.
      const heldIdentity = buildProjectAccountRowPhysicalKeyV1(key);
      const heldRow = heldSnapshot.organizations.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === heldIdentity);
      if (heldRow && isDeepStrictEqual(input.mutate(heldRow.value), heldRow.value)) {
        await assertRequesterCurrent(input);
        return { status: 'updated', key, revision: heldRow.revision, value: heldRow.value };
      }
    }
    const { mode, snapshot } = await withSnapshotReadFailurePolicy(input, async () => {
      const mode = await readMode(input);
      return { mode, snapshot: await fetchSnapshot(input, mode, { key }) };
    });
    const identity = buildProjectAccountRowPhysicalKeyV1(key);
    const row = snapshot.organizations.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === identity);
    const observedRevision = snapshot.rows.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === identity)?.revision ?? 'absent';
    if (input.expectedRevision !== undefined && input.expectedRevision !== observedRevision) return { status: 'conflict', revision: observedRevision === 'absent' ? -1 : observedRevision };
    const value = input.mutate(row?.value ?? {});
    if (row && isDeepStrictEqual(value, row.value)) {
      if (active?.scopeKey === snapshot.scopeKey) acceptSnapshot(input, snapshot);
      heldSlot?.store(snapshot);
      return { status: 'updated', key, revision: row.revision, value: row.value };
    }
    // This write changes project rows; held reads of this Account are retired before it lands.
    heldSlot?.invalidate();
    const result = await submitOpenedRows({ ...input, request: {
      mutations: [{ key, expectedRevision: observedRevision, payload: { key, value } }],
      expectedRefs: [], topologyChange: false,
    } }, mode);
    if (result.status === 'conflict') return { status: 'conflict', revision: result.revision };
    if (result.status !== 'updated') throw rowError(`project_account_rows_${result.status}`);
    const acknowledged = result.openedRows.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === identity);
    if (!acknowledged?.payload) throw rowError('project_account_row_acknowledgement_invalid');
    const payload = acknowledged.payload;
    if ('id' in payload.value || 'relationships' in payload.value) throw rowError('project_account_row_invalid');
    await acceptMutationSnapshot(input, applyAcknowledgedRows(snapshot, result.openedRows));
    return { status: 'updated', key, revision: acknowledged.revision, value: payload.value };
  });
}

export type ProjectAccountSnapshotMutationResult =
  | Readonly<{ status: 'applied' | 'unchanged'; version: number; snapshot: ProjectAccountSnapshotV1 }>
  | Readonly<{ status: 'conflict' | 'cancelled' | 'unavailable' }>
  | Readonly<{ status: 'outcomeUnknown'; lastKnownVersion: number }>;
export type ProjectAccountSnapshotMutation = (mutate: (snapshot: ProjectAccountSnapshotV1) => ProjectAccountSnapshotV1 | Promise<ProjectAccountSnapshotV1>, signal?: AbortSignal) => Promise<ProjectAccountSnapshotMutationResult>;

/** The existing semantic owner re-admits on each fresh graph/ref census; the server commits its complete CAS atomically. */
export function createProjectAccountSnapshotMutation(authority: StoredCredentials | ReadInput): ProjectAccountSnapshotMutation {
  return async (mutate, signal) => runWithServerHttpBaseUrl(resolveServerHttpBaseUrl(), async () => {
    const input: ReadInput = { ...('token' in authority ? { credentials: authority } : authority),
      serverId: 'token' in authority ? configuration.activeServerId : authority.serverId
        ?? authority.authorization?.requesterAccountProjection?.serverId ?? configuration.activeServerId,
      ...(signal ? { signal } : {}) };
    signal?.throwIfAborted();
    const mode = await readMode(input);
    const before = await fetchSnapshot(input, mode, { kinds: ['workspace-ref', 'relationship-graph'] });
    const base = parseProjectAccountSnapshotV1(before);
    const next = parseProjectAccountSnapshotV1(await mutate(base));
    assertProjectAccountSnapshotTransition(base, next);
    const byKey = new Map(before.rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row]));
    const mutations: OpenedProjectAccountRowMutationRequest['mutations'][number][] = [];
    const visited = new Set<string>();
    let topologyChange = !isDeepStrictEqual(before.relationships, next.relationships);
    for (const ref of [...before.workspaceRefs, ...next.workspaceRefs]) {
      const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
      const identity = buildProjectAccountRowPhysicalKeyV1(key);
      if (visited.has(identity)) continue;
      visited.add(identity);
      const prior = resolveWorkspaceRefById(before.workspaceRefs, ref.id, ref.serverId) ?? undefined;
      const value = resolveWorkspaceRefById(next.workspaceRefs, ref.id, ref.serverId) ?? undefined;
      if (isDeepStrictEqual(prior, value)) continue;
      if (!prior || !value || prior.machineId !== value.machineId || prior.rootPath !== value.rootPath) topologyChange = true;
      mutations.push({ key, expectedRevision: byKey.get(identity)?.revision ?? 'absent', payload: value ? { key, value } : null });
    }
    // Narrow mitigation while retained Home/Artifact repair is owed: a known
    // local-profile checkout must not receive another portable ref/anchor.
    // Unrelated insertions, existing-ref edits and graph retirement stay usable.
    const homeId = input.serverId ? await resolveServerProfileHomeIdentityId(input.serverId) : null;
    if (homeId && homeId !== input.serverId) {
      const retained = before.workspaceRefs.filter(ref => ref.serverId === input.serverId).map(ref => ({ ...ref, serverId: homeId }));
      for (const ref of next.workspaceRefs) {
        if (ref.serverId !== homeId || resolveWorkspaceRefById(before.workspaceRefs, ref.id, homeId)) continue;
        const resolution = resolveWorkspaceRefV1(retained, { serverId: homeId, machineId: ref.machineId, rootPath: ref.rootPath });
        if (resolution.kind !== 'missing') throw rowError('project_home_reconciliation_required');
      }
    }
    if (topologyChange) {
      const key = { kind: 'relationship-graph' as const };
      mutations.push({ key, expectedRevision: before.graphRevision, payload: { key, value: { relationships: [...next.relationships] } } });
    }
    const version = before.graphRevision === 'absent' ? -1 : before.graphRevision;
    if (mutations.length === 0) {
      await assertRequesterCurrent(input);
      const accepted = acceptSnapshot(input, before);
      return { status: 'unchanged', version: accepted.graphRevision === 'absent' ? -1 : accepted.graphRevision, snapshot: accepted };
    }
    const reached = new Map<string, Extract<ProjectAccountRowKeyV1, { kind: 'workspace-ref' }>>();
    const previousRelationships = new Map(base.relationships.map(relationship => [relationship.relationshipId, relationship]));
    const nextRelationships = new Map(next.relationships.map(relationship => [relationship.relationshipId, relationship]));
    const mutatedKeys = new Set(mutations.map(mutation => buildProjectAccountRowPhysicalKeyV1(mutation.key)));
    for (const relationship of [...base.relationships, ...next.relationships]) {
      if (isDeepStrictEqual(previousRelationships.get(relationship.relationshipId), nextRelationships.get(relationship.relationshipId))) continue;
      for (const id of [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]) {
        const ref = resolveWorkspaceRefById(base.workspaceRefs, id) ?? resolveWorkspaceRefById(next.workspaceRefs, id);
        if (!ref) throw rowError('project_account_relationship_ref_invalid');
        const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
        const identity = buildProjectAccountRowPhysicalKeyV1(key);
        // Touched ref mutations carry their own CAS; only separately reached endpoints need an assertion.
        if (!mutatedKeys.has(identity)) reached.set(identity, key);
      }
    }
    const request: OpenedProjectAccountRowMutationRequest = { mutations, topologyChange,
      expectedRefs: [...reached.entries()].map(([identity, key]) => ({ key, expectedRevision: byKey.get(identity)?.revision ?? 'absent' })),
    };
    let result: OpenedProjectAccountRowMutationResponse;
    try {
      result = await submitOpenedRows({ ...input, request }, mode);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'project_account_row_outcome_unknown') return { status: 'outcomeUnknown', lastKnownVersion: version };
      throw error;
    }
    if (result.status === 'conflict') return { status: 'conflict' };
    if (result.status !== 'updated') throw rowError(`project_account_rows_${result.status}`);
    const accepted = await acceptMutationSnapshot(input, applyAcknowledgedRows(before, result.openedRows));
    return { status: 'applied', version: accepted.graphRevision === 'absent' ? -1 : accepted.graphRevision, snapshot: accepted };
  });
}
