import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { fetchJson } from '../../src/testkit/http';
import { createMachineScopedSocketCollector, createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { waitFor } from '../../src/testkit/timing';
import {
  createDirectSessionTranscriptDeltaPayload,
  findDirectSessionTranscriptDeltaEvent,
  hasRawDirectSessionTranscriptDeltaEvent,
} from '../../src/testkit/directSessionTranscriptDeltaEvents';

const run = createRunDirs({ runLabel: 'core' });

async function registerMachine(params: {
  baseUrl: string;
  token: string;
  machineId: string;
}): Promise<void> {
  const response = await fetchJson<{ machine?: { id?: string } }>(`${params.baseUrl}/v1/machines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: params.machineId,
      metadata: 'e2e-machine-metadata',
    }),
    timeoutMs: 15_000,
  });

  if (response.status !== 200) {
    throw new Error(`Failed to create machine (${response.status})`);
  }
}

describe('core e2e: direct-session transcript delta socket updates', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rebroadcasts only valid machine live transcript deltas to interested clients', async () => {
    const testDir = run.testDir('direct-session-socket-live-transcript-delta');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const machineId = randomUUID();
    await registerMachine({ baseUrl: server.baseUrl, token: auth.token, machineId });

    const machineSender = createMachineScopedSocketCollector(server.baseUrl, auth.token, machineId);
    const userObserver = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'direct-session-socket-live-transcript-delta',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('machine-sender.events.json', () => machineSender.getEvents());
    artifacts.json('user-observer.events.json', () => userObserver.getEvents());

    let passed = false;
    try {
      machineSender.connect();
      userObserver.connect();
      await waitFor(
        () => machineSender.isConnected() && userObserver.isConnected(),
        { timeoutMs: 25_000, context: 'direct-session transcript delta sockets connected' },
      );

      const invalidItemId = randomUUID();
      machineSender.emit('direct-session-transcript-delta', {
        type: 'direct-session-transcript-delta',
        sessionId,
        items: [
          {
            id: invalidItemId,
            raw: { provider: 'e2e' },
          },
        ],
        truncated: false,
      });

      const itemId = randomUUID();
      const localId = randomUUID();
      const payload = createDirectSessionTranscriptDeltaPayload({
        sessionId,
        itemId,
        localId,
        nextCursor: `cursor-${randomUUID()}`,
      });

      machineSender.emit('direct-session-transcript-delta', payload);

      await waitFor(
        () => findDirectSessionTranscriptDeltaEvent(userObserver.getEvents(), { sessionId, itemId }) !== null,
        { timeoutMs: 20_000, context: 'user-scoped observer received direct-session transcript delta' },
      );

      const event = findDirectSessionTranscriptDeltaEvent(userObserver.getEvents(), { sessionId, itemId });
      expect(event?.items).toEqual(payload.items);
      expect(event?.nextCursor).toBe(payload.nextCursor);
      expect(event?.truncated).toBe(false);

      expect(findDirectSessionTranscriptDeltaEvent(machineSender.getEvents(), { sessionId, itemId })).toBeNull();
      expect(hasRawDirectSessionTranscriptDeltaEvent(userObserver.getEvents(), { sessionId, itemId: invalidItemId })).toBe(false);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      machineSender.close();
      userObserver.close();
    }
  });
});
