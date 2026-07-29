import { describe, expect, it, vi } from 'vitest';

import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPrompt,
} from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';

import { createCatalogProviderAcpRuntime } from '../createProviderAcpRuntime';
import { createCatalogProviderSessionIdentityRuntime } from '../createProviderSessionIdentityRuntime';

type PendingRow = Readonly<{ localId: string; text: string }>;
type PromptLoopOptions = Parameters<typeof runPermissionModePromptLoop>[0];
type PromptLoopQueue = PromptLoopOptions['messageQueue'];
type PromptLoopMode = Parameters<PromptLoopQueue['push']>[1];
type SharedPermissionHandler = Parameters<typeof createCatalogProviderAcpRuntime>[0]['permissionHandler']
  & PromptLoopOptions['permissionHandler'];

function createPermissionModeQueue(): PromptLoopQueue {
  return new MessageQueue2<PromptLoopMode, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

describe('createCatalogProviderAcpRuntime pending queue wiring', () => {
  it('does not materialize pending input from the nested ACP runtime', async () => {
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

    await runtime.sendTurnPrompt('session setup');

    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();

    await runtime.reset();
  });

  it('does not fall back to legacy pending pop when safe materialization is unavailable', async () => {
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

    await runtime.sendTurnPrompt('session setup');

    expect(popPendingMessage).not.toHaveBeenCalled();

    await runtime.reset();
  });
});
