import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol';
import { validateConnectedServiceGroupMutationCurrentness } from './validateGroupMutationCurrentness';

describe('validateConnectedServiceGroupMutationCurrentness', () => {
  afterEach(() => vi.restoreAllMocks());

  it('compares a qualified service credential revision rather than treating refresh metadata as supersession', async () => {
    const service = { pluginId: 'example.connected-accounts', localId: 'subscription' };
    const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    let revision = credentialRevision;
    let configurationRevision: string | null = null;
    let reads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential');
      reads += 1;
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service, accountId: 'member' }, authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision,
        metadata: { scopes: [] }, content: { t: 'plain', v: { v: 1, values: { accessToken: 'fixture-token' } } },
      }) };
    });
    const input = { serviceId: 'example.connected-accounts/subscription', groupId: 'pool',
      profileId: 'member', generation: 3, credentialRevision };
    const validate = () => validateConnectedServiceGroupMutationCurrentness({ input,
      credentials: { token: 'fixture-token', encryption: null }, api: { getAccountEncryptionMode: async () => 'plain' },
      // Group reads are a server boundary; the revision/currentness logic is real.
      readGroup: async () => ({ activeConnectedAccountId: 'member', generation: 3 }),
    });
    await expect(validate()).resolves.toEqual({ current: true });
    configurationRevision = 'csc_aaaaaaaaaaaaaaaaaaaaaa';
    await expect(validate()).resolves.toEqual({ current: true });
    revision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    await expect(validate()).resolves.toMatchObject({ current: false, reason: 'credential_revision_superseded' });
    expect(reads).toBe(3);
  });
});
