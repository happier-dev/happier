import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { fetchJson } from '../http';
import { mutateUiE2eLocalSettings } from './localSettingsStorage';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';
import { mutateUiE2eScopedAccountSettings } from './scopedAccountSettingsStorage';
import {
  buildSessionOrganizationImportRequestFromFolderSettings,
  fetchSessionOrganizationSnapshot,
  importSessionOrganization,
  readSessionOrganizationFolderSettingsSnapshot,
  type SessionFolderSettingsSnapshot,
  type SessionFoldersSetting,
} from './sessionOrganization';

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

export type { SessionFolderSettingsSnapshot, SessionFoldersSetting } from './sessionOrganization';

type SessionCreateResponse = {
  session?: {
    id?: string;
  };
};

type SessionFolderAssignmentSetResponse = {
  sessionId?: string;
  folderId?: string | null;
};

type ServerFeaturesIdentityResponse = {
  capabilities?: {
    serverIdentity?: {
      serverIdentityId?: unknown;
    };
  };
};

type SessionFolderDragSettingsRouteParams = Readonly<{
  baseUrl: string;
  token: string;
  serverId: string;
}>;

export function deriveServerIdFromUrl(url: string): string {
  const normalized = url.trim();
  const parsed = new URL(normalized);
  const port = parsed.port ? `-${parsed.port}` : '';
  const base = `${parsed.hostname.toLowerCase()}${port}`;
  return base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_') || 'custom';
}

export async function resolveCanonicalServerIdForUi(baseUrl: string): Promise<string> {
  const fallback = deriveServerIdFromUrl(baseUrl);
  try {
    const response = await fetchJson<ServerFeaturesIdentityResponse>(`${baseUrl}/v1/features`, {
      timeoutMs: 15_000,
    });
    const serverIdentityId = response.data?.capabilities?.serverIdentity?.serverIdentityId;
    return typeof serverIdentityId === 'string' && serverIdentityId.trim()
      ? serverIdentityId.trim()
      : fallback;
  } catch {
    return fallback;
  }
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

async function ensureSessionFolderViewMode(params: Readonly<{
  page: Page;
  folderViewMode: 'tree' | 'off';
  sessionFoldersV1: SessionFoldersSetting;
}>): Promise<void> {
  if (params.folderViewMode !== 'tree') return;
  const firstFolderId = params.sessionFoldersV1.folders[0]?.id;
  if (!firstFolderId) return;

  const firstFolderHeader = params.page.getByTestId(`session-folder-header-${firstFolderId}`);
  // The scoped setting was persisted before navigation. Header absence here means the
  // organization snapshot has not rendered yet; toggling would turn the requested
  // tree mode back off and make a slow runner fail deterministically.
  await expect(firstFolderHeader).toHaveCount(1, { timeout: 120_000 });
}

async function selectSessionListViewMenuItem(page: Page, testId: string): Promise<void> {
  await page.getByTestId('session-list-ordering-menu-trigger').first().click();
  const item = page.getByTestId(testId);
  await expect(item).toHaveCount(1, { timeout: 60_000 });
  await item.click();
}

async function ensureSessionFolderDragOrderingPreferences(params: Readonly<{
  page: Page;
  folderSortMode: 'foldersFirst' | 'mixed';
}>): Promise<void> {
  await selectSessionListViewMenuItem(params.page, 'session-list-ordering-mode-custom');
  await selectSessionListViewMenuItem(
    params.page,
    params.folderSortMode === 'mixed'
      ? 'session-folder-sort-mode-mixed'
      : 'session-folder-sort-mode-folders-first',
  );
}

export async function setSessionFolderDragSettings(params: Readonly<{
  page: Page;
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  serverId: string;
  sessionFoldersV1: SessionFoldersSetting;
  sessionListGroupOrderV1?: Record<string, string[]>;
  folderViewMode?: 'tree' | 'off';
  folderSortMode?: 'foldersFirst' | 'mixed';
}>): Promise<void> {
  await importSessionOrganization({
    baseUrl: params.apiBaseUrl,
    token: params.token,
    request: buildSessionOrganizationImportRequestFromFolderSettings({
      serverId: params.serverId,
      sessionFoldersV1: params.sessionFoldersV1,
      sessionListGroupOrderV1: params.sessionListGroupOrderV1,
    }),
  });

  await mutateUiE2eScopedAccountSettings({
    page: params.page,
    settingsPatch: {
      sessionFolderViewModeV1: params.folderViewMode ?? 'tree',
      sessionListActiveGroupingV1: 'project',
      sessionListInactiveGroupingV1: 'project',
      sessionListOrderingModeV1: 'custom',
    },
  });

  await mutateUiE2eLocalSettings({
    page: params.page,
    settingsPatch: {
      sessionListFolderSortModeV1: params.folderSortMode ?? 'mixed',
    },
  });

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/?happier_hmr=0`, 120_000);
  await ensureSessionFolderDragOrderingPreferences({
    page: params.page,
    folderSortMode: params.folderSortMode ?? 'mixed',
  });
  await ensureSessionFolderViewMode({
    page: params.page,
    folderViewMode: params.folderViewMode ?? 'tree',
    sessionFoldersV1: params.sessionFoldersV1,
  });
}

export async function readSessionFolderDragSettings(
  params: SessionFolderDragSettingsRouteParams,
): Promise<SessionFolderSettingsSnapshot> {
  return readSessionOrganizationFolderSettingsSnapshot(params);
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
    `${params.baseUrl}/v2/session-organization/folder-assignments/${encodeURIComponent(params.sessionId)}`,
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
  const snapshot = await fetchSessionOrganizationSnapshot({
    baseUrl: params.baseUrl,
    token: params.token,
    request: {
      includeFolders: false,
      includeTags: false,
      includeLabels: false,
      assignmentSessionIds: [params.sessionId],
    },
  });
  return snapshot.folderAssignments.find((assignment) => assignment.sessionId === params.sessionId)?.folderId ?? null;
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
  baseUrl: string;
  token: string;
  serverId: string;
  folderId: string;
  parentId: string | null;
}>): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await readSessionFolderDragSettings(params);
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
  baseUrl: string;
  token: string;
  serverId: string;
  firstKey: string;
  secondKey: string;
}>): Promise<void> {
  let lastSnapshot: SessionFolderSettingsSnapshot | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const snapshot = await readSessionFolderDragSettings(params);
    lastSnapshot = snapshot;
    const indexes = readOrderIndex(snapshot.sessionListGroupOrderV1, params.firstKey, params.secondKey);
    if (indexes ? indexes.first < indexes.second : false) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`Expected ${params.firstKey} before ${params.secondKey}; last order map=${JSON.stringify(lastSnapshot?.sessionListGroupOrderV1 ?? null)}`);
}

export async function expectOrderMapStartsWith(params: Readonly<{
  baseUrl: string;
  token: string;
  serverId: string;
  firstKey: string;
}>): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await readSessionFolderDragSettings(params);
    return Object.values(snapshot.sessionListGroupOrderV1)
      .some((keys) => Array.isArray(keys) && keys[0] === params.firstKey);
  }, { timeout: 60_000 }).toBe(true);
}
