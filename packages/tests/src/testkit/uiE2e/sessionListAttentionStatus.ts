import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { fetchJson } from '../http';
import { repoRootDir } from '../paths';
import { createMachineBoundSessionScopedSocketCollector } from '../sessionSocketBinding';
import { fetchSessionV2 } from '../sessions';
import type { SocketCollector } from '../socketClient';
import { waitFor } from '../timing';
import { createPlainSession } from './sessionFoldersDrag';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';
import { sessionListOccurrenceId, sessionListRowTestId } from './sessionListRowTestId';

const SEEDED_MACHINE_ID = 'seeded-session-list-attention-status-machine';

export const sessionListAttentionTestIds = {
  row: sessionListRowTestId,
  attentionIndicator: (
    sessionId: string,
    state: 'working' | 'ready' | 'permission_required' | 'action_required' | 'failed' | 'unread',
    serverId: string,
  ) => `session-list-attention-indicator-${sessionListOccurrenceId(serverId, sessionId)}-trailing-${state}`,
  statusSubtitle: (sessionId: string, state: 'working' | 'ready' | 'failed', serverId: string) =>
    `session-list-status-subtitle-${sessionListOccurrenceId(serverId, sessionId)}-${state}`,
  statusSubtitleText: (sessionId: string, state: 'working' | 'ready' | 'failed', serverId: string) =>
    `session-list-status-subtitle-text-${sessionListOccurrenceId(serverId, sessionId)}-${state}`,
  secondaryReadyIndicator: (sessionId: string, serverId: string, occurrenceRole: 'base' | 'needsYou' | 'working' = 'base') =>
    `session-list-attention-indicator-${sessionListOccurrenceId(serverId, sessionId, occurrenceRole)}-secondary-ready`,
  attentionHeader: 'session-list-header:attention-promotion-v1',
  workingHeader: 'session-list-header:working-placement-v1',
  densityTrigger: 'settings-session-sessionListDensity-trigger',
  attentionPromotionModeTrigger: 'settings-session-attentionPromotionMode-trigger',
  workingPlacementModeTrigger: 'settings-session-workingPlacementMode-trigger',
  workingStatusAnimatedTextToggle: 'settings-session-workingStatusAnimatedText-toggle',
  densityOption: (density: 'narrow' | 'cozy') => `dropdown-option-${density}`,
  settingOption: (option: string) => `dropdown-option-${option}`,
  backgroundWorkAttentionModeTrigger: 'settings-session-backgroundWorkAttentionMode-trigger',
} as const;

export type SeededAttentionSession = Readonly<{
  id: string;
  title: string;
}>;

type MessageCreateResponse = Readonly<{
  didWrite?: unknown;
  message?: Readonly<{
    seq?: unknown;
  }>;
}>;

type SessionTurnMutationResponse = Readonly<{
  success?: unknown;
  applied?: unknown;
  reason?: unknown;
}>;

type PrimaryTurnStatus = 'in_progress' | 'completed' | 'cancelled';

function requireFiniteNumber(value: unknown, context: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`Missing ${context}`);
}

export async function seedAttentionSession(params: Readonly<{
  baseUrl: string;
  token: string;
  title: string;
}>): Promise<SeededAttentionSession> {
  const id = await createPlainSession({
    baseUrl: params.baseUrl,
    token: params.token,
    title: params.title,
    rootPath: repoRootDir(),
    machineId: SEEDED_MACHINE_ID,
    tagPrefix: 'session-list-attention',
  });
  return { id, title: params.title };
}

export async function connectAuthenticatedSessionPublisher(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  thinking?: boolean;
}>): Promise<SocketCollector> {
  const { socket } = await createMachineBoundSessionScopedSocketCollector(params);
  socket.connect();
  try {
    await waitFor(async () => socket.isConnected(), {
      timeoutMs: 20_000,
      context: `connect authenticated machine publisher for ${params.sessionId}`,
    });
    socket.emit('session-alive', {
      sid: params.sessionId,
      time: Date.now(),
      thinking: params.thinking ?? false,
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function postPlainMessage(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  value: unknown;
}>): Promise<number> {
  const res = await fetchJson<MessageCreateResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.localId,
    },
    body: JSON.stringify({
      localId: params.localId,
      content: {
        t: 'plain',
        v: params.value,
      },
    }),
    timeoutMs: 20_000,
  });

  if (res.status !== 200 || res.data?.didWrite !== true) {
    throw new Error(`Failed to seed message ${params.localId} (status=${res.status})`);
  }

  return requireFiniteNumber(res.data?.message?.seq, `message seq for ${params.localId}`);
}

export async function seedReadyMarker(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<void> {
  await postPlainMessage({
    ...params,
    localId: `ready-text-${randomUUID()}`,
    value: {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          uuid: `ready-assistant-${randomUUID()}`,
          message: {
            content: [{ type: 'text', text: 'Seeded ready row response.' }],
          },
        },
      },
    },
  });
  await postPlainMessage({
    ...params,
    localId: `ready-event-${randomUUID()}`,
    value: {
      role: 'agent',
      content: {
        type: 'event',
        id: `ready-${randomUUID()}`,
        data: { type: 'ready' },
      },
    },
  });
}

export async function updateSessionRuntimeStatus(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  latestTurnStatus: PrimaryTurnStatus;
}>): Promise<void> {
  const observedAt = Date.now();
  const turnId = `turn-${randomUUID()}`;
  await postSessionTurnMutation({
    ...params,
    mutation: {
      v: 1,
      action: 'begin',
      sessionId: params.sessionId,
      turnId,
      mutationId: `mutation-${randomUUID()}`,
      observedAt,
      provider: 'claude',
    },
  });

  if (params.latestTurnStatus !== 'in_progress') {
    await postSessionTurnMutation({
      ...params,
      mutation: {
        v: 1,
        action: params.latestTurnStatus === 'completed' ? 'complete' : 'cancel',
        sessionId: params.sessionId,
        turnId,
        mutationId: `mutation-${randomUUID()}`,
        observedAt: observedAt + 1,
        provider: 'claude',
      },
    });
  }

  await waitFor(async () => {
    const session = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    return session.latestTurnStatus === params.latestTurnStatus;
  }, {
    timeoutMs: 20_000,
    context: `persist ${params.latestTurnStatus} turn status for ${params.sessionId}`,
  });
}

async function postSessionTurnMutation(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  mutation: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const res = await fetchJson<SessionTurnMutationResponse>(`${params.baseUrl}/v1/sessions/${params.sessionId}/turns/mutations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params.mutation),
    timeoutMs: 20_000,
  });

  if (res.status !== 200 || res.data?.success !== true) {
    throw new Error(`Failed to post session turn mutation (status=${res.status}, reason=${String(res.data?.reason)})`);
  }
}

export async function chooseSessionListDensity(params: Readonly<{
  page: Page;
  baseUrl: string;
  density: 'narrow' | 'cozy';
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  await expect(params.page.getByTestId(sessionListAttentionTestIds.densityTrigger)).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId(sessionListAttentionTestIds.densityTrigger).click();
  await params.page.getByTestId(sessionListAttentionTestIds.densityOption(params.density)).click();
}

export async function chooseSessionListSettingOption(params: Readonly<{
  page: Page;
  baseUrl: string;
  triggerTestId: string;
  option?: 'global' | 'keepWorking' | 'keepWorkingUnread' | 'showUnread';
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  await expect(params.page.getByTestId(params.triggerTestId)).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId(params.triggerTestId).click();
  await params.page.getByTestId(sessionListAttentionTestIds.settingOption(params.option ?? 'global')).click();
}

async function readToggleChecked(page: Page, testId: string): Promise<boolean> {
  const raw = await page.getByTestId(testId).getAttribute('aria-checked');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${testId} missing aria-checked`);
}

async function expectToggleChecked(page: Page, testId: string, expected: boolean): Promise<void> {
  await expect.poll(
    async () => readToggleChecked(page, testId),
    { timeout: 60_000 },
  ).toBe(expected);
}

export async function toggleWorkingStatusAnimatedTextOff(params: Readonly<{
  page: Page;
  baseUrl: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session?happier_hmr=0`, 180_000);
  const toggle = params.page.getByTestId(sessionListAttentionTestIds.workingStatusAnimatedTextToggle);
  await expect(toggle).toHaveCount(1, { timeout: 60_000 });

  const initiallyChecked = await readToggleChecked(params.page, sessionListAttentionTestIds.workingStatusAnimatedTextToggle);
  await toggle.click();
  await expectToggleChecked(params.page, sessionListAttentionTestIds.workingStatusAnimatedTextToggle, !initiallyChecked);

  if (!initiallyChecked) {
    await toggle.click();
    await expectToggleChecked(params.page, sessionListAttentionTestIds.workingStatusAnimatedTextToggle, false);
  }
}

export function sessionRow(page: Page, sessionId: string, serverId: string, occurrenceRole: 'base' | 'needsYou' | 'working' = 'base') {
  return page.getByTestId(sessionListAttentionTestIds.row(serverId, sessionId, occurrenceRole));
}

export function anySessionAttentionIndicator(page: Page, sessionId: string, serverId: string) {
  return sessionRow(page, sessionId, serverId).locator('[data-testid^="session-list-attention-indicator-"]');
}

export function sessionStatusSubtitle(page: Page, sessionId: string, state: 'working' | 'ready' | 'failed', serverId: string) {
  return page.getByTestId(sessionListAttentionTestIds.statusSubtitle(sessionId, state, serverId));
}

export function sessionStatusSubtitleText(page: Page, sessionId: string, state: 'working' | 'ready' | 'failed', serverId: string) {
  return page.getByTestId(sessionListAttentionTestIds.statusSubtitleText(sessionId, state, serverId));
}

function rowTestIdForSection(params: Readonly<{ serverId: string; sessionId: string; headerTestId: string }>): string {
  return sessionListAttentionTestIds.row(params.serverId, params.sessionId,
    params.headerTestId === sessionListAttentionTestIds.attentionHeader ? 'needsYou'
      : params.headerTestId === sessionListAttentionTestIds.workingHeader ? 'working' : 'base');
}

export async function expectRowInSection(params: Readonly<{
  page: Page;
  serverId: string;
  headerTestId: string;
  sessionId: string;
}>): Promise<void> {
  const rowTestId = rowTestIdForSection(params);
  await expect.poll(
    async () => params.page.evaluate(({ headerTestId, rowTestId }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'));
      const headerIndex = elements.findIndex((element) => element.dataset.testid === headerTestId);
      const rowIndex = elements.findIndex((element) => element.dataset.testid === rowTestId);
      if (headerIndex < 0 || rowIndex < 0 || rowIndex <= headerIndex) return false;
      const nextHeaderIndex = elements.findIndex((element, index) => {
        const testId = element.dataset.testid ?? '';
        return index > headerIndex && testId.startsWith('session-list-header:');
      });
      return nextHeaderIndex < 0 || rowIndex < nextHeaderIndex;
    }, {
      headerTestId: params.headerTestId,
      rowTestId,
    }),
    { timeout: 60_000 },
  ).toBe(true);
}

export async function expectRowNotInSection(params: Readonly<{
  page: Page;
  serverId: string;
  headerTestId: string;
  sessionId: string;
}>): Promise<void> {
  const rowTestId = rowTestIdForSection(params);
  await expect.poll(
    async () => params.page.evaluate(({ headerTestId, rowTestId }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-testid]'));
      const headerIndex = elements.findIndex((element) => element.dataset.testid === headerTestId);
      const rowIndex = elements.findIndex((element) => element.dataset.testid === rowTestId);
      if (headerIndex < 0 || rowIndex < 0 || rowIndex <= headerIndex) return true;
      const nextHeaderIndex = elements.findIndex((element, index) => {
        const testId = element.dataset.testid ?? '';
        return index > headerIndex && testId.startsWith('session-list-header:');
      });
      return nextHeaderIndex >= 0 && rowIndex > nextHeaderIndex;
    }, {
      headerTestId: params.headerTestId,
      rowTestId,
    }),
    { timeout: 60_000 },
  ).toBe(true);
}

export async function publishRuntimeActivity(params: Readonly<{
  socket: SocketCollector;
  sessionId: string;
  snapshot: Readonly<{ state: 'active' | 'idle'; activeCount: number }>;
}>): Promise<void> {
  const ack = await params.socket.emitWithAck<{ status?: string }>('session-runtime-activity-snapshot', {
    sessionId: params.sessionId,
    mutationId: `runtime-activity-${randomUUID()}`,
    snapshot: params.snapshot,
  });
  if (ack?.status !== 'applied' && ack?.status !== 'unchanged') {
    throw new Error(`Runtime activity snapshot was not applied (status=${String(ack?.status)})`);
  }
}


export function startPresenceKeepAlive(socket: SocketCollector, sessionId: string): () => void {
  const timer = setInterval(() => {
    socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
  }, 10_000);
  return () => clearInterval(timer);
}
