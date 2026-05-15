import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { connectExternalMcp, parseToolJson } from '../../src/testkit/externalMcp';
import { fetchJson } from '../../src/testkit/http';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

type SessionTranscriptGetResponse = Readonly<{
  ok?: boolean;
  items?: readonly Readonly<{
    role?: unknown;
    kind?: unknown;
    text?: unknown;
  }>[];
  diagnostics?: unknown;
}>;

type SessionEventsGetResponse = Readonly<{
  ok?: boolean;
  items?: readonly Readonly<{
    kind?: unknown;
    semanticRole?: unknown;
    storedMessageRole?: unknown;
    raw?: unknown;
    rawTruncated?: unknown;
  }>[];
  diagnostics?: Readonly<{
    payloadTruncations?: unknown;
  }>;
}>;

async function createPlainSession(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<string> {
  const patchMode = await fetchJson<{ mode?: unknown }>(`${params.baseUrl}/v1/account/encryption`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'plain' }),
    timeoutMs: 15_000,
  });
  expect(patchMode.status).toBe(200);
  expect(patchMode.data?.mode).toBe('plain');

  const create = await fetchJson<{ session?: { id?: unknown; encryptionMode?: unknown } }>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag: `e2e-session-transcript-actions-${randomUUID()}`,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ v: 1, path: '/tmp', flavor: 'codex', tag: 'e2e-session-transcript-actions' }),
      agentState: null,
      dataEncryptionKey: null,
    }),
    timeoutMs: 15_000,
  });
  expect(create.status).toBe(200);
  expect(create.data?.session?.encryptionMode).toBe('plain');

  const sessionId = create.data?.session?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('create session response did not include a session id');
  }
  return sessionId;
}

async function postPlainTranscriptRow(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  localId: string;
  messageRole: 'user' | 'agent' | 'event';
  value: unknown;
}>): Promise<void> {
  const write = await fetchJson<{ didWrite?: unknown }>(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.localId,
    },
    body: JSON.stringify({
      localId: params.localId,
      messageRole: params.messageRole,
      content: { t: 'plain', v: params.value },
    }),
    timeoutMs: 15_000,
  });
  expect(write.status).toBe(200);
  expect(write.data?.didWrite).toBe(true);
}

async function seedRealisticPlainTranscript(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<void> {
  const largeToolOutput = 'tool-output:'.repeat(1200);
  const rows: readonly Readonly<{
    localId: string;
    messageRole: 'user' | 'agent' | 'event';
    value: unknown;
  }>[] = [
    {
      localId: 'transcript-actions-user-1',
      messageRole: 'user',
      value: { role: 'user', content: { type: 'text', text: 'please inspect the repository' } },
    },
    {
      localId: 'transcript-actions-tool-call-1',
      messageRole: 'event',
      value: {
        role: 'agent',
        content: {
          type: 'codex',
          data: { type: 'tool-call', id: 'tool-1', callId: 'call-1', name: 'CodexBash', input: { command: 'pwd' } },
        },
      },
    },
    {
      localId: 'transcript-actions-tool-result-1',
      messageRole: 'event',
      value: {
        role: 'agent',
        content: {
          type: 'codex',
          data: { type: 'tool-call-result', id: 'tool-result-1', callId: 'call-1', output: largeToolOutput },
        },
      },
    },
    {
      localId: 'transcript-actions-token-count-1',
      messageRole: 'event',
      value: {
        role: 'agent',
        content: { type: 'codex', data: { type: 'token_count', input_tokens: 12, output_tokens: 34, total_tokens: 46 } },
      },
    },
    {
      localId: 'transcript-actions-lifecycle-1',
      messageRole: 'event',
      value: {
        role: 'agent',
        content: { type: 'acp', provider: 'codex', data: { type: 'task_started', id: 'turn-1' } },
      },
    },
    {
      localId: 'transcript-actions-empty-stream-1',
      messageRole: 'event',
      value: { role: 'agent', content: { type: 'acp', provider: 'codex', data: { type: 'message', message: '' } } },
    },
    {
      localId: 'transcript-actions-assistant-1',
      messageRole: 'agent',
      value: {
        role: 'agent',
        content: { type: 'acp', provider: 'codex', data: { type: 'message', message: 'I inspected the repository.' } },
      },
    },
  ];

  for (const row of rows) {
    await postPlainTranscriptRow({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      localId: row.localId,
      messageRole: row.messageRole,
      value: row.value,
    });
  }
}

function itemTexts(response: Readonly<{ items?: readonly Readonly<{ text?: unknown }>[] }>): string[] {
  return (response.items ?? [])
    .map((item) => item.text)
    .filter((text): text is string => typeof text === 'string');
}

describe('core e2e: session transcript/events action role stamping', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('separates semantic transcript messages from diagnostic event rows', async () => {
    const testDir = run.testDir(`session-transcript-actions-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const sessionId = await createPlainSession({ baseUrl: server.baseUrl, token: auth.token });
    await seedRealisticPlainTranscript({ baseUrl: server.baseUrl, token: auth.token, sessionId });

    const cliHome = resolve(join(testDir, 'cli-home'));
    await mkdir(cliHome, { recursive: true });
    await seedCliAuthForServer({
      cliHome,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret: Uint8Array.from(randomBytes(32)),
    });
    const cliEntrypoint = await ensureCliDistBuilt(
      { testDir, env: process.env },
      { lockPath: resolve(testDir, 'cli-dist-build.lock') },
    );

    const { client, transport, stderrLines } = await connectExternalMcp({
      cliEntrypoint,
      sessionId,
      cliHome,
      serverBaseUrl: server.baseUrl,
    });

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'session_transcript_get',
        'session_events_get',
      ]));

      const transcript = parseToolJson<SessionTranscriptGetResponse>(await client.callTool({
        name: 'session_transcript_get',
        arguments: { sessionId, limit: 10 },
      }));
      expect(transcript.ok).toBe(true);
      expect(transcript.items).toEqual([
        expect.objectContaining({ role: 'user', text: 'please inspect the repository' }),
        expect.objectContaining({ role: 'assistant', text: 'I inspected the repository.' }),
      ]);
      expect(itemTexts(transcript).every((text) => text.trim().length > 0)).toBe(true);
      expect(itemTexts(transcript).join('\n')).not.toContain('tool-output:');

      const userOnly = parseToolJson<SessionTranscriptGetResponse>(await client.callTool({
        name: 'session_transcript_get',
        arguments: { sessionId, roles: ['user'], limit: 10 },
      }));
      expect(userOnly.ok).toBe(true);
      expect(userOnly.items?.map((item) => item.role)).toEqual(['user']);

      const assistantOnly = parseToolJson<SessionTranscriptGetResponse>(await client.callTool({
        name: 'session_transcript_get',
        arguments: { sessionId, roles: ['assistant'], limit: 10 },
      }));
      expect(assistantOnly.ok).toBe(true);
      expect(assistantOnly.items?.map((item) => item.role)).toEqual(['assistant']);

      const events = parseToolJson<SessionEventsGetResponse>(await client.callTool({
        name: 'session_events_get',
        arguments: { sessionId, limit: 10, includeMeta: true },
      }));
      expect(events.ok).toBe(true);
      expect(events.items?.map((item) => item.kind)).toEqual(expect.arrayContaining([
        'tool_call',
        'tool_result',
        'usage',
        'task_started',
      ]));
      expect(events.items?.every((item) => item.storedMessageRole === 'event')).toBe(true);

      const rawEvents = parseToolJson<SessionEventsGetResponse>(await client.callTool({
        name: 'session_events_get',
        arguments: { sessionId, limit: 10, includeRaw: true, maxPayloadChars: 256 },
      }));
      expect(rawEvents.ok).toBe(true);
      expect(rawEvents.items?.some((item) => item.raw !== undefined)).toBe(true);
      expect(rawEvents.items?.some((item) => item.rawTruncated === true)).toBe(true);
      expect(rawEvents.diagnostics?.payloadTruncations).toEqual(expect.any(Number));
    } catch (error) {
      throw Object.assign(
        new Error(`external mcp transcript action e2e failed (stderr follows)\n\n${stderrLines.join('')}`),
        { cause: error },
      );
    } finally {
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 240_000);
});
