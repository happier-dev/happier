import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchAllMessages } from '../../src/testkit/sessions';
import {
  enqueueSessionPromptForScenario,
  waitForAssistantMessageContaining,
  waitForSessionActive,
} from '../../src/testkit/providers/scenarios/sessionRuntime';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type QueuedMutationRecord = {
  kind?: unknown;
  mutationId?: unknown;
  payload?: unknown;
};

type OutboxFile = {
  mutations: QueuedMutationRecord[];
};

async function waitForFakeCodexTurnStart(requestLogPath: string): Promise<void> {
  await waitFor(async () => {
    const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
    return requests.some((entry) => entry.method === 'turn/start');
  }, {
    timeoutMs: 45_000,
    intervalMs: 250,
    context: 'fake Codex app-server turn/start request',
  });
}

async function readSessionMutationOutboxFiles(params: {
  cliHome: string;
  sessionId: string;
}): Promise<OutboxFile[]> {
  const serversDir = join(params.cliHome, 'servers');
  const serverDirs = await readdir(serversDir, { withFileTypes: true }).catch(() => []);
  const files: OutboxFile[] = [];
  for (const serverDir of serverDirs) {
    if (!serverDir.isDirectory()) continue;
    const outboxPath = join(
      serversDir,
      serverDir.name,
      'session-mutations',
      `session-${params.sessionId}.json`,
    );
    const raw = await readFile(outboxPath, 'utf8').catch(() => null);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as { mutations?: unknown };
    if (!Array.isArray(parsed.mutations)) continue;
    files.push({ mutations: parsed.mutations as QueuedMutationRecord[] });
  }
  return files;
}

async function readQueuedTranscriptAppendMutations(params: {
  cliHome: string;
  sessionId: string;
}): Promise<QueuedMutationRecord[]> {
  const files = await readSessionMutationOutboxFiles(params);
  return files.flatMap((file) =>
    file.mutations.filter((mutation) => mutation.kind === 'transcript_message_append'),
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decryptStoredMessageContent(value: unknown, secret: Uint8Array): unknown | null {
  if (typeof value === 'string') return decryptLegacyBase64Normalized(value, secret);
  const envelope = readRecord(value);
  if (envelope?.t !== 'encrypted' || typeof envelope.c !== 'string') return null;
  return decryptLegacyBase64Normalized(envelope.c, secret);
}

function extractCommittedText(value: unknown): string | null {
  const message = readRecord(value);
  if (!message) return null;
  const role = typeof message.role === 'string' ? message.role : null;
  if (role === 'assistant') {
    const content = message.content;
    if (typeof content === 'string') return content;
    const contentRecord = readRecord(content);
    if (typeof contentRecord?.text === 'string') return contentRecord.text;
  }
  if (role === 'agent') {
    const content = readRecord(message.content);
    const data = readRecord(content?.data);
    if (content?.type === 'acp' && data?.type === 'message' && typeof data.message === 'string') {
      return data.message;
    }
  }
  return null;
}

function extractMutationText(mutation: QueuedMutationRecord, secret: Uint8Array): string | null {
  const payload = readRecord(mutation.payload);
  return extractCommittedText(decryptStoredMessageContent(payload?.content, secret));
}

function isFinalSentinelText(text: string | null, sentinel: string): boolean {
  return typeof text === 'string' && text.includes(sentinel) && text.endsWith(':done');
}

function isPartialOnlySentinelText(text: string | null, sentinel: string): boolean {
  return typeof text === 'string' && text.includes(sentinel) && !text.endsWith(':done');
}

async function readPersistedCommittedTexts(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}): Promise<Array<{ localId: string | null; text: string }>> {
  const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
  return rows.flatMap((row) => {
    const text = extractCommittedText(decryptLegacyBase64Normalized(row.content.c, params.secret));
    return text ? [{ localId: row.localId, text }] : [];
  });
}

describe('core e2e: durable transcript reconnect', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;
  let restartedServer: StartedServer | null = null;

  afterEach(async () => {
    await restartedServer?.stop().catch(() => {});
    restartedServer = null;
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('coalesces disconnected committed transcript snapshots and flushes only the final content after reconnect', async () => {
    const testDir = run.testDir('session-transcript-durable-reconnect');
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'session-transcript-durable-reconnect',
      cliEnvOverrides: {
        HAPPIER_E2E_FAKE_CODEX_APP_SERVER_TURN_DELAY_MS: '1000',
        HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS: '60000',
        HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS: '0',
        HAPPIER_STREAM_CHECKPOINT_MIN_CHARS: '1',
        HAPPIER_STREAM_CHECKPOINT_MS: '0',
        HAPPIER_STREAM_INITIAL_CHECKPOINT_MS: '0',
      },
    });

    const { auth, cliHome, requestLogPath, secret, server, serverBaseUrl, sessionId } = harness;
    await waitForSessionActive({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 30_000 });

    const prompt = `transcript-durable-reconnect-${randomUUID()}`;

    await enqueueSessionPromptForScenario({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: prompt,
      meta: { source: 'session-transcript-durable-reconnect-e2e' },
    });
    await waitForFakeCodexTurnStart(requestLogPath);

    await server.stop();

    await waitFor(async () => {
      const transcriptMutations = await readQueuedTranscriptAppendMutations({ cliHome, sessionId });
      return (
        transcriptMutations.length === 1
        && isFinalSentinelText(extractMutationText(transcriptMutations[0], secret), prompt)
      );
    }, {
      timeoutMs: 45_000,
      intervalMs: 250,
      context: 'coalesced final transcript append queued while server is down',
    });

    const queuedWhileDisconnected = await readQueuedTranscriptAppendMutations({ cliHome, sessionId });
    expect(queuedWhileDisconnected).toHaveLength(1);
    expect(isFinalSentinelText(extractMutationText(queuedWhileDisconnected[0], secret), prompt)).toBe(true);
    expect(queuedWhileDisconnected.some((mutation) => isPartialOnlySentinelText(extractMutationText(mutation, secret), prompt))).toBe(false);

    restartedServer = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      preserveExistingDataDir: true,
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
      __portAllocator: async () => server.port,
    });

    await waitForSessionActive({ baseUrl: serverBaseUrl, token: auth.token, sessionId, timeoutMs: 45_000 });
    await waitForAssistantMessageContaining({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      requiredSubstrings: [prompt, ':done'],
      timeoutMs: 60_000,
    });

    await waitFor(async () => {
      const transcriptMutations = await readQueuedTranscriptAppendMutations({ cliHome, sessionId });
      return transcriptMutations.length === 0;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      context: 'transcript append outbox drained after reconnect',
    });

    const committedTexts = await readPersistedCommittedTexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
    });
    const finalMessages = committedTexts.filter((message) => isFinalSentinelText(message.text, prompt));
    const partialOnlyMessages = committedTexts.filter((message) => isPartialOnlySentinelText(message.text, prompt));
    expect(finalMessages).toHaveLength(1);
    expect(new Set(finalMessages.map((message) => message.localId)).size).toBe(1);
    expect(partialOnlyMessages).toHaveLength(0);
  });
});
