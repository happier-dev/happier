import { describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { resolvePublishedMachineEncryptionContext } from './machineDataEncryptionKey';
import { createMachineContentCodec } from './machineStoredContent';
import { decodeBase64 } from '../encryption';
import predecessor from './machineLegacyContent.predecessor.fixture.json';

describe('published Machine mode authority', () => {
  it.each(predecessor.rows)('opens actual predecessor $credentialKind metadata and state', fixture => {
    const secret = decodeBase64(fixture.accountSecret);
    const context = resolvePublishedMachineEncryptionContext({
      credentials: { token: 'synthetic', encryption: fixture.credentialKind === 'legacy'
        ? { type: 'legacy', secret }
        : { type: 'dataKey', machineKey: secret, publicKey: decodeBase64(fixture.accountPublicKey!) } },
      machineId: fixture.machine.id, expectedAccountMode: 'e2ee',
      publishedDataEncryptionKey: fixture.machine.dataEncryptionKey,
    });
    const codec = createMachineContentCodec(context);
    expect(codec.decodeStored(fixture.machine.metadata)).toEqual(predecessor.openedMetadata);
    expect(codec.decodeStored(fixture.machine.daemonState)).toEqual(predecessor.openedDaemonState);
  });
  it('reads Plain under persisted Account mode even if retained credentials contain keys', () => {
    expect(resolvePublishedMachineEncryptionContext({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      machineId: 'plain', expectedAccountMode: 'plain', publishedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toEqual({ encryptionMode: 'plain' });
  });

  it('refuses E2EE without material and refuses malformed-present envelopes without legacy fallback', () => {
    for (const publishedDataEncryptionKey of [null, MACHINE_PLAIN_DATA_KEY_MARKER, 'malformed']) {
      expect(() => resolvePublishedMachineEncryptionContext({
        credentials: { token: 't', encryption: null }, machineId: 'locked', expectedAccountMode: 'e2ee',
        publishedDataEncryptionKey,
      })).toThrow(expect.objectContaining({ code: 'machine_content_key_unavailable' }));
    }
    expect(() => resolvePublishedMachineEncryptionContext({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      machineId: 'locked', expectedAccountMode: 'e2ee', publishedDataEncryptionKey: 'malformed',
    })).toThrow(expect.objectContaining({ code: 'machine_content_key_unavailable' }));
  });
});
