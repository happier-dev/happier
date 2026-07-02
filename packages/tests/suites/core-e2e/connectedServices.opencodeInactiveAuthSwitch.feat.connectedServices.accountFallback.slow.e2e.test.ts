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

const run = createRunDirs({ runLabel: 'core' });

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

async function createStoppedOpenCodeSession(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<string> {
  const metadata = {
    v: 1,
    name: 'Stopped OpenCode connected-service auth switch e2e',
    path: params.fixture.workspaceDir,
    flavor: 'opencode',
    opencodeSessionId: `opencode-stopped-${randomUUID()}`,
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
        tag: `opencode-inactive-auth-switch-${run.runId}`,
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
    throw new Error(`Failed to create stopped OpenCode session (status=${response.status})`);
  }
  return sessionId;
}

describe('core e2e: stopped OpenCode connected-service auth switch', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
  }, 60_000);

  it('updates a stopped OpenCode session on a reachable daemon without routing through provider state sharing', async () => {
    const serviceId = 'openai-codex' satisfies ConnectedServiceId;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
        status: 200,
        body: {
          access_token: 'opencode-inactive-access',
          refresh_token: 'opencode-inactive-refresh',
          id_token: 'opencode-inactive-id',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    });

    fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-opencode-inactive-auth-switch'),
      testName: 'connected-services-opencode-inactive-auth-switch',
      tokenUrl: tokenServer.tokenUrl,
      accessToken: 'opencode-inactive-initial',
      refreshToken: 'opencode-inactive-refresh-initial',
      idToken: 'opencode-inactive-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
    });

    await createConnectedServiceProfile({
      fixture,
      serviceId,
      profileId: 'backup',
      providerEmail: 'backup@example.test',
    });
    const sessionId = await createStoppedOpenCodeSession({
      fixture,
      serviceId,
      profileId: 'work',
    });

    const ping = await daemonControlPostJson({
      port: fixture.daemonPort,
      path: '/ping',
      controlToken: fixture.controlToken,
      body: {},
      timeoutMs: 20_000,
    });
    expect(ping.status).toBe(200);

    const switchResult = await daemonControlPostJson<{
      ok?: boolean;
      result?: unknown;
    }>({
      port: fixture.daemonPort,
      path: '/connected-service-auth/session/switch',
      controlToken: fixture.controlToken,
      body: {
        sessionId,
        agentId: 'opencode',
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
