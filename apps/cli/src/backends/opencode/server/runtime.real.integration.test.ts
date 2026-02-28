/**
 * Opt-in real OpenCode server integration tests.
 *
 * These tests start or reuse a managed `opencode serve` process and make real network calls.
 *
 * Enable with:
 *   HAPPIER_CLI_OPENCODE_SERVER_INTEGRATION=1
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';
import type { OpenCodeGlobalEvent } from './types';

function isOpenCodeInstalled(): boolean {
  const res = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

function shouldRunOpenCodeServerIntegration(): boolean {
  return process.env.HAPPIER_CLI_OPENCODE_SERVER_INTEGRATION === '1' && isOpenCodeInstalled();
}

function shouldRunOpenCodeServerLlmIntegration(): boolean {
  return shouldRunOpenCodeServerIntegration() && process.env.HAPPIER_CLI_OPENCODE_SERVER_LLM_INTEGRATION === '1';
}

function resolveTestModelFromEnv(): { providerID: string; modelID: string } | null {
  const raw = typeof process.env.HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL === 'string'
    ? process.env.HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL.trim()
    : '';
  const modelId = raw || 'opencode/gpt-5-nano';
  const idx = modelId.indexOf('/');
  if (idx <= 0 || idx === modelId.length - 1) return null;
  return { providerID: modelId.slice(0, idx), modelID: modelId.slice(idx + 1) };
}

async function waitForSessionIdle(params: Readonly<{
  observedEvents: readonly OpenCodeGlobalEvent[];
  sessionId: string;
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for OpenCode session to become idle: ${params.sessionId}`);
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
      const model = resolveTestModelFromEnv();
      if (!model) throw new Error('invalid HAPPIER_CLI_OPENCODE_SERVER_LLM_MODEL');

      const client = await createOpenCodeServerRuntimeClient({
        directory: process.cwd(),
        messageBuffer: new MessageBuffer(),
      });

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

      await waitForSessionIdle({ observedEvents: observed, sessionId });

      const messages = await client.sessionMessagesList({ sessionId });
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
});
