import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import axios from 'axios';

import {
  PROJECT_ACCOUNT_ROWS_ROUTE_V1,
  ProjectAccountRowListResponseV1Schema, ProjectAccountRowMutationRequestV1Schema,
  ProjectAccountRowMutationResponseV1Schema,
  assertProjectAccountRowPayloadBindingV1,
  buildProjectAccountRowPhysicalKeyV1,
  type ProjectAccountRowKeyV1, type ProjectAccountRowPayloadV1,
  type ProjectAccountRowContentV1, type ProjectAccountOrganizationV1,
  type ProjectAccountRowMutationRequestV1, type ProjectAccountRowMutationResponseV1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import {
  assertProjectAccountSnapshotTransition, parseProjectAccountSnapshotV1,
  type ProjectAccountSnapshotV1,
} from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { AccountSettingsEncryptionMaterialUnavailableError, hasUsableAccountSettingsEncryptionMaterial, requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

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
function publish(snapshot: ActiveProjectAccountRowsSnapshot): ActiveProjectAccountRowsSnapshot;
function publish(snapshot: null): null;
function publish(snapshot: ActiveProjectAccountRowsSnapshot | null): ActiveProjectAccountRowsSnapshot | null {
  const previous = active;
  if (snapshot && previous?.scopeKey === snapshot.scopeKey) {
    const rows = new Map(previous.rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row]));
    for (const row of snapshot.rows) {
      const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
      const known = rows.get(identity);
      if (!known || row.revision >= known.revision) rows.set(identity, row);
    }
    // Rows, including reserved tombstones, are immutable within a revision.
    // Reproject the winning graph and refs together before notifying consumers.
    snapshot = projectSnapshotFromRows([...rows.values()], snapshot.scopeKey);
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
export type ProjectAccountRowsInput = Readonly<({ credentials: StoredCredentials; authorization?: never; effectActionId?: never }
  | { credentials?: never; authorization: ExternalActionExecutionAuthorizationV1; effectActionId: string })
  & { serverId?: string; signal?: AbortSignal }>;
type ReadInput = ProjectAccountRowsInput;
async function assertRequesterCurrent(input: ReadInput): Promise<void> {
  if (!input.authorization) return;
  const account = input.authorization.requesterAccountProjection;
  const http = input.authorization.requesterHttpProjection;
  if (!account || !http || account.accountId !== input.authorization.binding.accountId || http.accountId !== account.accountId
    || account.serverId !== http.serverId || input.serverId && input.serverId !== account.serverId
    || http.accountEncryptionMode !== undefined && account.accountEncryptionMode !== http.accountEncryptionMode
    || input.authorization.binding.accountEncryptionMode !== undefined && account.accountEncryptionMode !== input.authorization.binding.accountEncryptionMode
    || !await account.isCurrent() || !await http.isCurrent()) throw rowError('project_requester_authority_unavailable');
  input.signal?.throwIfAborted();
}
async function requestHeaders(input: ReadInput, path: string, body: unknown) {
  if (!input.authorization) return headers(input.credentials);
  await assertRequesterCurrent(input);
  const result = await input.authorization.requesterHttpProjection!.createRequestHeaders({
    effectActionId: input.effectActionId, method: 'POST', path, body, ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!result) throw rowError('project_requester_authority_unavailable');
  return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...result, 'Content-Type': 'application/json' };
}
function baseUrl(input: ReadInput) { return input.authorization?.requesterHttpProjection?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(); }
function scopeKey(input: ReadInput) {
  return `${input.serverId ?? configuration.activeServerId}:${input.authorization?.requesterAccountProjection?.accountId
    ?? resolveAccountSettingsScopeKey(input.credentials!)}`;
}
function acceptSnapshot(input: ReadInput, snapshot: ActiveProjectAccountRowsSnapshot) {
  // A private invocation must not replace the daemon Account's live Sync projection.
  return input.authorization ? snapshot : publish(snapshot);
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
async function readMode(input: ReadInput): Promise<'plain' | 'e2ee'> {
  if (input.authorization) {
    await assertRequesterCurrent(input);
    return input.authorization.requesterAccountProjection!.accountEncryptionMode;
  }
  const result = await readAccountEncryptionModeOnce({ request: () => axios.get(`${resolveServerHttpBaseUrl()}/v1/account/encryption`, {
    headers: headers(input.credentials), validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}),
  }) });
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
export async function mutateProjectAccountRows(input: ReadInput & Readonly<{ request: OpenedProjectAccountRowMutationRequest }>): Promise<OpenedProjectAccountRowMutationResponse> {
  return await runWithServerHttpBaseUrl(resolveServerHttpBaseUrl(), async () => submitOpenedRows(input, await readMode(input)));
}
async function fetchSnapshot(input: ReadInput, mode: 'plain' | 'e2ee'): Promise<ActiveProjectAccountRowsSnapshot> {
  const path = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`;
  const response = await axios.post(`${baseUrl(input)}${path}`, {}, {
    headers: await requestHeaders(input, path, {}), validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}),
  });
  const result = ProjectAccountRowListResponseV1Schema.parse(response.data);
  if (result.status !== 'listed') throw rowError(`project_account_rows_${result.status}`);
  await assertRequesterCurrent(input);
  const rows = result.rows.map(row => ({ key: row.key, revision: row.revision, payload: row.content === null ? null : openRow(row.key, row.content, mode, input) }));
  return projectSnapshotFromRows(rows, scopeKey(input));
}
function projectSnapshotFromRows(rows: readonly OpenedProjectAccountRow[], scopeKey: string): ActiveProjectAccountRowsSnapshot {
  const workspaceRefs: ProjectAccountSnapshotV1['workspaceRefs'][number][] = [];
  const relationships: ProjectAccountSnapshotV1['relationships'][number][] = [];
  const organizations: ActiveProjectAccountRowsSnapshot['organizations'][number][] = [];
  const keys = new Set<string>();
  let graphRevision: number | 'absent' = 'absent';
  for (const row of rows) {
    const identity = buildProjectAccountRowPhysicalKeyV1(row.key);
    if (keys.has(identity)) throw rowError('project_account_row_duplicate');
    keys.add(identity);
    if (!row.payload) {
      if (row.key.kind === 'relationship-graph') throw rowError('project_account_graph_deleted');
      continue;
    }
    if (row.key.kind === 'workspace-ref') {
      const payload = assertProjectAccountRowPayloadBindingV1(row.key, row.payload);
      if ('id' in payload.value) workspaceRefs.push(payload.value);
    } else if (row.key.kind === 'relationship-graph') {
      graphRevision = row.revision;
      if ('relationships' in row.payload.value) relationships.push(...row.payload.value.relationships);
    } else {
      const value = row.payload.value;
      if (!('id' in value) && !('relationships' in value)) organizations.push({ key: row.key, revision: row.revision, value });
    }
  }
  return { ...parseProjectAccountSnapshotV1({ workspaceRefs, relationships }), source: 'network', organizations, rows, graphRevision,
    loadedAtMs: Date.now(), scopeKey };
}
function applyAcknowledgedRows(snapshot: ActiveProjectAccountRowsSnapshot, rows: readonly OpenedProjectAccountRow[]): ActiveProjectAccountRowsSnapshot {
  const accepted = new Map(snapshot.rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row]));
  for (const row of rows) accepted.set(buildProjectAccountRowPhysicalKeyV1(row.key), row);
  return projectSnapshotFromRows([...accepted.values()], snapshot.scopeKey);
}
export async function readProjectAccountRows(input: ReadInput): Promise<ActiveProjectAccountRowsSnapshot> {
  const bound = { ...input, serverId: input.serverId ?? input.authorization?.requesterAccountProjection?.serverId ?? configuration.activeServerId };
  return await runWithServerHttpBaseUrl(resolveServerHttpBaseUrl(), async () => {
    try {
      input.signal?.throwIfAborted();
      const snapshot = await fetchSnapshot(bound, await readMode(bound));
      input.signal?.throwIfAborted();
      return acceptSnapshot(input, snapshot);
    } catch (error) {
      if (!input.authorization && (!active || active.scopeKey === scopeKey(bound))) withdrawActiveProjectAccountRowsSnapshot();
      throw error;
    }
  });
}

export async function mutateProjectAccountOrganization(input: ReadInput & Readonly<{
  serverId: string;
  projectKey: string;
  expectedRevision?: number | 'absent';
  mutate(value: ProjectAccountOrganizationV1): ProjectAccountOrganizationV1;
}>): Promise<Readonly<{ status: 'updated'; key: Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>; revision: number; value: ProjectAccountOrganizationV1 }> | Readonly<{ status: 'conflict'; revision: number }>> {
  return await runWithServerHttpBaseUrl(resolveServerHttpBaseUrl(), async () => {
    const mode = await readMode(input);
    const snapshot = await fetchSnapshot(input, mode);
    const key = { kind: 'project-organization' as const, serverId: input.serverId, projectKey: input.projectKey };
    const identity = buildProjectAccountRowPhysicalKeyV1(key);
    const row = snapshot.organizations.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === identity);
    const observedRevision = snapshot.rows.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === identity)?.revision ?? 'absent';
    if (input.expectedRevision !== undefined && input.expectedRevision !== observedRevision) return { status: 'conflict', revision: observedRevision === 'absent' ? -1 : observedRevision };
    const value = input.mutate(row?.value ?? {});
    if (row && isDeepStrictEqual(value, row.value)) {
      acceptSnapshot(input, snapshot);
      return { status: 'updated', key, revision: row.revision, value: row.value };
    }
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
    acceptSnapshot(input, applyAcknowledgedRows(snapshot, result.openedRows));
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
    const before = await fetchSnapshot(input, mode);
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
    const accepted = acceptSnapshot(input, applyAcknowledgedRows(before, result.openedRows));
    return { status: 'applied', version: accepted.graphRevision === 'absent' ? -1 : accepted.graphRevision, snapshot: accepted };
  });
}
