import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../crypto/base64.js';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  isPlainMachineDataKeyMarker,
  machineStoredContentMatchesAccountMode,
  machineUpdateMatchesStoredMode,
} from './machineStoredContent.js';

function encodeJson(value: unknown): string {
  return encodeBase64(
    new TextEncoder().encode(JSON.stringify(value)),
    'base64',
  );
}

describe('machineStoredContent', () => {
  it('preserves the existing plain marker and round-trips strict plain content', () => {
    const value = { host: 'machine-a', nested: { ready: true } };

    expect(MACHINE_PLAIN_DATA_KEY_MARKER).toBe(
      encodeJson({ t: 'plain', v: null }),
    );
    expect(isPlainMachineDataKeyMarker(MACHINE_PLAIN_DATA_KEY_MARKER)).toBe(true);
    expect(isPlainMachineDataKeyMarker(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
    )).toBe(true);
    expect(decodePlainMachineStoredContent(
      encodePlainMachineStoredContent(value),
    )).toEqual(value);
  });

  it('normalizes optional undefined object fields to their JSON wire representation', () => {
    const encoded = encodePlainMachineStoredContent({
      status: 'running',
      serviceLabel: undefined,
      nested: {
        present: true,
        absent: undefined,
      },
    });

    expect(decodePlainMachineStoredContent(encoded)).toEqual({
      status: 'running',
      nested: {
        present: true,
      },
    });
  });

  it('rejects malformed, non-plain, and non-strict Machine envelopes', () => {
    const invalidValues = [
      'not-base64',
      encodeJson({ t: 'encrypted', c: 'ciphertext' }),
      encodeJson({ t: 'plain' }),
      encodeJson({ t: 'plain', v: null, extra: true }),
    ];

    for (const value of invalidValues) {
      expect(() => decodePlainMachineStoredContent(value)).toThrow(
        'Invalid plaintext machine content',
      );
    }
    expect(isPlainMachineDataKeyMarker(encodeJson({ t: 'plain', v: 'not-null' }))).toBe(false);
    expect(isPlainMachineDataKeyMarker(encodeJson({ t: 'plain', v: null, extra: true }))).toBe(false);
    expect(() => encodePlainMachineStoredContent(undefined)).toThrow(
      'Invalid plaintext machine content',
    );
  });

  it('enforces account-mode/content agreement without classifying encrypted bytes', () => {
    const plainMetadata = encodePlainMachineStoredContent({ host: 'machine-a' });
    const encryptedEnvelope = encodeJson({ t: 'encrypted', c: 'ciphertext' });

    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain',
      metadata: plainMetadata,
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(true);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain',
      metadata: 'opaque-ciphertext',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain',
      metadata: encryptedEnvelope,
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee',
      metadata: 'opaque-ciphertext',
      dataEncryptionKey: 'opaque-wrapped-key',
    })).toBe(true);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee',
      metadata: plainMetadata,
      dataEncryptionKey: 'opaque-wrapped-key',
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee',
      metadata: 'opaque-ciphertext',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
  });

  it('uses the persisted Machine marker as update authority, including database bytes', () => {
    const plainMarkerBytes = new TextEncoder().encode(
      JSON.stringify({ t: 'plain', v: null }),
    );
    const plainState = encodePlainMachineStoredContent({ status: 'running' });

    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: plainMarkerBytes,
      daemonState: plainState,
    })).toBe(true);
    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: plainMarkerBytes,
      daemonState: 'opaque-ciphertext',
    })).toBe(false);
    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: new Uint8Array([1, 2, 3]),
      daemonState: 'opaque-ciphertext',
    })).toBe(true);
    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: new Uint8Array([1, 2, 3]),
      daemonState: plainState,
    })).toBe(false);
  });
});
