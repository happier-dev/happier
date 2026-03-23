import { describe, expect, it, vi } from 'vitest';
import { handleSessionStateUpdate } from './sessionStateUpdateHandling';

describe('handleSessionStateUpdate', () => {
  it('parses plaintext metadata updates when sessionEncryptionMode=plain', () => {
    const onWarning = vi.fn();
    const onMetadataUpdated = vi.fn();

    const result = handleSessionStateUpdate({
      update: {
        id: 'u1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          sid: 's1',
          metadata: {
            version: 1,
            value: JSON.stringify({ path: '/tmp', host: 'h1', flavor: 'claude' }),
          },
        },
      } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'plain',
      metadata: null,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
      onMetadataUpdated,
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(result.metadata?.path).toBe('/tmp');
    expect(onMetadataUpdated).toHaveBeenCalledTimes(1);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('ignores user-scoped update-machine broadcasts without warning', () => {
    const onWarning = vi.fn();

    const result = handleSessionStateUpdate({
      update: { id: 'u1', seq: 1, createdAt: Date.now(), body: { t: 'update-machine', machineId: 'm1' } } as any,
      updateSource: 'user-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
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
      sessionEncryptionMode: 'e2ee',
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

  it('does not advance metadataVersion when an encrypted metadata update cannot be decrypted', () => {
    const onWarning = vi.fn();
    const onMetadataUpdated = vi.fn();
    const previousMetadata = { path: '/tmp/original', host: 'h1', flavor: 'claude' } as any;

    const result = handleSessionStateUpdate({
      update: {
        id: 'u1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          sid: 's1',
          metadata: {
            version: 5,
            value: 'not-valid-base64-ciphertext',
          },
        },
      } as any,
      updateSource: 'session-scoped',
      sessionId: 's1',
      sessionEncryptionMode: 'e2ee',
      metadata: previousMetadata,
      metadataVersion: 4,
      agentState: null,
      agentStateVersion: 0,
      pendingWakeSeq: 0,
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      onMetadataUpdated,
      onWarning,
    });

    expect(result.handled).toBe(true);
    expect(result.metadata).toBe(previousMetadata);
    expect(result.metadataVersion).toBe(4);
    expect(onMetadataUpdated).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
  });
});
