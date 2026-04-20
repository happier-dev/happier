import { describe, expect, it, vi } from 'vitest';

import { createClaudeRemoteQueuedPromptCoordinator } from '../runtime/remote/createQueuedPromptCoordinator';
import type { EnhancedMode } from '../runtime/claudeEnhancedMode';

const defaultMode = { permissionMode: 'default' } satisfies EnhancedMode;

function createSessionClientStub(): {
  getMetadataSnapshot: () => unknown;
  updateMetadata: ReturnType<typeof vi.fn>;
} {
  return {
    getMetadataSnapshot: () => ({}),
    updateMetadata: vi.fn(),
  };
}

describe('createClaudeRemoteQueuedPromptCoordinator', () => {
  it('increments the work version when a prompt is handed to Claude', async () => {
    const coordinator = createClaudeRemoteQueuedPromptCoordinator({
      sessionClient: createSessionClientStub(),
      waitForNextBatch: vi.fn(async () => ({
        message: 'hello',
        mode: defaultMode,
        isolate: false,
        hash: 'default',
      })),
      onModeChange: vi.fn(),
    });

    expect(coordinator.getWorkVersion()).toBe(0);

    await coordinator.nextMessage();

    expect(coordinator.getWorkVersion()).toBe(1);
  });
});
