import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { type ConnectedServiceId } from '@happier-dev/protocol';

import {
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type FakeTokenServerRequest,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { createConnectedServiceProfile } from '../../src/testkit/connectedServicesRecovery';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core', logsDir: process.env.HAPPIER_E2E_LOGS_DIR });

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readPlainSessionMetadata(raw: string): UnknownRecord {
  const metadata = asRecord(JSON.parse(raw) as unknown);
  if (!metadata) throw new Error('Expected plain session metadata object');
  return metadata;
}

async function createStoppedGeminiSession(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<string> {
  const metadata = {
    v: 1,
    name: 'Stopped Gemini connected-service auth switch e2e',
    path: params.fixture.workspaceDir,
    flavor: 'gemini',
    geminiSessionId: `gemini-stopped-${randomUUID()}`,
    connectedServices: {
      v: 1,
      bindingsByServiceId: {
        [params.serviceId]: {
          source: 'connected',
          selection: 'profile',
          profileId: params.profileId,
        },
      },
    },
  };

  const response = await fetchJson<{ session?: { id?: unknown } }>(
    `${params.fixture.serverBaseUrl}/v1/sessions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: `gemini-continuity-restart-${run.runId}`,
        metadata: JSON.stringify(metadata),
        agentState: null,
        dataEncryptionKey: null,
        encryptionMode: 'plain',
      }),
      timeoutMs: 20_000,
    },
  );
  const sessionId = response.data?.session?.id;
  if (response.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create stopped Gemini session (status=${response.status})`);
  }
  return sessionId;
}

describe('core e2e: stopped Gemini connected-service restart continuity', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
  }, 60_000);

  it('updates a stopped Gemini session by selecting restart rematerialization instead of provider state sharing', async () => {
    const serviceId = 'gemini' satisfies ConnectedServiceId;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
        status: 200,
        body: {
          access_token: 'gemini-continuity-access',
          refresh_token: 'gemini-continuity-refresh',
          id_token: 'gemini-continuity-id',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    });

    fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-gemini-continuity-restart'),
      testName: 'connected-services-gemini-continuity-restart',
      tokenUrl: tokenServer.tokenUrl,
      accessToken: 'gemini-continuity-initial',
      refreshToken: 'gemini-continuity-refresh-initial',
      idToken: 'gemini-continuity-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
    });

    await createConnectedServiceProfile({
      fixture,
      serviceId,
      profileId: 'work',
      providerEmail: 'gemini-work@example.test',
    });
    await createConnectedServiceProfile({
      fixture,
      serviceId,
      profileId: 'backup',
      providerEmail: 'gemini-backup@example.test',
    });
    const sessionId = await createStoppedGeminiSession({
      fixture,
      serviceId,
      profileId: 'work',
    });

    const switchResult = await daemonControlPostJson<{
      ok?: boolean;
      result?: unknown;
    }>({
      port: fixture.daemonPort,
      path: '/connected-service-auth/session/switch',
      controlToken: fixture.controlToken,
      body: {
        sessionId,
        agentId: 'gemini',
        expectedGroupGenerationByServiceId: {},
        bindings: {
          v: 1,
          bindingsByServiceId: {
            [serviceId]: {
              source: 'connected',
              selection: 'profile',
              profileId: 'backup',
            },
          },
        },
      },
      timeoutMs: 90_000,
    });

    expect(switchResult.status).toBe(200);
    expect(switchResult.data.ok).toBe(true);
    const result = asRecord(switchResult.data.result);
    expect(JSON.stringify(result)).not.toContain('provider_state_sharing_unavailable');
    expect(JSON.stringify(result)).not.toContain('restart_shared_state_required');
    expect(result).toMatchObject({
      ok: true,
      action: 'metadata_updated',
      continuityByServiceId: {
        [serviceId]: 'restart_rematerialize',
      },
    });

    const updated = await fetchSessionV2(fixture.serverBaseUrl, fixture.auth.token, sessionId);
    const metadata = readPlainSessionMetadata(updated.metadata);
    expect(metadata.connectedServices).toMatchObject({
      v: 1,
      bindingsByServiceId: {
        [serviceId]: {
          source: 'connected',
          selection: 'profile',
          profileId: 'backup',
        },
      },
    });
  }, 360_000);
});
