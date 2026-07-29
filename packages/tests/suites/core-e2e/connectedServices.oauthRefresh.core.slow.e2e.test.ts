import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  codexAuthPath,
  spawnConnectedCodexSession,
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import { type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

function parseCodexAuthJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected Codex auth.json object');
  }
  return parsed as Record<string, unknown>;
}

describe('core e2e: connected services OAuth refresh recovery contracts', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let fakeTokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
    await fakeTokenServer?.stop().catch(() => {});
    daemon = null;
    server = null;
    fakeTokenServer = null;
  });

  it('refreshes an expired OAuth credential centrally before materializing provider auth', async () => {
    fakeTokenServer = await startFakeTokenServer({
      respond: () => {
        return {
          status: 200,
          body: {
            access_token: 'fresh-access',
            refresh_token: 'rotated-refresh',
            id_token: 'fresh-id',
            expires_in: 3600,
          },
        };
      },
    });
    const fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-v2-codex-preflight-refresh'),
      testName: 'connected-services-v2-codex-preflight-refresh',
      tokenUrl: fakeTokenServer.tokenUrl,
      accessToken: 'expired-access',
      refreshToken: 'expired-refresh',
      idToken: 'expired-id',
      expiresAt: Date.now() - 60_000,
    });
    server = fixture.server;
    daemon = fixture.daemon;

    const spawnRes = await spawnConnectedCodexSession(fixture, 'connected-services-preflight-refresh-1');
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    const refreshRequests = fakeTokenServer.requests();
    expect(refreshRequests[0]).toMatchObject({
      path: '/oauth/token',
      method: 'POST',
    });
    expect(refreshRequests[0]?.body).toContain('refresh_token=expired-refresh');

    const authPath = codexAuthPath(fixture);
    await waitFor(async () => {
      const parsed = parseCodexAuthJson(await readFile(authPath, 'utf8'));
      return parsed.access_token === 'fresh-access';
    }, { timeoutMs: 20_000 });

    const materialized = parseCodexAuthJson(await readFile(authPath, 'utf8'));
    expect(materialized).toMatchObject({
      access_token: 'fresh-access',
      refresh_token: 'rotated-refresh',
      id_token: 'fresh-id',
      account_id: 'acct-1',
    });
    expect(JSON.stringify(materialized)).not.toContain('expired-access');

    await daemonControlPostJson({
      port: fixture.daemonPort,
      path: '/stop-session',
      body: { sessionId: spawnRes.data.sessionId },
      controlToken: fixture.controlToken,
      timeoutMs: 30_000,
    }).catch(() => {});
  }, 240_000);

  it('marks expired OAuth profiles reconnect-required when refresh returns invalid_grant', async () => {
    fakeTokenServer = await startFakeTokenServer({
      respond: () => ({
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'refresh token expired',
        },
      }),
    });
    const fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-v2-codex-invalid-refresh'),
      testName: 'connected-services-v2-codex-invalid-refresh',
      tokenUrl: fakeTokenServer.tokenUrl,
      accessToken: 'expired-access',
      refreshToken: 'invalid-refresh',
      idToken: 'expired-id',
      expiresAt: Date.now() - 60_000,
    });
    server = fixture.server;
    daemon = fixture.daemon;

    const spawnRes = await spawnConnectedCodexSession(fixture, 'connected-services-invalid-refresh-1');
    expect(spawnRes.status).toBe(500);
    expect(spawnRes.data?.success).toBe(false);
    expect(spawnRes.data?.error).toContain('Connected service credential needs reconnect');
    expect(fakeTokenServer.requests()).toHaveLength(1);

    const profilesHolder: {
      current: Awaited<ReturnType<typeof fetchJson<{ profiles?: unknown[] }>>> | null;
    } = { current: null };
    await waitFor(async () => {
      try {
        profilesHolder.current = await fetchJson<{ profiles?: unknown[] }>(
          `${fixture.serverBaseUrl}/v2/connect/openai-codex/profiles`,
          {
            headers: { Authorization: `Bearer ${fixture.auth.token}` },
            timeoutMs: 20_000,
          },
        );
        return profilesHolder.current.status === 200;
      } catch {
        return false;
      }
    }, { timeoutMs: 30_000 });
    const profiles = profilesHolder.current;
    if (!profiles) throw new Error('failed to fetch connected service profiles');
    expect(profiles.status).toBe(200);
    expect(profiles.data?.profiles).toEqual([
      expect.objectContaining({
        profileId: 'work',
        status: 'needs_reauth',
        health: expect.objectContaining({
          reconnectRequired: true,
          lastRefreshFailureKind: 'invalid_grant',
          providerHttpStatus: 400,
        }),
      }),
    ]);
    expect(JSON.stringify(profiles.data)).not.toContain('invalid-refresh');
  }, 240_000);

  it('force-refreshes once and rematerializes after a runtime credential failure', async () => {
    fakeTokenServer = await startFakeTokenServer({
      respond: () => ({
        status: 200,
        body: {
          access_token: 'runtime-fresh-access',
          refresh_token: 'runtime-rotated-refresh',
          id_token: 'runtime-fresh-id',
          expires_in: 3600,
        },
      }),
    });
    const fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-v2-codex-runtime-auth-refresh'),
      testName: 'connected-services-v2-codex-runtime-auth-refresh',
      tokenUrl: fakeTokenServer.tokenUrl,
      accessToken: 'runtime-stale-access',
      refreshToken: 'runtime-refresh',
      idToken: 'runtime-stale-id',
      expiresAt: Date.now() + 3_600_000,
    });
    server = fixture.server;
    daemon = fixture.daemon;

    const spawnRes = await spawnConnectedCodexSession(fixture, 'connected-services-runtime-auth-refresh-1');
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    expect(fakeTokenServer.requests()).toHaveLength(0);

    const authFailureRes = await daemonControlPostJson<{
      ok?: boolean;
      result?: { status?: string; restartRequested?: boolean };
    }>({
      port: fixture.daemonPort,
      path: '/connected-service-runtime-auth/failure',
      body: {
        sessionId: spawnRes.data.sessionId,
        switchesThisTurn: 0,
        classification: {
          kind: 'auth_expired',
          limitCategory: 'auth',
          serviceId: 'openai-codex',
          profileId: 'work',
          groupId: null,
          resetsAtMs: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
      },
      controlToken: fixture.controlToken,
      timeoutMs: 60_000,
    });
    expect(authFailureRes.status).toBe(200);
    expect(authFailureRes.data).toMatchObject({
      ok: true,
      result: { status: 'credential_refreshed', restartRequested: true },
    });
    const refreshRequests = fakeTokenServer.requests();
    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]?.body).toContain('refresh_token=runtime-refresh');

    const authPath = codexAuthPath(fixture);
    await waitFor(async () => {
      const parsed = parseCodexAuthJson(await readFile(authPath, 'utf8'));
      return parsed.access_token === 'runtime-fresh-access';
    }, { timeoutMs: 30_000 });

    const materialized = parseCodexAuthJson(await readFile(authPath, 'utf8'));
    expect(materialized).toMatchObject({
      access_token: 'runtime-fresh-access',
      refresh_token: 'runtime-rotated-refresh',
      id_token: 'runtime-fresh-id',
    });
    expect(JSON.stringify(materialized)).not.toContain('runtime-stale-access');
  }, 240_000);
});
