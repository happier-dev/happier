import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { SessionTranscriptObservationV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol';

import { createSessionMutationJournal } from '@/api/session/mutations/createSessionMutationOutbox';
import { parseQueuedSessionMutation, resolveSessionMutationJournalPaths } from '@/api/session/mutations/sessionMutationPersistence';
import { createTranscriptMessageAppendMutation } from '@/api/session/mutations/sessionMutationTypes';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('createAcpRuntime transcript custody', () => {
  it.each([
    { origin: 'provider', output: 'answer' },
    { origin: 'host', output: 'answer' },
    { origin: 'adopted', output: 'answer' },
    { origin: 'provider', output: 'media' },
    { origin: 'provider', output: 'user' },
  ] as const)(
    'retains never-delivered $origin/$output output ahead of the next canonical turn',
    async ({ origin, output }) => {
      const directory = await mkdtemp(join(tmpdir(), 'acp-transcript-custody-'));
      const sessionId = 'custody-session';
      const paths = resolveSessionMutationJournalPaths({ activeServerDir: directory, sessionId, custody: 'runtime' });
      let transportRecovered = false;
      const delivered: string[] = [];
      const forwardedTools: string[] = [];
      const socket = createApiSessionSocketStub({
        connected: true,
        emitWithAck: (event, payload) => {
          if (event === 'transcript-observation-capability-v1') {
            return { ok: true, capability: 'session-transcript-observation-v1' };
          }
          if (event === 'transcript-observation-v1') {
            const observation = SessionTranscriptObservationV1Schema.parse(payload);
            if (!transportRecovered) return { ok: false, error: 'internal' };
            delivered.push('predecessor-answer');
            return {
              ok: true, status: 'observed', id: observation.localId, seq: delivered.length,
              localId: observation.localId, didWrite: true, ingestedAt: Date.now(),
            };
          }
          if (event === 'session-turn-mutation') {
            const mutation = SessionTurnMutationV1Schema.parse(payload);
            delivered.push(mutation.action);
            return { ok: true };
          }
          throw new Error(`Unexpected session transport event: ${event}`);
        },
      });
      const journal = createSessionMutationJournal({
        token: 'test-token', sessionId, custody: 'runtime', paths,
        admission: parseQueuedSessionMutation, getSocket: () => socket, requestReconnect: () => {},
      });
      const lifecycle = createSessionTurnLifecycle({ sessionId, enqueueSessionTurn: journal.enqueueSessionTurn });
      const backend = createFakeAcpRuntimeBackend();
      const enqueueObservedAgent: NonNullable<StreamedTranscriptWriterSession['enqueueAgentMessageCommitted']> =
        async (provider, body, opts) => journal.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
          sessionId, localId: opts.localId, provenance: opts.provenance, messageRole: 'agent',
          content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', provider, data: body }, meta: opts.meta } },
        }));
      // The session boundary feeds the real journal and lifecycle. Only remote publication is
      // unavailable; no runtime, writer, journal, or lifecycle orchestration is mocked.
      const session = {
        ...createBasicSessionClientWithOverrides({
          sessionTurnLifecycle: lifecycle,
          sendAgentMessage: (provider, body) => {
            void lifecycle.observeAcpLifecycleMarker({ provider, body }).pendingWrite;
            if (body.type === 'tool-call' || body.type === 'tool-result') forwardedTools.push(body.callId);
          },
        }),
        enqueueAgentMessageCommitted: enqueueObservedAgent,
        sendAgentMessageCommitted: (async (provider, body, opts) => {
          if (opts.provenance) {
            await enqueueObservedAgent(provider, body, { ...opts, provenance: opts.provenance });
            return;
          }
          if (!transportRecovered) throw new Error('Transcript transport unavailable before first admission');
          if (body.type === 'message') delivered.push('predecessor-answer');
        }) satisfies NonNullable<StreamedTranscriptWriterSession['sendAgentMessageCommitted']>,
        sendUserTextMessageCommitted: (async (text, opts) => {
          if (opts.provenance) {
            await journal.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
              sessionId, localId: opts.localId, provenance: opts.provenance, messageRole: 'user',
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: opts.meta } },
            }));
            return;
          }
          if (!transportRecovered) throw new Error('Transcript transport unavailable before first admission');
          delivered.push('predecessor-answer');
        }) satisfies ApiSessionClient['sendUserTextMessageCommitted'],
      };
      const runtime = createAcpRuntime({
        provider: 'pi', directory, session, messageBuffer: new MessageBuffer(), mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
        sessionMedia: { persist: async () => ({ media: [], unavailable: [{
          id: 'unavailable-output', role: 'output', category: 'generated', mediaKind: 'image',
          code: 'source_not_supported', origin: { source: 'acp-content' },
        }] }) },
      });
      try {
        await journal.awaitReady();
        await runtime.startOrLoad({});
        if (output === 'user') backend.emit({ type: 'user-message', text: 'provider prompt' });
        if (origin === 'host') runtime.beginTurn();
        backend.emit({ type: 'status', status: 'running' });
        if (origin === 'adopted') runtime.beginTurn();
        if (output === 'answer') {
          backend.emit({ type: 'model-output', fullText: 'never admitted', fullTextScope: 'segment' });
        } else if (output === 'media') {
          backend.emit({ type: 'session-media', source: 'acp-content', media: [{
            kind: 'base64', data: 'iVBORw0KGgo=', mimeType: 'image/png',
            origin: { source: 'acp-content', providerEventId: 'output-media', contentIndex: 0 },
            dedupeKey: 'acp-content:output-media:0',
          }] });
        }
        await runtime.flushTurn().catch(() => {});

        backend.emit({ type: 'status', status: 'running' });
        backend.emit({ type: 'tool-call', toolName: 'Read', callId: 'next-read', args: { path: 'README.md' } });
        backend.emit({ type: 'tool-result', toolName: 'Read', callId: 'next-read', result: 'read completed' });
        await expect.poll(() => forwardedTools).toEqual(['next-read', 'next-read']);
        expect(delivered).not.toContain('predecessor-answer');

        transportRecovered = true;
        backend.emit({ type: 'tool-call', toolName: 'Read', callId: 'recovery-read', args: { path: 'README.md' } });
        await expect.poll(() => forwardedTools.includes('recovery-read')).toBe(true);
        await journal.flush('flush');
        const answerIndex = delivered.indexOf('predecessor-answer');
        const nextBeginIndex = delivered.flatMap((event, index) => event === 'begin' ? [index] : [])[1] ?? -1;
        expect(answerIndex).toBeGreaterThan(-1);
        expect(nextBeginIndex).toBeGreaterThan(-1);
        expect(answerIndex).toBeLessThan(nextBeginIndex);
      } finally {
        await journal.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
