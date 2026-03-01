/**
 * Opt-in real OpenCode server integration tests.
 *
 * These tests start or reuse a managed `opencode serve` process and make real network calls.
 *
 * Enable with:
 *   HAPPIER_CLI_OPENCODE_SERVER_INTEGRATION=1
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';
import type { OpenCodeGlobalEvent } from './types';
import { createOpenCodeServerRuntime } from './runtime';

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePidBestEffort(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

const managedServerStatePath = (() => {
  const existing = typeof process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH === 'string'
    ? process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH.trim()
    : '';
  if (existing) return existing;
  const next = join(tmpdir(), `happier-opencode-managed-${process.pid}-${randomUUID()}.json`);
  process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = next;
  return next;
})();

async function stopManagedServerFromStatePathBestEffort(): Promise<void> {
  const raw = await readFile(managedServerStatePath, 'utf8').catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as any;
      const pid = typeof parsed?.pid === 'number' ? parsed.pid : Number(parsed?.pid);
      if (Number.isFinite(pid) && pid > 0) {
        await terminatePidBestEffort(Math.trunc(pid));
      }
    } catch {
      // ignore
    }
  }
  await rm(managedServerStatePath, { force: true }).catch(() => {});
  await rm(`${managedServerStatePath}.lock`, { force: true }).catch(() => {});
}

function isOpenCodeInstalled(): boolean {
  const res = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

afterAll(async () => {
  await stopManagedServerFromStatePathBestEffort();
});

function shouldRunOpenCodeServerIntegration(): boolean {
  return process.env.HAPPIER_CLI_OPENCODE_SERVER_INTEGRATION === '1' && isOpenCodeInstalled();
}

function shouldRunOpenCodeServerLlmIntegration(): boolean {
  return shouldRunOpenCodeServerIntegration() && process.env.HAPPIER_CLI_OPENCODE_SERVER_LLM_INTEGRATION === '1';
}

function parseModelRef(raw: string): { providerID: string; modelID: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { providerID: trimmed.slice(0, idx), modelID: trimmed.slice(idx + 1) };
}

function resolveTestModelHintFromEnv(): { providerID: string; modelID: string } | null {
  const raw = typeof process.env.HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL === 'string'
    ? process.env.HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL.trim()
    : '';
  if (!raw) return null;
  return parseModelRef(raw);
}

function modelSupportsToolCalls(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  const status = typeof rec.status === 'string' ? rec.status : '';
  if (status && status !== 'active') return false;
  const capabilities = rec.capabilities && typeof rec.capabilities === 'object' && !Array.isArray(rec.capabilities)
    ? (rec.capabilities as Record<string, unknown>)
    : null;
  if (!capabilities || capabilities.toolcall !== true) return false;
  const input = capabilities.input && typeof capabilities.input === 'object' && !Array.isArray(capabilities.input)
    ? (capabilities.input as Record<string, unknown>)
    : null;
  if (input && input.text === false) return false;
  return true;
}

async function resolveAvailableToolCallModel(client: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>>): Promise<{ providerID: string; modelID: string } | null> {
  const hint = resolveTestModelHintFromEnv();
  const providers = await client.providersList().catch(() => []);
  const providerIndex = new Map<string, any>();
  for (const p of providers as any[]) {
    const id = typeof p?.id === 'string' ? p.id : '';
    if (id) providerIndex.set(id, p);
  }

  const hintProvider = hint ? providerIndex.get(hint.providerID) : null;
  if (hint && hintProvider && hintProvider.models && typeof hintProvider.models === 'object') {
    const model = (hintProvider.models as any)[hint.modelID];
    if (modelSupportsToolCalls(model)) return hint;
  }

  const global = await client.globalConfigGet().catch(() => null);
  const globalModelRaw = global && typeof (global as any).model === 'string' ? String((global as any).model) : '';
  const globalRef = globalModelRaw ? parseModelRef(globalModelRaw) : null;
  if (globalRef) {
    const p = providerIndex.get(globalRef.providerID);
    const model = p && p.models && typeof p.models === 'object' ? (p.models as any)[globalRef.modelID] : null;
    if (modelSupportsToolCalls(model)) return globalRef;
  }

  for (const provider of providers as any[]) {
    const providerID = typeof provider?.id === 'string' ? String(provider.id).trim() : '';
    if (!providerID) continue;
    const models = provider?.models && typeof provider.models === 'object' ? (provider.models as Record<string, unknown>) : null;
    if (!models) continue;
    for (const [modelID, model] of Object.entries(models)) {
      if (!modelSupportsToolCalls(model)) continue;
      return { providerID, modelID };
    }
  }

  return null;
}

async function waitForSessionIdle(params: Readonly<{
  observedEvents: readonly OpenCodeGlobalEvent[];
  sessionId: string;
  client?: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>> | null;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const idle = params.observedEvents.some((evt) => {
      const payloadType = (evt as any)?.payload?.type;
      const props = (evt as any)?.payload?.properties;
      const sessionID = props && typeof props === 'object' ? String((props as any).sessionID ?? '') : '';
      if (sessionID !== params.sessionId) return false;
      if (payloadType === 'session.idle') return true;
      if (payloadType === 'session.status') return props?.status?.type === 'idle';
      return false;
    });
    if (idle) return;
    if (params.client) {
      try {
        const statuses = await params.client.sessionStatusList();
        const statusType = statuses && typeof statuses === 'object'
          ? String((statuses as any)?.[params.sessionId]?.type ?? '')
          : '';
        if (statusType === 'idle') return;
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for OpenCode session to become idle: ${params.sessionId}`);
}

function findSessionErrorFromEvents(params: {
  observedEvents: readonly OpenCodeGlobalEvent[];
  sessionId: string;
}): string | null {
  for (const evt of params.observedEvents) {
    const payloadType = (evt as any)?.payload?.type;
    if (payloadType !== 'session.error') continue;
    const props = (evt as any)?.payload?.properties;
    const sessionID = props && typeof props === 'object' ? String((props as any).sessionID ?? '') : '';
    if (sessionID !== params.sessionId) continue;
    const error = (props as any)?.error;
    const message = error && typeof error === 'object' ? String((error as any).message ?? '') : '';
    return message || 'OpenCode session.error';
  }
  return null;
}

async function waitForFinishedAssistantMessage(params: {
  client: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>>;
  sessionId: string;
  observedEvents?: readonly OpenCodeGlobalEvent[];
  timeoutMs?: number;
}): Promise<any[]> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (params.observedEvents) {
      const err = findSessionErrorFromEvents({ observedEvents: params.observedEvents, sessionId: params.sessionId });
      if (err) throw new Error(`OpenCode session error while waiting for assistant output: ${err}`);
    }
    const messages = (await params.client.sessionMessagesList({ sessionId: params.sessionId }).catch(() => [])) as any[];
    const hasFinishedAssistant = messages.some((m) => m?.info?.role === 'assistant' && Boolean(m?.info?.finish));
    if (hasFinishedAssistant) return messages;
    await new Promise((r) => setTimeout(r, 350));
  }
  const messages = (await params.client.sessionMessagesList({ sessionId: params.sessionId }).catch(() => [])) as any[];
  throw new Error(`Timed out waiting for a finished assistant message (sessionId=${params.sessionId}, messages=${messages.length})`);
}

function extractAssistantTextFromOpenCodeMessages(messages: any[]): string {
  const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant');
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const lastText = Array.isArray(lastAssistant?.parts)
    ? lastAssistant.parts
      .map((p: any) => (typeof p?.text === 'string' ? p.text : (typeof p?.content === 'string' ? p.content : '')))
      .join('')
    : '';
  return typeof lastText === 'string' ? lastText : '';
}

async function waitForAssistantText(params: {
  client: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>>;
  sessionId: string;
  predicate: (text: string) => boolean;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const messages = (await params.client.sessionMessagesList({ sessionId: params.sessionId }).catch(() => [])) as any[];
    const text = extractAssistantTextFromOpenCodeMessages(messages);
    if (text && params.predicate(text)) return text;
    await new Promise((r) => setTimeout(r, 350));
  }
  const messages = (await params.client.sessionMessagesList({ sessionId: params.sessionId }).catch(() => [])) as any[];
  const text = extractAssistantTextFromOpenCodeMessages(messages);
  throw new Error(`Timed out waiting for assistant text predicate (sessionId=${params.sessionId}) lastTextPreview=${text.slice(0, 200)}`);
}

function createFakeSession() {
  const meta: Record<string, unknown> = {};
  return {
    keepAlive: () => {},
    sendAgentMessage: () => {},
    sendUserTextMessageCommitted: async () => {},
    sendAgentMessageCommitted: async () => {},
    ensureMetadataSnapshot: async () => ({ ok: true }),
    getMetadataSnapshot: () => meta,
    updateMetadata: async (updater: (prev: any) => any) => {
      const next = updater(meta);
      Object.keys(meta).forEach((k) => delete meta[k]);
      Object.assign(meta, next);
    },
    getLastObservedMessageSeq: () => 0,
  } as any;
}

describe('OpenCode server runtime (real integration)', () => {
  it.skipIf(!shouldRunOpenCodeServerIntegration())(
    'starts a managed server and receives global SSE events (no LLM calls)',
    async () => {
      const client = await createOpenCodeServerRuntimeClient({
        directory: process.cwd(),
        messageBuffer: new MessageBuffer(),
      });

      const controller = new AbortController();
      const observed: OpenCodeGlobalEvent[] = [];
      const onEvent = (evt: OpenCodeGlobalEvent) => {
        observed.push(evt);
        if ((evt as any)?.payload?.type === 'server.connected') {
          controller.abort('done');
        }
      };

      await client.subscribeGlobalEvents({ signal: controller.signal, onEvent });

      const created = await client.sessionCreate();
      expect(typeof created?.id).toBe('string');
      expect(String(created?.id ?? '')).toMatch(/^ses_/);

      const resumed = await client.sessionGet({ sessionId: created.id });
      expect(resumed?.id).toBe(created.id);

      await client.dispose();

      expect(observed.some((e) => (e as any)?.payload?.type === 'server.connected')).toBe(true);
    },
    180_000,
  );

  it.skipIf(!shouldRunOpenCodeServerLlmIntegration())(
    'fork messageID is an exclusive cursor (requires LLM call)',
    async () => {
      const client = await createOpenCodeServerRuntimeClient({
        directory: process.cwd(),
        messageBuffer: new MessageBuffer(),
      });
      const model = await resolveAvailableToolCallModel(client);
      if (!model) {
        throw new Error('No active tool-call-capable model is available in OpenCode. Configure OpenCode (or set HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL).');
      }

      const controller = new AbortController();
      const observed: OpenCodeGlobalEvent[] = [];
      await client.subscribeGlobalEvents({
        signal: controller.signal,
        onEvent: (evt) => {
          observed.push(evt);
        },
      });

      const created = await client.sessionCreate();
      const sessionId = created.id;

      await client.sessionPromptAsync({
        sessionId,
        model,
        parts: [{ type: 'text', text: `fork-semantics ${randomUUID()}` }],
      });
      const messages = await waitForFinishedAssistantMessage({ client, sessionId, observedEvents: observed, timeoutMs: 180_000 });
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const ids = messages
        .map((m) => (m as any)?.info?.id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

      const userId = ids[0]!;
      const assistantId = ids.find((id) => id !== userId) ?? ids[1]!;

      const forkAtUserExclusive = await client.sessionFork({ sessionId, messageId: userId });
      const forkAtUserMessages = await client.sessionMessagesList({ sessionId: forkAtUserExclusive.id });
      expect(forkAtUserMessages.length).toBe(0);

      const forkBeforeAssistant = await client.sessionFork({ sessionId, messageId: assistantId });
      const forkBeforeAssistantMessages = await client.sessionMessagesList({ sessionId: forkBeforeAssistant.id });
      expect(forkBeforeAssistantMessages.length).toBe(1);
      expect((forkBeforeAssistantMessages[0] as any)?.info?.role).toBe('user');

      controller.abort('done');
      await client.dispose();
    },
    360_000,
  );

  it.skipIf(!shouldRunOpenCodeServerLlmIntegration())(
    'forked sessions preserve conversational memory (requires LLM call)',
    async () => {
      const client = await createOpenCodeServerRuntimeClient({
        directory: process.cwd(),
        messageBuffer: new MessageBuffer(),
      });
      const model = await resolveAvailableToolCallModel(client);
      if (!model) {
        throw new Error('No active tool-call-capable model is available in OpenCode. Configure OpenCode (or set HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL).');
      }

      const controller = new AbortController();
      const observed: OpenCodeGlobalEvent[] = [];
      await client.subscribeGlobalEvents({
        signal: controller.signal,
        onEvent: (evt) => observed.push(evt),
      });

      const created = await client.sessionCreate();
      const sessionId = created.id;

      const marker = `fork-memory-${randomUUID()}`;
      await client.sessionPromptAsync({
        sessionId,
        model,
        parts: [{ type: 'text', text: `Remember this exact marker for later: ${marker}\nReply with exactly: ACK` }],
      });
      await waitForFinishedAssistantMessage({ client, sessionId, observedEvents: observed, timeoutMs: 180_000 });

      const forked = await client.sessionFork({ sessionId });
      const forkedId = forked.id;

      await client.sessionPromptAsync({
        sessionId: forkedId,
        model,
        parts: [{
          type: 'text',
          text: 'What is the exact marker you were told to remember earlier? Reply with the marker only (no extra words).',
        }],
      });
      await waitForFinishedAssistantMessage({ client, sessionId: forkedId, observedEvents: observed, timeoutMs: 180_000 });
      const text = await waitForAssistantText({
        client,
        sessionId: forkedId,
        predicate: (value) => value.includes(marker),
        timeoutMs: 90_000,
      });
      expect(text).toContain(marker);

      controller.abort('done');
      await client.dispose();
    },
    360_000,
  );

  it.skipIf(!shouldRunOpenCodeServerLlmIntegration())(
    'surfaces real tool calls/results from the server into Happier agent messages (requires LLM call)',
    async () => {
      const client = await createOpenCodeServerRuntimeClient({
        directory: process.cwd(),
        messageBuffer: new MessageBuffer(),
      });
      const model = await resolveAvailableToolCallModel(client);
      if (!model) {
        throw new Error('No active tool-call-capable model is available in OpenCode. Configure OpenCode (or set HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL).');
      }

      const marker = `opencode-tool-read-${randomUUID()}`;
      const filePath = `/tmp/${marker}.txt`;
      // Use a unique marker so the model must call Read to answer correctly.
      spawnSync('bash', ['-lc', `printf '%s' '${marker}' > '${filePath}'`], { encoding: 'utf8' });

      const session = createFakeSession();
      const sent: any[] = [];
      session.sendAgentMessage = (provider: string, message: any) => {
        sent.push([provider, message]);
      };

      const runtime = createOpenCodeServerRuntime({
        directory: process.cwd(),
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: async () => ({ decision: 'approved' }) } as any,
        onThinkingChange: () => {},
        getPermissionMode: () => 'default',
      }, {
        createClient: async () => client as any,
      });

      await runtime.startOrLoad({});
      await runtime.setSessionModel(`${model.providerID}/${model.modelID}`);
      runtime.beginTurn();

      const prompt = [
        `Read the file at: ${filePath}`,
        `Reply with the file contents only (no extra words).`,
        `If you cannot access the file, explain why.`,
      ].join('\n');

      try {
        await (runtime as any).sendPromptWithMeta({ text: prompt, localId: `local-${marker}` });

        const deadlineMs = Date.now() + 180_000;
        while (Date.now() < deadlineMs) {
          const toolCall = sent.find((c) => c?.[1]?.type === 'tool-call');
          const toolResult = sent.find((c) => c?.[1]?.type === 'tool-result');
          if (toolCall && toolResult) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        const toolCalls = sent.filter((c) => c?.[1]?.type === 'tool-call').map((c) => c?.[1]);
        const toolResults = sent.filter((c) => c?.[1]?.type === 'tool-result').map((c) => c?.[1]);
        expect(toolCalls.length).toBeGreaterThan(0);
        expect(toolResults.length).toBeGreaterThan(0);
      } finally {
        await runtime.reset().catch(() => {});
        await client.dispose().catch(() => {});
      }
    },
    360_000,
  );
});
