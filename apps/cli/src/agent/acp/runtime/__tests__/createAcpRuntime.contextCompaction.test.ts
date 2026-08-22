import { describe, expect, it } from 'vitest';

import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';

import { createAcpRuntime } from '../createAcpRuntime';

describe('createAcpRuntime (context compaction)', () => {
  it('normalizes context-compaction provider events into canonical Agent Session runtime events', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const session = {
      sessionId: 'test-session-id',
      keepAlive: () => {},
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
      enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: false }),
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    const runtimeEvents: AgentSessionRuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });
    await runtime.sendTurnPrompt('session setup');

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'failed',
        lifecycleId: 'pi:context-compaction',
        provider: 'pi',
        trigger: 'overflow',
        source: 'agent-event',
        tokensBefore: 1200,
        tokenCountAfter: 700,
        retryAttempt: 1.8,
        errorCode: 'context_limit',
        sanitizedErrorPreview: 'safe provider preview',
      },
    });

    const compaction = runtimeEvents.find((event) => (
      event.kind === 'context-compaction' && event.phase === 'failed'
    ));
    expect(compaction).toEqual(expect.objectContaining({
      kind: 'context-compaction',
      sessionId: 'test-session-id',
      phase: 'failed',
      compactionId: 'pi:context-compaction',
      trigger: 'overflow',
      retryAttempt: 1,
      diagnostic: {
        code: 'context_limit',
        severity: 'error',
        message: 'safe provider preview',
      },
    }));
    expect(compaction).not.toHaveProperty('tokenCountBefore');
    expect(compaction).not.toHaveProperty('tokenCountAfter');
  });

  it('does not treat raw compaction error text as a canonical diagnostic message', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const session = {
      sessionId: 'test-session-id',
      keepAlive: () => {},
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
      enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: false }),
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents: AgentSessionRuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'failed',
        lifecycleId: 'pi:context-compaction',
        provider: 'pi',
        source: 'agent-event',
        errorCode: 'context_limit',
        errorMessage: 'raw provider failure details',
      },
    });

    const compaction = runtimeEvents.find((event) => (
      event.kind === 'context-compaction' && event.phase === 'failed'
    ));
    expect(compaction).toEqual(expect.objectContaining({
      compactionId: 'pi:context-compaction',
      diagnostic: {
        code: 'context_limit',
        severity: 'error',
      },
    }));
    expect(compaction?.diagnostic).not.toHaveProperty('message');
    expect(JSON.stringify(compaction)).not.toContain('raw provider failure details');
  });

  it('preserves paused continuation metadata on context-compaction events', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const session = {
      sessionId: 'test-session-id',
      keepAlive: () => {},
      enqueueAgentMessageCommitted: async () => ({ persisted: true, delivered: false }),
      enqueueUserTextMessageCommitted: async () => ({ persisted: true, delivered: false }),
      fetchRecentTranscriptTextItemsForAcpImport: async () => [],
      updateMetadata: () => {},
    };

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    const runtimeEvents: AgentSessionRuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(AgentSessionRuntimeEventV1Schema.parse(message));
    });

    await runtime.sendTurnPrompt('session setup');

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'completed',
        lifecycleId: 'pi:context-compaction',
        provider: 'pi',
        trigger: 'automatic',
        source: 'agent-event',
        continuation: 'paused',
        pauseReason: 'agent-idle-after-compaction',
      },
    });

    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'context-compaction',
      phase: 'completed',
      compactionId: 'pi:context-compaction',
      trigger: 'automatic',
      continuation: 'paused',
      pauseReason: 'agentIdleAfterCompaction',
    }));
  });
});
