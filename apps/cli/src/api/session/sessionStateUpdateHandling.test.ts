import { describe, expect, it, vi } from 'vitest';
import { handleSessionStateUpdate } from './sessionStateUpdateHandling';

describe('handleSessionStateUpdate', () => {
  it('ignores user-scoped update-machine broadcasts without warning', () => {
    const onWarning = vi.fn();

    const result = handleSessionStateUpdate({
      update: { id: 'u1', seq: 1, createdAt: Date.now(), body: { t: 'update-machine', machineId: 'm1' } } as any,
      updateSource: 'user-scoped',
      sessionId: 's1',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated: () => {},
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('warns when session-scoped socket receives update-machine', () => {
    const onWarning = vi.fn();

    const result = handleSessionStateUpdate({
      update: { id: 'u1', seq: 1, createdAt: Date.now(), body: { t: 'update-machine', machineId: 'm1' } } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(),
      encryptionVariant: 'dataKey',
      onMetadataUpdated: () => {},
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });
});

