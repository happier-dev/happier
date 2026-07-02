import { describe, expect, it } from 'vitest';

import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';

import { createAcpRuntime } from '../createAcpRuntime';

describe('createAcpRuntime (context compaction)', () => {
  it('normalizes context-compaction provider events into canonical ACP session messages', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const session = {
      sessionId: 'test-session-id',
      keepAlive: () => {},
      sendAgentMessage: (_provider: string, body: ACPMessageData) => {
        sent.push(body);
      },
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
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

    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((message) => {
      runtimeEvents.push(RuntimeEventV1Schema.parse(message));
    });
    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'failed',
        lifecycleId: 'pi:context-compaction',
        provider: 'pi',
        trigger: 'overflow',
        source: 'provider-event',
        tokensBefore: 1200,
        tokenCountAfter: 700,
        retryAttempt: 1.8,
        errorCode: 'context_limit',
        sanitizedErrorPreview: 'safe provider preview',
      },
    });

    expect(sent).toContainEqual({
      type: 'context-compaction',
      phase: 'failed',
      lifecycleId: 'pi:context-compaction',
      backendId: 'pi',
      trigger: 'overflow',
      source: 'provider-event',
      tokenCountBefore: 1200,
      tokenCountAfter: 700,
      retryAttempt: 1,
      errorCode: 'context_limit',
      sanitizedErrorPreview: 'safe provider preview',
    });
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      kind: 'context-compaction',
      sessionId: 'test-session-id',
      phase: 'failed',
      lifecycleId: 'pi:context-compaction',
      backendId: 'pi',
      trigger: 'overflow',
      source: 'provider-event',
      tokenCountBefore: 1200,
      tokenCountAfter: 700,
      retryAttempt: 1,
      errorCode: 'context_limit',
      sanitizedErrorPreview: 'safe provider preview',
    }));
  });

  it('does not treat raw compaction error text as a sanitized preview', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const session = {
      sessionId: 'test-session-id',
      keepAlive: () => {},
      sendAgentMessage: (_provider: string, body: ACPMessageData) => {
        sent.push(body);
      },
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
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

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'failed',
        provider: 'pi',
        source: 'provider-event',
        errorCode: 'context_limit',
        errorMessage: 'raw provider failure details',
      },
    });

    expect(sent).toContainEqual({
      type: 'context-compaction',
      phase: 'failed',
      backendId: 'pi',
      source: 'provider-event',
      errorCode: 'context_limit',
    });
    expect(sent).not.toContainEqual(expect.objectContaining({
      sanitizedErrorPreview: 'raw provider failure details',
    }));
  });

  it('preserves paused continuation metadata on context-compaction events', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: ACPMessageData[] = [];
    const session = {
      sessionId: 'test-session-id',
      keepAlive: () => {},
      sendAgentMessage: (_provider: string, body: ACPMessageData) => {
        sent.push(body);
      },
      sendAgentMessageCommitted: async () => {},
      sendUserTextMessageCommitted: async () => {},
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

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({
      type: 'event',
      name: 'context_compaction',
      payload: {
        type: 'context-compaction',
        phase: 'completed',
        lifecycleId: 'pi:context-compaction',
        provider: 'pi',
        trigger: 'threshold',
        source: 'provider-event',
        continuation: 'paused',
        pauseReason: 'provider-idle-after-compaction',
      },
    });

    expect(sent).toContainEqual({
      type: 'context-compaction',
      phase: 'completed',
      lifecycleId: 'pi:context-compaction',
      backendId: 'pi',
      trigger: 'threshold',
      source: 'provider-event',
      continuation: 'paused',
      pauseReason: 'provider-idle-after-compaction',
    });
  });
});
