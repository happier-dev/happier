import { fetchJson } from '../http';

const SESSION_ORGANIZATION_ROUTE = '/v2/session-organization';
const PINNED_GROUP_KEY_V1 = 'pinned-v1';

type PlainContentEnvelope = Readonly<{
  t: 'plain';
  v: Record<string, unknown>;
}>;

type SessionOrganizationContentEnvelope = PlainContentEnvelope | Readonly<{
  t: 'encrypted';
  c: string;
}>;

export type SessionFoldersSetting = Readonly<{
  v: 1;
  folders: ReadonlyArray<Readonly<{
    id: string;
    workspace: Readonly<{
      t: 'workspaceScope';
      serverId: string;
      machineId: string;
      rootPath: string;
    }>;
    renderWorkspaceKey?: string;
    parentId: string | null;
    name: string;
    createdAt: number;
    updatedAt: number;
    sortKey?: string;
  }>>;
}>;

export type SessionFolderSettingsSnapshot = Readonly<{
  sessionFoldersV1: SessionFoldersSetting;
  sessionListGroupOrderV1: Record<string, string[]>;
}>;

type SessionOrganizationOrderEntry = Readonly<{
  scopeKind: string;
  scopeKey: string;
  itemKind: string;
  itemKey: string;
  sortKey: string | null;
}>;

type SessionOrganizationFolder = Readonly<{
  folderId: string;
  folderKey: string;
  parentFolderId: string | null;
  parentFolderKey: string | null;
  sortKey: string | null;
  display: SessionOrganizationContentEnvelope | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}>;

type SessionOrganizationPin = Readonly<{
  sessionId: string;
  sortKey: string | null;
  pinnedAt: number;
}>;

type SessionOrganizationTag = Readonly<{
  tagId: string;
  tagKey: string;
  display: SessionOrganizationContentEnvelope | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}>;

type SessionTagAssignment = Readonly<{
  sessionId: string;
  tagIds: readonly string[];
}>;

type SessionOrganizationSnapshot = Readonly<{
  schemaVersion: number;
  version: number;
  pins: readonly SessionOrganizationPin[];
  folders: readonly SessionOrganizationFolder[];
  folderAssignments: readonly unknown[];
  tags: readonly SessionOrganizationTag[];
  tagAssignments: readonly SessionTagAssignment[];
  orderEntries: readonly SessionOrganizationOrderEntry[];
  labels: readonly unknown[];
}>;

type SessionOrganizationSnapshotRequest = Readonly<{
  includeFolders?: boolean;
  includeTags?: boolean;
  includeLabels?: boolean;
  includeAllFolderAssignments?: boolean;
  includeAllTagAssignments?: boolean;
  assignmentSessionIds?: readonly string[];
  folderIds?: readonly string[];
  tagIds?: readonly string[];
  orderScopes?: ReadonlyArray<Readonly<{
    scopeKind: string;
    scopeKey: string;
  }>>;
}>;

type SessionOrganizationSnapshotResponse = Readonly<{
  snapshot: SessionOrganizationSnapshot;
}>;

type ImportLegacySessionOrganizationRequest = Readonly<{
  pins: ReadonlyArray<Readonly<{
    sessionId: string;
    sortKey?: string | null;
  }>>;
  folders: ReadonlyArray<Readonly<{
    folderId: string;
    folderKey: string;
    parentFolderId: string | null;
    parentFolderKey: string | null;
    sortKey: string | null;
    display: PlainContentEnvelope;
  }>>;
  tags: readonly unknown[];
  tagAssignments: readonly unknown[];
  orderEntries: readonly SessionOrganizationOrderEntry[];
  labels: readonly unknown[];
}>;

type ImportLegacySessionOrganizationResponse = Readonly<{
  imported?: Readonly<{
    pins?: number;
    folders?: number;
    tags?: number;
    orderEntries?: number;
    labels?: number;
  }>;
}>;

type SetSessionPinResponse = Readonly<{
  pin: SessionOrganizationPin | null;
}>;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function buildUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function appendBooleanParam(params: URLSearchParams, key: string, value: boolean | undefined): void {
  if (typeof value === 'boolean') params.set(key, String(value));
}

function appendArrayParam(params: URLSearchParams, key: string, values: readonly string[] | undefined): void {
  if (values && values.length > 0) params.set(key, values.join(','));
}

function buildSnapshotQuery(request: SessionOrganizationSnapshotRequest | undefined): string {
  if (!request) return '';
  const params = new URLSearchParams();
  appendBooleanParam(params, 'includeFolders', request.includeFolders);
  appendBooleanParam(params, 'includeTags', request.includeTags);
  appendBooleanParam(params, 'includeLabels', request.includeLabels);
  appendBooleanParam(params, 'includeAllFolderAssignments', request.includeAllFolderAssignments);
  appendBooleanParam(params, 'includeAllTagAssignments', request.includeAllTagAssignments);
  appendArrayParam(params, 'assignmentSessionIds', request.assignmentSessionIds);
  appendArrayParam(params, 'folderIds', request.folderIds);
  appendArrayParam(params, 'tagIds', request.tagIds);
  if (request.orderScopes && request.orderScopes.length > 0) {
    params.set('orderScopes', JSON.stringify(request.orderScopes));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function buildSortKey(index: number): string {
  return String(index + 1).padStart(8, '0');
}

function stripServerSessionKey(serverId: string, itemKeyRaw: string): string | null {
  const itemKey = itemKeyRaw.trim();
  if (!itemKey) return null;
  const prefix = `${serverId}:`;
  if (itemKey.startsWith(prefix)) return itemKey.slice(prefix.length).trim() || null;
  return itemKey.includes(':') ? null : itemKey;
}

function stripFolderItemKey(itemKeyRaw: string): string | null {
  const itemKey = itemKeyRaw.trim();
  if (!itemKey) return null;
  return itemKey.startsWith('folder:') ? itemKey.slice('folder:'.length).trim() || null : itemKey;
}

function readPlainDisplayRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as { t?: unknown; v?: unknown };
  if (envelope.t !== 'plain' || !envelope.v || typeof envelope.v !== 'object' || Array.isArray(envelope.v)) return null;
  return envelope.v as Record<string, unknown>;
}

function readPlainTagLabel(value: unknown): string | null {
  const record = readPlainDisplayRecord(value);
  const label = typeof record?.label === 'string' ? record.label.trim() : '';
  return label || null;
}

function readPlainFolderDisplay(value: unknown): Readonly<{
  name: string;
  workspace: SessionFoldersSetting['folders'][number]['workspace'];
}> | null {
  const record = readPlainDisplayRecord(value);
  const name = typeof record?.name === 'string' ? record.name.trim() : '';
  const workspace = record?.workspace;
  if (!name || !workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return null;
  const workspaceRecord = workspace as Record<string, unknown>;
  if (workspaceRecord.t !== 'workspaceScope') return null;
  const serverId = typeof workspaceRecord.serverId === 'string' ? workspaceRecord.serverId.trim() : '';
  const machineId = typeof workspaceRecord.machineId === 'string' ? workspaceRecord.machineId.trim() : '';
  const rootPath = typeof workspaceRecord.rootPath === 'string' ? workspaceRecord.rootPath.trim() : '';
  if (!serverId || !machineId || !rootPath) return null;
  return {
    name,
    workspace: {
      t: 'workspaceScope',
      serverId,
      machineId,
      rootPath,
    },
  };
}

function compareNullableSortKey(left: string | null | undefined, right: string | null | undefined): number {
  const a = typeof left === 'string' ? left : '';
  const b = typeof right === 'string' ? right : '';
  if (a && b && a !== b) return a.localeCompare(b);
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function folderImportDepth(folder: SessionFoldersSetting['folders'][number], byId: ReadonlyMap<string, SessionFoldersSetting['folders'][number]>): number {
  let depth = 0;
  let parentId = folder.parentId;
  const seen = new Set<string>([folder.id]);
  while (parentId) {
    if (seen.has(parentId)) return depth;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return depth;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}

function sortFoldersForImport(folders: SessionFoldersSetting['folders']): SessionFoldersSetting['folders'][number][] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return [...folders].sort((left, right) => (
    folderImportDepth(left, byId) - folderImportDepth(right, byId)
    || compareNullableSortKey(left.sortKey, right.sortKey)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  ));
}

function buildFolderDisplay(folder: SessionFoldersSetting['folders'][number]): PlainContentEnvelope {
  return {
    t: 'plain',
    v: {
      name: folder.name,
      workspace: folder.workspace,
    },
  };
}

export function buildSessionOrganizationImportRequestFromFolderSettings(params: Readonly<{
  serverId: string;
  sessionFoldersV1: SessionFoldersSetting;
  sessionListGroupOrderV1?: Readonly<Record<string, readonly string[] | undefined>>;
}>): ImportLegacySessionOrganizationRequest {
  const serverId = params.serverId.trim();
  const folders = sortFoldersForImport(params.sessionFoldersV1.folders).map((folder) => ({
    folderId: folder.id,
    folderKey: folder.id,
    parentFolderId: folder.parentId,
    parentFolderKey: folder.parentId,
    sortKey: folder.sortKey ?? null,
    display: buildFolderDisplay(folder),
  }));

  const orderEntries: SessionOrganizationOrderEntry[] = [];
  for (const [scopeKeyRaw, itemKeysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
    const scopeKey = scopeKeyRaw.trim();
    if (!scopeKey || !Array.isArray(itemKeysRaw)) continue;
    const scopeKind = scopeKey === PINNED_GROUP_KEY_V1 ? 'pinned' : 'group';
    const normalizedScopeKey = scopeKind === 'pinned' ? 'pins' : scopeKey;
    const seen = new Set<string>();
    itemKeysRaw.forEach((itemKeyRaw, index) => {
      const raw = typeof itemKeyRaw === 'string' ? itemKeyRaw.trim() : '';
      if (!raw) return;
      const isFolder = raw.startsWith('folder:');
      const itemKey = isFolder ? stripFolderItemKey(raw) : stripServerSessionKey(serverId, raw);
      if (!itemKey) return;
      const itemKind = isFolder ? 'folder' : 'session';
      const dedupeKey = `${itemKind}:${itemKey}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      orderEntries.push({
        scopeKind,
        scopeKey: normalizedScopeKey,
        itemKind,
        itemKey,
        sortKey: buildSortKey(index),
      });
    });
  }

  return {
    pins: [],
    folders,
    tags: [],
    tagAssignments: [],
    orderEntries,
    labels: [],
  };
}

export function buildSessionFolderSettingsSnapshotFromOrganizationSnapshot(params: Readonly<{
  serverId: string;
  snapshot: SessionOrganizationSnapshot;
}>): SessionFolderSettingsSnapshot {
  const folders = params.snapshot.folders
    .filter((folder) => folder.archivedAt == null)
    .map((folder) => {
      const display = readPlainFolderDisplay(folder.display);
      if (!display) return null;
      return {
        id: folder.folderId,
        workspace: display.workspace,
        parentId: folder.parentFolderId,
        name: display.name,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        ...(folder.sortKey ? { sortKey: folder.sortKey } : {}),
      };
    })
    .filter((folder): folder is NonNullable<typeof folder> => folder != null)
    .sort((left, right) => (
      compareNullableSortKey(left.sortKey, right.sortKey)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    ));

  const sessionListGroupOrderV1: Record<string, string[]> = {};
  const orderedEntries = [...params.snapshot.orderEntries]
    .sort((left, right) => (
      left.scopeKind.localeCompare(right.scopeKind)
      || left.scopeKey.localeCompare(right.scopeKey)
      || compareNullableSortKey(left.sortKey, right.sortKey)
      || left.itemKind.localeCompare(right.itemKind)
      || left.itemKey.localeCompare(right.itemKey)
    ));
  for (const entry of orderedEntries) {
    const scopeKey = entry.scopeKind === 'pinned' ? PINNED_GROUP_KEY_V1 : entry.scopeKey.trim();
    const itemKey = entry.itemKind === 'session'
      ? `${params.serverId}:${entry.itemKey}`
      : entry.itemKind === 'folder'
        ? `folder:${entry.itemKey.trim().replace(/^folder:/, '')}`
        : entry.itemKey.trim();
    if (!scopeKey || !itemKey) continue;
    const bucket = sessionListGroupOrderV1[scopeKey] ?? [];
    bucket.push(itemKey);
    sessionListGroupOrderV1[scopeKey] = bucket;
  }

  return {
    sessionFoldersV1: { v: 1, folders },
    sessionListGroupOrderV1,
  };
}

export async function importSessionOrganization(params: Readonly<{
  baseUrl: string;
  token: string;
  request: ImportLegacySessionOrganizationRequest;
}>): Promise<ImportLegacySessionOrganizationResponse> {
  const res = await fetchJson<ImportLegacySessionOrganizationResponse>(
    buildUrl(params.baseUrl, `${SESSION_ORGANIZATION_ROUTE}/import`),
    {
      method: 'POST',
      headers: authHeaders(params.token),
      body: JSON.stringify(params.request),
      timeoutMs: 20_000,
    },
  );
  if (res.status !== 200) {
    throw new Error(`Failed to import session organization (status=${res.status})`);
  }
  return res.data;
}

export async function fetchSessionOrganizationSnapshot(params: Readonly<{
  baseUrl: string;
  token: string;
  request?: SessionOrganizationSnapshotRequest;
}>): Promise<SessionOrganizationSnapshot> {
  const res = await fetchJson<SessionOrganizationSnapshotResponse>(
    buildUrl(params.baseUrl, `${SESSION_ORGANIZATION_ROUTE}${buildSnapshotQuery(params.request)}`),
    {
      headers: authHeaders(params.token),
      timeoutMs: 20_000,
    },
  );
  if (res.status !== 200) {
    throw new Error(`Failed to fetch session organization snapshot (status=${res.status})`);
  }
  return res.data.snapshot;
}

export function readPinnedSessionIdsFromOrganizationSnapshot(snapshot: SessionOrganizationSnapshot): string[] {
  return [...snapshot.pins]
    .sort((left, right) => (
      compareNullableSortKey(left.sortKey, right.sortKey)
      || left.pinnedAt - right.pinnedAt
      || left.sessionId.localeCompare(right.sessionId)
    ))
    .map((pin) => pin.sessionId);
}

export async function readSessionTagLabelsFromOrganizationSnapshot(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<string[]> {
  const snapshot = await fetchSessionOrganizationSnapshot({
    baseUrl: params.baseUrl,
    token: params.token,
    request: {
      includeFolders: false,
      includeTags: true,
      includeLabels: false,
      assignmentSessionIds: [params.sessionId],
    },
  });
  const labelsByTagId = new Map(
    snapshot.tags.map((tag) => [tag.tagId, readPlainTagLabel(tag.display) ?? tag.tagKey ?? tag.tagId] as const),
  );
  const assignment = snapshot.tagAssignments.find((candidate) => candidate.sessionId === params.sessionId);
  return [...(assignment?.tagIds ?? [])]
    .map((tagId) => labelsByTagId.get(tagId) ?? tagId)
    .sort((left, right) => left.localeCompare(right));
}

export async function readSessionOrganizationFolderSettingsSnapshot(params: Readonly<{
  baseUrl: string;
  token: string;
  serverId: string;
}>): Promise<SessionFolderSettingsSnapshot> {
  const snapshot = await fetchSessionOrganizationSnapshot({
    baseUrl: params.baseUrl,
    token: params.token,
    request: {
      includeFolders: true,
      includeTags: false,
      includeLabels: false,
      includeAllFolderAssignments: true,
      includeAllTagAssignments: true,
    },
  });
  return buildSessionFolderSettingsSnapshotFromOrganizationSnapshot({
    serverId: params.serverId,
    snapshot,
  });
}

export async function setSessionOrganizationPin(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  pinned: boolean;
  sortKey?: string | null;
}>): Promise<SetSessionPinResponse> {
  const res = await fetchJson<SetSessionPinResponse>(
    buildUrl(params.baseUrl, `${SESSION_ORGANIZATION_ROUTE}/pins/${encodeURIComponent(params.sessionId)}`),
    {
      method: 'PUT',
      headers: authHeaders(params.token),
      body: JSON.stringify({
        pinned: params.pinned,
        sortKey: params.sortKey ?? null,
      }),
      timeoutMs: 20_000,
    },
  );
  if (res.status !== 200) {
    throw new Error(`Failed to set session organization pin for ${params.sessionId} (status=${res.status})`);
  }
  return res.data;
}
