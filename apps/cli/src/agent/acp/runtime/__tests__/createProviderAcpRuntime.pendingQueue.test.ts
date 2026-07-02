import { describe, expect, it, vi } from 'vitest';

import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCatalogProviderAcpRuntime } from '../createProviderAcpRuntime';

describe('createCatalogProviderAcpRuntime pending queue wiring', () => {
  it('drains through safe pending materialization instead of direct legacy pop', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const popPendingMessage = vi.fn(async () => {
      throw new Error('legacy popPendingMessage should not be called by provider ACP runtime');
    });
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
        materializeNextPendingMessageSafely,
        popPendingMessage,
      },
    });
    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' }),
    });

    await runtime.startOrLoad({});

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(popPendingMessage).not.toHaveBeenCalled();

    await runtime.reset();
  });

  it('does not drain catalog ACP pending messages before continuation recovery is terminal', async () => {
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'local-1',
      seq: 1,
      content: null,
    }));
    const popPendingMessage = vi.fn(async () => true);
    const reconcilePendingQueueState = vi.fn(async () => false);
    const session = createMutableApiSessionClientFixture({
      metadata: createTestMetadata({
        sessionContinuationRecoveryV1: {
          v: 1,
          attemptsById: {
            'generation-1:restart-1': {
              v: 1,
              attemptId: 'generation-1:restart-1',
              status: 'pending_provider_context',
              failureAtMs: 100,
              updatedAtMs: 110,
              resumePromptMode: 'standard',
            },
          },
        },
      }),
      overrides: {
        sessionId: 'happy-session-1',
        materializeNextPendingMessageSafely,
        popPendingMessage,
        shouldAttemptPendingMaterialization: () => true,
        reconcilePendingQueueState,
      },
    });
    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' }),
    });

    await runtime.startOrLoad({});

    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();

    await runtime.reset();
  });

  it('falls back to legacy pending pop when safe materialization is unavailable', async () => {
    const popPendingMessage = vi.fn(async () => false);
    const session = createMutableApiSessionClientFixture({
      overrides: {
        sessionId: 'happy-session-1',
        popPendingMessage,
      },
    });
    const runtime = createCatalogProviderAcpRuntime({
      provider: 'opencode',
      loggerLabel: 'OpenCodeACP',
      directory: '/tmp/project',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      createBackend: async () => createFakeAcpRuntimeBackend({ sessionId: 'opencode-session-1' }),
    });

    await runtime.startOrLoad({});

    expect(popPendingMessage).toHaveBeenCalledTimes(1);

    await runtime.reset();
  });
});
