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
  it('reads Plain under persisted Account mode when this computer keeps its keys only as history', () => {
    expect(resolvePublishedMachineEncryptionContext({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) }, accountE2eeCustody: 'historical' },
      machineId: 'plain', expectedAccountMode: 'plain', publishedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toEqual({ encryptionMode: 'plain' });
  });

  it('refuses a Home-reported Plain own Machine while this computer holds active Account keys', () => {
    // Own rows carry the Account mode, so the row's plain passes the same admission as the Account reader.
    const token = `h.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.s`;
    const credentials = { token, encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const own = { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' };
    for (const access of [undefined, own]) {
      expect(() => resolvePublishedMachineEncryptionContext({
        credentials, machineId: 'own', expectedAccountMode: 'plain', access, publishedDataEncryptionKey: null,
      })).toThrow(expect.objectContaining({ code: 'account_mode_downgrade_unverified' }));
    }
    // A foreign custodian's resource mode is that custodian's, not this Account's.
    expect(resolvePublishedMachineEncryptionContext({
      credentials, machineId: 'shared', expectedAccountMode: 'e2ee', publishedDataEncryptionKey: null,
      access: { ...own, custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' },
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
