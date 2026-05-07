import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { waitFor } from '../../src/testkit/timing';
import {
  createPlainTranscriptStreamSegmentMessage,
  findTranscriptStreamSegmentEvent,
} from '../../src/testkit/transcriptStreamSegmentEvents';

const run = createRunDirs({ runLabel: 'core' });

type CreatePlainSessionResponse = {
  session?: {
    id?: string;
    encryptionMode?: string;
  };
};

type MessagesResponse = {
  messages?: Array<{ localId?: string | null; content?: unknown }>;
};

async function createPlainSession(params: { baseUrl: string; token: string }): Promise<string> {
  const response = await fetchJson<CreatePlainSessionResponse>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag: `e2e-transcript-stream-segment-plain-${randomUUID()}`,
      metadata: JSON.stringify({ v: 1, kind: 'transcript-stream-segment-plain' }),
      agentState: null,
      dataEncryptionKey: null,
    }),
    timeoutMs: 15_000,
  });

  const sessionId = response.data?.session?.id;
  if (response.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create plaintext session (status=${response.status})`);
  }
  expect(response.data?.session?.encryptionMode).toBe('plain');
  return sessionId;
}

async function fetchPlainMessages(params: { baseUrl: string; token: string; sessionId: string }): Promise<MessagesResponse['messages']> {
  const response = await fetchJson<MessagesResponse>(`${params.baseUrl}/v1/sessions/${params.sessionId}/messages?limit=10`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 15_000,
  });
  if (response.status !== 200 || !Array.isArray(response.data?.messages)) {
    throw new Error(`Failed to fetch plaintext messages (status=${response.status})`);
  }
  return response.data.messages;
}

describe('core e2e: plaintext transcript stream segment ephemeral updates', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rebroadcasts plain stream segment envelopes without durable persistence', async () => {
    const testDir = run.testDir('messages-socket-transcript-stream-segment-plain');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const sessionId = await createPlainSession({ baseUrl: server.baseUrl, token: auth.token });

    const { socket: sender } = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });
    const userObserver = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'messages-socket-transcript-stream-segment-plain',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('sender.events.json', () => sender.getEvents());
    artifacts.json('user-observer.events.json', () => userObserver.getEvents());
    artifacts.json('transcript.json', async () => await fetchPlainMessages({ baseUrl: server!.baseUrl, token: auth.token, sessionId }));

    let passed = false;
    try {
      sender.connect();
      userObserver.connect();
      await waitFor(
        () => sender.isConnected() && userObserver.isConnected(),
        { timeoutMs: 25_000, context: 'plaintext transcript stream segment sockets connected' },
      );

      const localId = randomUUID();
      const value = {
        role: 'assistant',
        content: { type: 'text', text: 'plain live stream segment' },
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: localId,
            segmentState: 'streaming',
            updatedAtMs: Date.now(),
          },
        },
      };
      const message = createPlainTranscriptStreamSegmentMessage({ localId, value });

      sender.emit('transcript-stream-segment', {
        sid: sessionId,
        message,
      });

      await waitFor(
        () => findTranscriptStreamSegmentEvent(userObserver.getEvents(), { sessionId, localId }) !== null,
        { timeoutMs: 20_000, context: 'plaintext stream segment observer received event' },
      );

      const event = findTranscriptStreamSegmentEvent(userObserver.getEvents(), { sessionId, localId });
      expect(event?.message.content).toEqual(message.content);
      expect(findTranscriptStreamSegmentEvent(sender.getEvents(), { sessionId, localId })).toBeNull();

      const persistedMessages = await fetchPlainMessages({ baseUrl: server.baseUrl, token: auth.token, sessionId });
      expect(persistedMessages?.some((persistedMessage) => persistedMessage.localId === localId)).toBe(false);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      sender.close();
      userObserver.close();
    }
  });
});
