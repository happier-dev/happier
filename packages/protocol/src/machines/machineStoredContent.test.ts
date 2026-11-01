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

describe('plain Machine stored content', () => {
  it('preserves the full JSON document using the 0.3 typed envelope', () => {
    const metadata = { displayName: 'Développement 🦋', host: 'dev', extension: { retained: [1, null, true] } };
    const encoded = encodePlainMachineStoredContent(metadata);
    expect(decodePlainMachineStoredContent(encoded)).toEqual(metadata);
    expect(encoded).toBe(encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: metadata }))));
    expect(isPlainMachineDataKeyMarker(MACHINE_PLAIN_DATA_KEY_MARKER)).toBe(true);
    expect(isPlainMachineDataKeyMarker(new TextEncoder().encode('{"t":"plain","v":null}'))).toBe(true);
  });

  it('requires a plain marker and typed fields together, without guessing from JSON', () => {
    const metadata = encodePlainMachineStoredContent({ host: 'dev' });
    const daemonState = encodePlainMachineStoredContent({ status: 'running' });
    expect(machineStoredContentMatchesAccountMode({ mode: 'plain', metadata, daemonState, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER })).toBe(true);
    expect(machineStoredContentMatchesAccountMode({ mode: 'plain', metadata, daemonState, dataEncryptionKey: null })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({ mode: 'plain', metadata: 'ciphertext', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({ mode: 'e2ee', metadata, dataEncryptionKey: 'encrypted-key' })).toBe(false);
    const untyped = encodeBase64(new TextEncoder().encode('{"host":"dev"}'));
    expect(() => decodePlainMachineStoredContent(untyped)).toThrow();
    expect(isPlainMachineDataKeyMarker(untyped)).toBe(false);
  });

  it('rejects cross-mode socket writes at the stored-row boundary', () => {
    const metadata = encodePlainMachineStoredContent({ host: 'dev' });
    expect(machineUpdateMatchesStoredMode({ dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadata })).toBe(true);
    expect(machineUpdateMatchesStoredMode({ dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, daemonState: 'ciphertext' })).toBe(false);
    expect(machineUpdateMatchesStoredMode({ dataEncryptionKey: 'encrypted-key', metadata })).toBe(false);
    expect(machineUpdateMatchesStoredMode({ dataEncryptionKey: null, metadata: 'legacy-ciphertext' })).toBe(true);
  });
});
