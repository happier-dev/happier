import { getServerFetchUrl } from '@/dev/testkit/mocks/serverFetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { parseReleasedServerV021Features } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import {
  StoredJsonContentEnvelopeSchema,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

vi.mock('@/utils/timing/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/timing/time')>();
  return {
    ...actual,
    backoff: actual.createBackoff({ minDelay: 0, maxDelay: 0, maxFailureCount: 3 }),
    backoffForever: actual.createBackoff({ minDelay: 0, maxDelay: 0, maxFailureCount: 3 }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function mockServerConfig() {
  vi.doMock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
      serverId: 'test',
      serverUrl: 'https://api.example.test',
      kind: 'custom',
      generation: 1,
    }),
  }));
}

const legacyCredentials: AuthCredentials = {
  token: 't',
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

const CurrentServerPlainCredentialCreateRequestSchema = z.object({
  content: StoredJsonContentEnvelopeSchema,
  expectedCredentialRevision: z.null(),
}).strict();

function sampleRecord(): ConnectedServiceCredentialRecordV1 {
  const now = Date.now();
  return {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'token',
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    oauth: null,
    token: { token: 'tok', providerAccountId: null, providerEmail: null, raw: null },
  };
}

describe('storeConnectedServiceCredentialForAccount', () => {
  it.each([
    ['service', { serviceId: 'claude-subscription' as const, profileId: 'work' }],
    ['profile', { serviceId: 'openai-codex' as const, profileId: 'other' }],
  ])('rejects a record with the wrong requested %s before reading mode or writing', async (_field, binding) => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.includes('/credential') && method === 'POST') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      ...binding,
      record: sampleRecord(),
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialBindingMismatchError',
      code: 'connected_service_credential_binding_mismatch',
      serviceId: binding.serviceId,
      profileId: binding.profileId,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores plaintext credentials via v3 when account mode is plain', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/features') && method === 'GET') {
        return new Response(JSON.stringify(buildServerFeaturesResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.expectedCredentialRevision).toBeNull();
        return new Response(JSON.stringify({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: sampleRecord(),
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('/v3/connect/openai-codex/profiles/work/credential'))).toBe(true);
  });

  it('omits the revision-only field when an exact server-v0.2.1 read established legacy unfenced semantics', async () => {
    mockServerConfig();
    const record = sampleRecord();
    const releasedRecord = {
      ...record,
      token: { ...record.token!, token: 'previous-token' },
    };
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({
          content: { t: 'plain', v: releasedRecord },
        }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          content: { t: 'plain', v: record },
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record,
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    });
  });

  it('uses legacy-compatible create semantics after exact server-v0.2.1 GET returns 404', async () => {
    mockServerConfig();
    const record = sampleRecord();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/features') && method === 'GET') {
        return new Response(JSON.stringify(parseReleasedServerV021Features()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({
          content: { t: 'plain', v: record },
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record,
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    });
  });

  it.each([
    {
      name: 'cached exact server-v0.2.1 followed by current-server upgrade',
      cachedContract: 'released' as const,
      writeContract: 'current' as const,
      expectedResult: {
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      },
    },
    {
      name: 'cached current server followed by exact server-v0.2.1 rollback',
      cachedContract: 'current' as const,
      writeContract: 'released' as const,
      expectedResult: {
        revisionSemantics: 'legacy_unfenced' as const,
        credentialRevision: null,
      },
    },
  ])('force-revalidates missing-create semantics after $name', async ({
    cachedContract,
    writeContract,
    expectedResult,
  }) => {
    mockServerConfig();
    const record = sampleRecord();
    let activeContract: 'current' | 'released' = cachedContract;
    let featuresReadCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/features') && method === 'GET') {
        featuresReadCount += 1;
        return new Response(JSON.stringify(
          activeContract === 'released'
            ? parseReleasedServerV021Features()
            : buildServerFeaturesResponse(),
        ), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        if (activeContract === 'released') {
          expect(body).toEqual({ content: { t: 'plain', v: record } });
        } else {
          const parsed = CurrentServerPlainCredentialCreateRequestSchema.safeParse(body);
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: 'invalid-params' }), { status: 400 });
          }
        }
        return new Response(JSON.stringify(
          activeContract === 'released'
            ? { success: true }
            : { success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' },
        ), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    await expect(getServerFeaturesSnapshot({ force: true })).resolves.toMatchObject({ status: 'ready' });
    activeContract = writeContract;

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record,
    })).resolves.toEqual(expectedResult);
    expect(featuresReadCount).toBe(2);
  });

  it('passes reconnect identity confirmation through plaintext credential storage', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.reconnect).toEqual({ allowProviderIdentityChange: true });
        return new Response(JSON.stringify({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: sampleRecord(),
    }, { allowProviderIdentityChange: true });

    expect(fetchMock).toHaveBeenCalled();
  });

  it('stores sealed credentials via v2 when account mode is e2ee', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.sealed?.format).toBe('account_scoped_v1');
        expect(typeof body?.sealed?.ciphertext).toBe('string');
        expect(body?.expectedCredentialRevision).toBeNull();
        return new Response(JSON.stringify({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: sampleRecord(),
    }, { randomBytes: (length) => new Uint8Array(length).fill(1) });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('/v2/connect/openai-codex/profiles/work/credential'))).toBe(true);
  });

  it('passes reconnect identity confirmation through sealed credential storage', async () => {
    mockServerConfig();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/auth/ping') && method === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        expect(body?.reconnect).toEqual({ allowProviderIdentityChange: true });
        return new Response(JSON.stringify({ success: true, credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: sampleRecord(),
    }, {
      allowProviderIdentityChange: true,
      randomBytes: (length) => new Uint8Array(length).fill(1),
    });

    expect(fetchMock).toHaveBeenCalled();
  });

  it('adopts a committed plaintext credential after an ambiguous lost response', async () => {
    mockServerConfig();
    const record = sampleRecord();
    let committed = false;
    let postCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return committed
          ? new Response(JSON.stringify({
            credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
            content: { t: 'plain', v: record },
          }), { status: 200 })
          : new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postCount += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.expectedCredentialRevision).toBeNull();
        committed = true;
        throw new Error('response lost after commit');
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record,
    })).resolves.toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    });
    expect(postCount).toBe(1);
  });

  it('reports superseded without retrying when an intervening writer wins after an ambiguous response', async () => {
    mockServerConfig();
    const intended = sampleRecord();
    const original = { ...intended, token: { ...intended.token!, token: 'original' } };
    const intervening = { ...intended, token: { ...intended.token!, token: 'intervening' } };
    let current = original;
    let revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let postCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ credentialRevision: revision, content: { t: 'plain', v: current } }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postCount += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.expectedCredentialRevision).toBe('csr_0123456789ABCDEFGHJKMNPQRS');
        current = intervening;
        revision = 'csr_2123456789ABCDEFGHJKMNPQRS';
        throw new Error('response lost while another writer committed');
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: intended,
    })).rejects.toMatchObject({
      code: 'connect_credential_mutation_superseded',
      status: 409,
      reason: 'revision_mismatch',
      credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
    });
    expect(postCount).toBe(1);
  });

  it('retries the same exact guard when an ambiguous attempt did not commit', async () => {
    mockServerConfig();
    const intended = sampleRecord();
    const original = { ...intended, token: { ...intended.token!, token: 'original' } };
    let postCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          content: { t: 'plain', v: original },
        }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postCount += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.expectedCredentialRevision).toBe('csr_0123456789ABCDEFGHJKMNPQRS');
        if (postCount === 1) throw new Error('request failed before commit');
        return new Response(JSON.stringify({
          success: true,
          credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: intended,
    })).resolves.toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    });
    expect(postCount).toBe(2);
  });

  it('does not write again when the authoritative settlement read fails', async () => {
    mockServerConfig();
    const intended = sampleRecord();
    const original = { ...intended, token: { ...intended.token!, token: 'original' } };
    const writeError = new Error('write outcome unknown');
    let credentialGetCount = 0;
    let postCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        credentialGetCount += 1;
        if (credentialGetCount === 1) {
          return new Response(JSON.stringify({
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            content: { t: 'plain', v: original },
          }), { status: 200 });
        }
        throw new Error('authoritative settlement unavailable');
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postCount += 1;
        throw writeError;
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: intended,
    })).rejects.toBe(writeError);
    expect(postCount).toBe(1);
  });

  it('never issues a third write after two ambiguous unchanged attempts', async () => {
    mockServerConfig();
    const intended = sampleRecord();
    const original = { ...intended, token: { ...intended.token!, token: 'original' } };
    let postCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          content: { t: 'plain', v: original },
        }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postCount += 1;
        throw new Error(`ambiguous write ${postCount}`);
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: intended,
    })).rejects.toThrow('ambiguous write 2');
    expect(postCount).toBe(2);
  });

  it('reuses one sealed ciphertext when an ambiguous attempt settles unchanged before retry', async () => {
    mockServerConfig();
    const postBodies: Array<{
      sealed: { format: string; ciphertext: string };
      expectedCredentialRevision: string | null;
    }> = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postBodies.push(JSON.parse(String(init?.body)));
        if (postBodies.length === 1) throw new Error('request failed before commit');
        return new Response(JSON.stringify({
          success: true,
          credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: sampleRecord(),
    }, {
      randomBytes: (length) => new Uint8Array(length).fill(7),
    })).resolves.toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    });

    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]).toEqual(postBodies[1]);
    expect(postBodies[0]?.expectedCredentialRevision).toBeNull();
    expect(postBodies[0]?.sealed.format).toBe('account_scoped_v1');
  });

  it('does not retry a server-declared 409 supersession', async () => {
    mockServerConfig();
    const record = sampleRecord();
    let postCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          content: { t: 'plain', v: record },
        }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        postCount += 1;
        return new Response(JSON.stringify({
          error: 'connect_credential_mutation_superseded',
          reason: 'revision_mismatch',
          credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
        }), { status: 409 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record,
    })).rejects.toMatchObject({
      code: 'connect_credential_mutation_superseded',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    });
    expect(postCount).toBe(1);
  });

  it('bypasses a warm e2ee mode cache and stores only through v3 after the account flips plain', async () => {
    mockServerConfig();
    let modeGetCount = 0;
    let v2PostCount = 0;
    let v3PostCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        modeGetCount += 1;
        return new Response(JSON.stringify({
          mode: modeGetCount === 1 ? 'e2ee' : 'plain',
          updatedAt: modeGetCount,
        }), { status: 200 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'GET') {
        return new Response(JSON.stringify({ error: 'connect_credential_not_found' }), { status: 404 });
      }
      if (url.endsWith('/v2/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        v2PostCount += 1;
        return new Response(JSON.stringify({ success: true, credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS' }), { status: 200 });
      }
      if (url.endsWith('/v3/connect/openai-codex/profiles/work/credential') && method === 'POST') {
        v3PostCount += 1;
        return new Response(JSON.stringify({ success: true, credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { fetchAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
    await expect(fetchAccountEncryptionMode(legacyCredentials)).resolves.toMatchObject({ mode: 'e2ee' });
    const { storeConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(storeConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      record: sampleRecord(),
    })).resolves.toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
    });

    expect(modeGetCount).toBe(2);
    expect(v2PostCount).toBe(0);
    expect(v3PostCount).toBe(1);
  });

  it('bypasses a warm e2ee mode cache and deletes only through v3 after the account flips plain', async () => {
    mockServerConfig();
    vi.doMock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
      getCachedReadyServerFeatures: () => ({
        capabilities: { connectedServices: { credentialDelete: { revisionGuard: true } } },
      }),
      getReadyServerFeatures: vi.fn(async () => null),
    }));
    let modeGetCount = 0;
    let v2DeleteCount = 0;
    let v3DeleteCount = 0;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = getServerFetchUrl(input).pathname;
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/health') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/auth/ping') && method === 'GET') return new Response('', { status: 200 });
      if (url.endsWith('/v1/account/encryption') && method === 'GET') {
        modeGetCount += 1;
        return new Response(JSON.stringify({
          mode: modeGetCount === 1 ? 'e2ee' : 'plain',
          updatedAt: modeGetCount,
        }), { status: 200 });
      }
      if (url === '/v2/connect/openai-codex/profiles/work/credential' && method === 'DELETE') {
        expect(getServerFetchUrl(input).searchParams.get('expectedCredentialRevision')).toBe('csr_0123456789ABCDEFGHJKMNPQRS');
        v2DeleteCount += 1;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url === '/v3/connect/openai-codex/profiles/work/credential' && method === 'DELETE') {
        expect(getServerFetchUrl(input).searchParams.get('expectedCredentialRevision')).toBe('csr_0123456789ABCDEFGHJKMNPQRS');
        v3DeleteCount += 1;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { fetchAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
    await expect(fetchAccountEncryptionMode(legacyCredentials)).resolves.toMatchObject({ mode: 'e2ee' });
    const { deleteConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(deleteConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toBeUndefined();

    expect(modeGetCount).toBe(2);
    expect(v2DeleteCount).toBe(0);
    expect(v3DeleteCount).toBe(1);
  });

  it('refuses to disconnect when the server does not advertise revision-guarded delete', async () => {
    mockServerConfig();
    vi.doMock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
      getCachedReadyServerFeatures: () => ({
        capabilities: { connectedServices: { credentialDelete: { revisionGuard: false } } },
      }),
      getReadyServerFeatures: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ success: true }), { status: 200 })
    ));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { deleteConnectedServiceCredentialForAccount } = await import('./storeConnectedServiceCredentialForAccount');
    await expect(deleteConnectedServiceCredentialForAccount(legacyCredentials, {
      serviceId: 'openai-codex',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).rejects.toThrow('Server update required to disconnect safely.');
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).includes('/credential')
      && String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'DELETE'
    ))).toBe(false);
  });
});
