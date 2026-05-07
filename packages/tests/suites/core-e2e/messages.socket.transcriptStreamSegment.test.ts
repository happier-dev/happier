import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';
import { createSessionScopedSocketCollector, createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { waitFor } from '../../src/testkit/timing';
import {
  countTranscriptStreamSegmentEvents,
  createEncryptedTranscriptStreamSegmentMessage,
  findTranscriptStreamSegmentEvent,
  hasRawTranscriptStreamSegmentEvent,
} from '../../src/testkit/transcriptStreamSegmentEvents';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: socket transcript stream segment ephemeral updates', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('rebroadcasts valid stream segments to interested clients without persisting or echoing to the sender', async () => {
    const testDir = run.testDir('messages-socket-transcript-stream-segment');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const { socket: sender } = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });
    const sessionObserver = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);
    const userObserver = createUserScopedSocketCollector(server.baseUrl, auth.token);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'messages-socket-transcript-stream-segment',
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('sender.events.json', () => sender.getEvents());
    artifacts.json('session-observer.events.json', () => sessionObserver.getEvents());
    artifacts.json('user-observer.events.json', () => userObserver.getEvents());
    artifacts.json('transcript.json', async () => await fetchAllMessages(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      sender.connect();
      sessionObserver.connect();
      userObserver.connect();
      await waitFor(
        () => sender.isConnected() && sessionObserver.isConnected() && userObserver.isConnected(),
        { timeoutMs: 25_000, context: 'transcript stream segment sockets connected' },
      );

      const invalidLocalId = randomUUID();
      sender.emit('transcript-stream-segment', {
        sid: sessionId,
        message: {
          localId: invalidLocalId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      const validLocalId = randomUUID();
      const validMessage = createEncryptedTranscriptStreamSegmentMessage({
        localId: validLocalId,
        ciphertextBase64: Buffer.from('stream segment ciphertext', 'utf8').toString('base64'),
      });

      sender.emit('transcript-stream-segment', {
        sid: sessionId,
        message: validMessage,
      });

      await waitFor(
        () => findTranscriptStreamSegmentEvent(userObserver.getEvents(), { sessionId, localId: validLocalId }) !== null,
        { timeoutMs: 20_000, context: 'user-scoped observer received transcript stream segment' },
      );
      await waitFor(
        () => findTranscriptStreamSegmentEvent(sessionObserver.getEvents(), { sessionId, localId: validLocalId }) !== null,
        { timeoutMs: 20_000, context: 'session-scoped observer received transcript stream segment' },
      );

      const userEvent = findTranscriptStreamSegmentEvent(userObserver.getEvents(), { sessionId, localId: validLocalId });
      expect(userEvent?.message.content).toEqual(validMessage.content);
      expect(userEvent?.message.createdAt).toBe(validMessage.createdAt);
      expect(userEvent?.message.updatedAt).toBe(validMessage.updatedAt);

      expect(countTranscriptStreamSegmentEvents(userObserver.getEvents(), { sessionId, localId: validLocalId })).toBe(1);
      expect(countTranscriptStreamSegmentEvents(sessionObserver.getEvents(), { sessionId, localId: validLocalId })).toBe(1);
      expect(findTranscriptStreamSegmentEvent(sender.getEvents(), { sessionId, localId: validLocalId })).toBeNull();
      expect(hasRawTranscriptStreamSegmentEvent(userObserver.getEvents(), { sessionId, localId: invalidLocalId })).toBe(false);
      expect(hasRawTranscriptStreamSegmentEvent(sessionObserver.getEvents(), { sessionId, localId: invalidLocalId })).toBe(false);

      const persistedMessages = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
      expect(persistedMessages.some((message) => message.localId === validLocalId)).toBe(false);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      sender.close();
      sessionObserver.close();
      userObserver.close();
    }
  });
});
