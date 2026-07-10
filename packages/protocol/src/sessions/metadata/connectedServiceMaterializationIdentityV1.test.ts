import { describe, expect, it } from 'vitest';
import * as protocol from '../../index.js';

describe('connectedServiceMaterializationIdentityV1 metadata', () => {
  it('parses and round-trips a stable connected-service materialization identity', () => {
    const identity = {
      v: 1,
      id: 'csm_session_123',
      createdAt: 123,
      source: 'first_spawn',
    };

    expect(typeof (protocol as any).ConnectedServiceMaterializationIdentityV1Schema).toBe('object');
    expect(typeof (protocol as any).writeConnectedServiceMaterializationIdentityV1ToMetadata).toBe('function');
    expect(typeof (protocol as any).readConnectedServiceMaterializationIdentityV1FromMetadata).toBe('function');

    const parsed = (protocol as any).ConnectedServiceMaterializationIdentityV1Schema.parse(identity);
    expect(parsed).toMatchObject(identity);

    const metadata = (protocol as any).writeConnectedServiceMaterializationIdentityV1ToMetadata(
      { path: '/tmp/repo' },
      identity,
    );
    expect((protocol as any).readConnectedServiceMaterializationIdentityV1FromMetadata(metadata)).toEqual(identity);
  });

  it('reads remote-dev persisted identities that still use createdAtMs', () => {
    const remoteDevIdentity = {
      v: 1,
      id: 'csm_remote_dev_123',
      createdAtMs: 456,
    };
    const expectedIdentity = {
      v: 1,
      id: 'csm_remote_dev_123',
      createdAt: 456,
    };

    expect((protocol as any).ConnectedServiceMaterializationIdentityV1Schema.parse(remoteDevIdentity)).toEqual(
      expectedIdentity,
    );
    expect((protocol as any).readConnectedServiceMaterializationIdentityV1FromMetadata({
      connectedServiceMaterializationIdentityV1: remoteDevIdentity,
    })).toEqual(expectedIdentity);
  });
});
