import { randomUUID } from 'node:crypto';

import type { StartedDaemon } from '../daemon/daemon';
import { normalizeSpawnSessionRequestBody } from '../daemon/normalizeSpawnSessionRequestBody';
import { assertBrowserCanAccessSession, type BrowserSessionAccessPage } from './assertBrowserCanAccessSession';

export async function spawnSessionFromDaemon(params: Readonly<{
  daemon: StartedDaemon;
  directory: string;
  agent?: string;
  request?: Readonly<Record<string, unknown>>;
  browserAccess?: Readonly<{
    page: BrowserSessionAccessPage;
    serverUrl: string;
  }>;
}>): Promise<string> {
  const token = params.daemon.state.controlToken;
  if (!token) throw new Error('daemon control token missing');
  const body = normalizeSpawnSessionRequestBody({
    ...(params.request ?? {}),
    directory: params.directory,
    agent: params.agent ?? 'claude',
    spawnNonce:
      typeof params.request?.spawnNonce === 'string' && params.request.spawnNonce.trim().length > 0
        ? params.request.spawnNonce
        : randomUUID(),
  });

  const res = await fetch(`http://127.0.0.1:${params.daemon.state.httpPort}/spawn-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-happier-daemon-token': token,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !json || json.success !== true || typeof json.sessionId !== 'string') {
    throw new Error(`Failed to spawn session (status=${res.status}): ${JSON.stringify(json)}`);
  }
  const sessionId = json.sessionId as string;
  if (params.browserAccess) {
    await assertBrowserCanAccessSession({
      page: params.browserAccess.page,
      serverUrl: params.browserAccess.serverUrl,
      sessionId,
    });
  }
  return sessionId;
}
