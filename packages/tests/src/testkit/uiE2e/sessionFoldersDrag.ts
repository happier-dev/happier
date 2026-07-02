import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { fetchJson } from '../http';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';

export {
  beginSteppedSessionDrag,
  dragFolderToTarget,
  dragSessionToTarget,
  dragSessionWithGeometryProbe,
  dragSessionWithLongTaskProbe,
  readVisibleSessionRowOrder,
  type CapturedRect,
  type DragDispatchResult,
  type DragGeometryProbe,
  type LongTaskSummary,
  type SteppedSessionDrag,
} from './sessionFoldersPointerDrag';

const ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX = 'account-settings:v2:';
const PENDING_ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX = 'pending-account-settings:v2:';

type PersistedSettingsEnvelope = {
  settings?: Record<string, unknown>;
};

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

type SessionFolderSettingsSnapshot = Readonly<{
  sessionFoldersV1: SessionFoldersSetting;
  sessionListGroupOrderV1: Record<string, string[]>;
}>;

type SessionCreateResponse = {
  session?: {
    id?: string;
  };
};

type SessionFolderAssignmentListResponse = {
  assignments?: ReadonlyArray<Readonly<{
    sessionId?: string;
    folderId?: string | null;
  }>>;
};

type SessionFolderAssignmentSetResponse = {
  sessionId?: string;
  folderId?: string | null;
};

export function deriveServerIdFromUrl(url: string): string {
  const normalized = url.trim();
  const parsed = new URL(normalized);
  const port = parsed.port ? `-${parsed.port}` : '';
  const base = `${parsed.hostname.toLowerCase()}${port}`;
  return base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_') || 'custom';
}

export function sessionOrderKey(serverId: string, sessionId: string): string {
  return `${serverId}:${sessionId}`;
}

export function folderOrderKey(folderId: string): string {
  return `folder:${folderId}`;
}

function readOrderIndex(
  order: Readonly<Record<string, readonly string[] | undefined>>,
  firstKey: string,
  secondKey: string,
): Readonly<{ first: number; second: number }> | null {
  for (const keys of Object.values(order)) {
    if (!Array.isArray(keys)) continue;
    const first = keys.indexOf(firstKey);
    const second = keys.indexOf(secondKey);
    if (first >= 0 && second >= 0) return { first, second };
  }
  return null;
}

async function mutateScopedSettings(params: Readonly<{
  page: Page;
  values: Record<string, unknown>;
}>): Promise<void> {
  await params.page.evaluate(
    ({ accountSettingsLogicalKeyPrefix, pendingAccountSettingsLogicalKeyPrefix, values }) => {
      type ParsedScopedSettingsKey = Readonly<{
        fullKey: string;
        logicalKey: string;
        storageNamespace: string;
      }>;

      const parseScopedSettingsKey = (rawKey: string): ParsedScopedSettingsKey | null => {
        const separatorIndex = rawKey.lastIndexOf('\\');
        if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) return null;

        const storageNamespace = rawKey.slice(0, separatorIndex);
        const logicalKey = rawKey.slice(separatorIndex + 1);
        if (!logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) return null;

        return {
          fullKey: rawKey,
          logicalKey,
          storageNamespace,
        };
      };

      const scopedSettingsKeys: ParsedScopedSettingsKey[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (!rawKey) continue;

        const parsedKey = parseScopedSettingsKey(rawKey);
        if (parsedKey) scopedSettingsKeys.push(parsedKey);
      }
      if (scopedSettingsKeys.length !== 1) {
        throw new Error(`expected exactly one scoped persisted settings record, found ${scopedSettingsKeys.length}`);
      }

      const settingsKey = scopedSettingsKeys[0]!;
      const pendingSettingsKey = `${settingsKey.storageNamespace}\\${pendingAccountSettingsLogicalKeyPrefix}${settingsKey.logicalKey.slice(accountSettingsLogicalKeyPrefix.length)}`;
      const rawSettings = window.localStorage.getItem(settingsKey.fullKey);
      if (!rawSettings) throw new Error('missing persisted settings');

      const parsed = JSON.parse(rawSettings) as PersistedSettingsEnvelope;
      const settings = typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
      const rawPending = window.localStorage.getItem(pendingSettingsKey);
      const pending = rawPending && typeof JSON.parse(rawPending) === 'object'
        ? JSON.parse(rawPending) as Record<string, unknown>
        : {};

      parsed.settings = {
        ...settings,
        ...values,
      };

      window.localStorage.setItem(settingsKey.fullKey, JSON.stringify(parsed));
      window.localStorage.setItem(
        pendingSettingsKey,
        JSON.stringify({
          ...pending,
          ...values,
        }),
      );
    },
    {
      accountSettingsLogicalKeyPrefix: ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX,
      pendingAccountSettingsLogicalKeyPrefix: PENDING_ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX,
      values: params.values,
    },
  );
}

export async function setSessionFolderDragSettings(params: Readonly<{
  page: Page;
  baseUrl: string;
  sessionFoldersV1: SessionFoldersSetting;
  sessionListGroupOrderV1?: Record<string, string[]>;
}>): Promise<void> {
  await mutateScopedSettings({
    page: params.page,
    values: {
      sessionFoldersV1: params.sessionFoldersV1,
      sessionFolderViewModeV1: 'tree',
      sessionListGroupOrderV1: params.sessionListGroupOrderV1 ?? {},
    },
  });

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/?happier_hmr=0`, 120_000);
}

export async function readSessionFolderDragSettings(page: Page): Promise<SessionFolderSettingsSnapshot> {
  return page.evaluate(
    ({ accountSettingsLogicalKeyPrefix }) => {
      type ParsedScopedSettingsKey = Readonly<{ fullKey: string; logicalKey: string }>;

      const keys: ParsedScopedSettingsKey[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (!rawKey) continue;
        const separatorIndex = rawKey.lastIndexOf('\\');
        if (separatorIndex <= 0) continue;
        const logicalKey = rawKey.slice(separatorIndex + 1);
        if (logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) {
          keys.push({ fullKey: rawKey, logicalKey });
        }
      }
      if (keys.length !== 1) {
        throw new Error(`expected exactly one scoped persisted settings record, found ${keys.length}`);
      }

      const rawSettings = window.localStorage.getItem(keys[0]!.fullKey);
      if (!rawSettings) throw new Error('missing persisted settings');

      const parsed = JSON.parse(rawSettings) as PersistedSettingsEnvelope;
      const settings = typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
      return {
        sessionFoldersV1: settings.sessionFoldersV1,
        sessionListGroupOrderV1: settings.sessionListGroupOrderV1 ?? {},
      };
    },
    { accountSettingsLogicalKeyPrefix: ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX },
  ) as Promise<SessionFolderSettingsSnapshot>;
}

export async function createPlainSession(params: Readonly<{
  baseUrl: string;
  token: string;
  title: string;
  rootPath: string;
  machineId: string;
  tagPrefix: string;
}>): Promise<string> {
  const tag = `${params.tagPrefix}-${randomUUID()}`;
  const res = await fetchJson<SessionCreateResponse>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag,
      metadata: JSON.stringify({
        v: 1,
        name: params.title,
        path: params.rootPath,
        homeDir: params.rootPath.split('/').slice(0, -1).join('/') || '/',
        host: params.machineId,
        machineId: params.machineId,
        version: '0.0.0',
        flavor: 'claude',
      }),
      agentState: null,
      dataEncryptionKey: null,
      encryptionMode: 'plain',
    }),
    timeoutMs: 20_000,
  });

  const sessionId = res.data?.session?.id;
  if (res.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create seeded session (status=${res.status})`);
  }
  return sessionId;
}

export async function setSessionFolderAssignment(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  folderId: string | null;
}>): Promise<void> {
  const res = await fetchJson<SessionFolderAssignmentSetResponse>(
    `${params.baseUrl}/v2/session-folder-assignments/${encodeURIComponent(params.sessionId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folderId: params.folderId }),
      timeoutMs: 20_000,
    },
  );
  if (res.status !== 200 || res.data?.sessionId !== params.sessionId) {
    throw new Error(`Failed to set folder assignment for ${params.sessionId} (status=${res.status})`);
  }
}

async function fetchFolderAssignment(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<string | null> {
  const res = await fetchJson<SessionFolderAssignmentListResponse>(
    `${params.baseUrl}/v2/session-folder-assignments?sessionIds=${encodeURIComponent(params.sessionId)}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 20_000,
    },
  );
  if (res.status !== 200) {
    throw new Error(`Failed to fetch folder assignment for ${params.sessionId} (status=${res.status})`);
  }
  return res.data?.assignments?.find((assignment) => assignment.sessionId === params.sessionId)?.folderId ?? null;
}

export async function expectFolderAssignment(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  folderId: string | null;
}>): Promise<void> {
  await expect.poll(
    () => fetchFolderAssignment(params),
    { timeout: 60_000 },
  ).toBe(params.folderId);
}

export async function expectFolderParent(params: Readonly<{
  page: Page;
  folderId: string;
  parentId: string | null;
}>): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await readSessionFolderDragSettings(params.page);
    return snapshot.sessionFoldersV1.folders.find((folder) => folder.id === params.folderId)?.parentId ?? null;
  }, { timeout: 60_000 }).toBe(params.parentId);
}

export async function expectOrderBefore(params: Readonly<{
  page: Page;
  firstTestId: string;
  secondTestId: string;
}>): Promise<void> {
  await expect.poll(async () => {
    const firstBox = await params.page.getByTestId(params.firstTestId).boundingBox();
    const secondBox = await params.page.getByTestId(params.secondTestId).boundingBox();
    if (!firstBox || !secondBox) return false;
    return firstBox.y < secondBox.y;
  }, { timeout: 60_000 }).toBe(true);
}

export async function expectOrderMapContainsBefore(params: Readonly<{
  page: Page;
  firstKey: string;
  secondKey: string;
}>): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await readSessionFolderDragSettings(params.page);
    const indexes = readOrderIndex(snapshot.sessionListGroupOrderV1, params.firstKey, params.secondKey);
    return indexes ? indexes.first < indexes.second : false;
  }, { timeout: 60_000 }).toBe(true);
}

export async function expectOrderMapStartsWith(params: Readonly<{
  page: Page;
  firstKey: string;
}>): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await readSessionFolderDragSettings(params.page);
    return Object.values(snapshot.sessionListGroupOrderV1)
      .some((keys) => Array.isArray(keys) && keys[0] === params.firstKey);
  }, { timeout: 60_000 }).toBe(true);
}
