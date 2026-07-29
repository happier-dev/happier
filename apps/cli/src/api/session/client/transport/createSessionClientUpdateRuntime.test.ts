import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../../../types';
import { createSessionClientUpdateRuntime } from './createSessionClientUpdateRuntime';

function createRuntime(overrides: Partial<Parameters<typeof createSessionClientUpdateRuntime>[0]> = {}) {
  return createSessionClientUpdateRuntime({
    sessionId: 'session-1',
    sessionEncryptionMode: 'plain',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy',
    getMetadata: () => null,
    setMetadata: vi.fn(),
    getMetadataVersion: () => 0,
    setMetadataVersion: vi.fn(),
    getAgentState: () => null,
    setAgentState: vi.fn(),
    getAgentStateVersion: () => 0,
    setAgentStateVersion: vi.fn(),
    applyPendingQueueState: vi.fn(() => false),
    emit: vi.fn(),
    markAgentQueueEchoSuppressedLocalId: vi.fn(),
    initialLastObservedMessageSeq: 0,
    ...overrides,
  });
}

describe('createSessionClientUpdateRuntime', () => {
  it('forwards transcript rows as observations without a provider-input consumer dependency', () => {
    const emit = vi.fn();
    const runtime = createRuntime({ emit });
    const update = {
      id: 'update-1', seq: 1, createdAt: 1_000,
      body: {
        t: 'new-message', sid: 'session-1',
        message: {
          id: 'message-1', seq: 4, localId: 'local-1', createdAt: 1_000, updatedAt: 1_000,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'observe me' } } },
        },
      },
    } as Update;

    runtime.handleUpdate(update, { source: 'session-scoped' });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(runtime.getLastObservedUserMessageSeq()).toBe(4);
  });

  it('uses the accepted canonical Pending state for drain notification', () => {
    const canonical = { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 5 } as const;
    const onPendingChangedDrainTrigger = vi.fn();
    const runtime = createRuntime({
      getPendingQueueState: () => canonical,
      onPendingChangedDrainTrigger,
    });

    runtime.handleUpdate({
      id: 'pending-change', seq: 1, createdAt: 1_000,
      body: { t: 'pending-changed', sid: 'session-1', pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
    } as Update, { source: 'user-scoped' });

    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith(canonical);
  });
});
