import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectPrivateLabelForRecipientV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

import { createCliPrivateLabelActionOpener, openCliMachinePoolPrivateViews, openCliMachinePoolPrivateView, openCliPrivateLabel, prepareCliPrivateLabel } from './privateLabels';

const binding = { entity: 'account_api_token', field: 'label', id: 'token-1' } as const;
const accountId = 'account-1';
const accountKey = new Uint8Array(32).fill(8);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(accountKey).publicKey;
const accountRecipientCensusPath = '/v1/account/private-labels/recipient-census';

afterEach(() => vi.unstubAllGlobals());

describe('CLI private label Account boundary', () => {
  it('seals to the server-selected recipient and opens only the bound field', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({
        contentEncryptionMode: 'e2ee',
        recipients: [{
          account: { kind: 'account', accountId, firstName: null, lastName: null, username: null, avatarUrl: null },
          readiness: { status: 'available', contentPublicKey: encodeBase64(publicKey),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey) },
          envelopeStatus: 'missing',
        }],
      });
    });
    const label = await prepareCliPrivateLabel({
      endpoint: 'https://home.example', token: 'signed-in-token', accountId, binding, value: 'Production deploy',
      accountMode: 'e2ee', recipientCensusPath: accountRecipientCensusPath,
    });
    expect(requests).toEqual([{ url: 'https://home.example/v1/account/private-labels/recipient-census',
      body: { owner: { kind: 'account', accountId } } }]);
    expect(JSON.stringify(label)).not.toContain('Production deploy');
    const read = projectPrivateLabelForRecipientV1({ stored: label, recipientAccountId: accountId });
    expect(openCliPrivateLabel({ label: read, binding, accountKey,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBe('Production deploy');
    const actionOpen = createCliPrivateLabelActionOpener({ type: 'dataKey', machineKey: accountKey,
      publicKey });
    await expect(actionOpen({ binding, label: read, readPolicy: { kind: 'team-resource' } }, { surface: 'cli' }))
      .resolves.toBe('Production deploy');
    // Retiring the opener's independent key copy must not corrupt retained Account credentials.
    expect(accountKey).toEqual(new Uint8Array(32).fill(8));
    await expect(actionOpen({ binding: { ...binding, id: 'wrong-resource' }, label: read,
      readPolicy: { kind: 'team-resource' } }, { surface: 'cli' })).resolves.toBeNull();
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(actionOpen({ binding, label: read, readPolicy: { kind: 'team-resource' } }, { signal }))
      .rejects.toThrow('cancelled');

    expect(openCliPrivateLabel({ label: read, binding: { ...binding, id: 'different-token' }, accountKey,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBeNull();
    expect(openCliPrivateLabel({ label: read, binding,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBeNull();
  });

  it('forwards the owner-established policy: stale Account Plain is unavailable while Team Plain remains readable', () => {
    const plain = { content: { t: 'plain' as const, v: 'Team builders' }, recipientEnvelope: null };

    expect(openCliPrivateLabel({ label: plain, binding,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBeNull();
    expect(openCliPrivateLabel({ label: plain, binding, readPolicy: { kind: 'team-resource' } })).toBe('Team builders');
    expect(openCliPrivateLabel({ label: { ...plain, legacyPlaintext: true }, binding,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'e2ee' } })).toBe('Team builders');
  });

  it('keeps Plain labels keyless and refuses unavailable E2EE recipient material', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ contentEncryptionMode: 'plain', recipients: [] }))
      .mockResolvedValueOnce(Response.json({ contentEncryptionMode: 'e2ee', recipients: [] }));
    vi.stubGlobal('fetch', fetch);
    const plain = await prepareCliPrivateLabel({ endpoint: 'https://home.example', token: 'token', accountId,
      binding, value: 'Plain deployment', accountMode: 'plain', recipientCensusPath: accountRecipientCensusPath });
    expect(plain).toEqual({ content: { t: 'plain', v: 'Plain deployment' }, recipients: [] });
    expect(openCliPrivateLabel({
      label: { content: plain.content, recipientEnvelope: null },
      binding,
      readPolicy: { kind: 'account-owned', contentEncryptionMode: 'plain' },
    }))
      .toBe('Plain deployment');
    await expect(prepareCliPrivateLabel({ endpoint: 'https://home.example', token: 'token', accountId,
      binding, value: 'Refuse plaintext fallback', accountMode: 'e2ee', recipientCensusPath: accountRecipientCensusPath }))
      .rejects.toMatchObject({ code: 'private_label_unavailable' });
  });

  it('refuses a Plain census for a caller-admitted E2EE author before it can emit plaintext', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ contentEncryptionMode: 'plain', recipients: [] }));
    vi.stubGlobal('fetch', fetch);

    await expect(prepareCliPrivateLabel({
      endpoint: 'https://home.example', token: 'token', accountId, binding,
      value: 'Never emit this plaintext', accountMode: 'e2ee', recipientCensusPath: accountRecipientCensusPath,
    })).rejects.toMatchObject({ code: 'private_label_unavailable' });

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`https://home.example${accountRecipientCensusPath}`);
  });

  it('opens Pool labels into a display view only when every visible label is available', () => {
    const view = {
      pool: {
        id: '12345678-1234-4234-8234-123456789abc',
        name: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Build fleet' }, recipientEnvelope: null } },
        description: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Linux builders' }, recipientEnvelope: null } },
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        members: [{ machineId: 'machine-1', priorityTier: 0, enabled: true, state: 'connected' as const }],
      },
      availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
    };
    expect(openCliMachinePoolPrivateView({ view, accountContentEncryptionMode: 'plain' })).toMatchObject({
      pool: { id: view.pool.id, name: 'Build fleet', description: 'Linux builders' },
    });
    expect(openCliMachinePoolPrivateView({ view: {
      ...view,
      pool: { ...view.pool, name: { kind: 'unavailable' as const } },
    }, accountContentEncryptionMode: 'plain' })).toBeNull();

    expect(openCliMachinePoolPrivateView({
      view,
      accountContentEncryptionMode: 'e2ee',
    })).toBeNull();
    expect(openCliMachinePoolPrivateView({
      view: {
        ...view,
        pool: { ...view.pool, audience: { kind: 'team' as const, teamId: 'team-1' } },
      },
      accountContentEncryptionMode: 'e2ee',
    })).toMatchObject({ pool: { name: 'Build fleet' } });
  });

  it('does not pass a partially unopened Pool list to reference consumers', () => {
    const available = {
      pool: {
        id: '12345678-1234-4234-8234-123456789abc',
        name: { kind: 'available' as const, label: { content: { t: 'plain' as const, v: 'Build fleet' }, recipientEnvelope: null } },
        description: null,
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
        members: [{ machineId: 'machine-1', priorityTier: 0, enabled: true, state: 'connected' as const }],
      },
      availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
    };
    expect(openCliMachinePoolPrivateViews({ views: [available], accountContentEncryptionMode: 'plain' })).toMatchObject({
      pools: [{ pool: { name: 'Build fleet' } }],
    });
    expect(openCliMachinePoolPrivateViews({ views: [available, {
      ...available,
      pool: { ...available.pool, id: '22345678-1234-4234-8234-123456789abc', name: { kind: 'unavailable' as const } },
    }], accountContentEncryptionMode: 'plain' })).toBeNull();
  });
});
