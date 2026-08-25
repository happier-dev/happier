import { randomUUID } from 'node:crypto';

import type { StartedDaemon } from '../daemon/daemon';
import { daemonControlPostJson } from '../daemon/controlServerClient';
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

  const response = await daemonControlPostJson<unknown>({
    port: params.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: token,
    body,
  });
  const json = response.data;
  if (
    response.status < 200
    || response.status >= 300
    || typeof json !== 'object'
    || json === null
    || !('success' in json)
    || json.success !== true
    || !('sessionId' in json)
    || typeof json.sessionId !== 'string'
  ) {
    throw new Error(`Failed to spawn session (status=${response.status}): ${JSON.stringify(json)}`);
  }
  const sessionId = json.sessionId;
  if (params.browserAccess) {
    await assertBrowserCanAccessSession({
      page: params.browserAccess.page,
      serverUrl: params.browserAccess.serverUrl,
      sessionId,
    });
  }
  return sessionId;
}
