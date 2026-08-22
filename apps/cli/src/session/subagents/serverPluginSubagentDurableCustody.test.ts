import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHostSubagentStore } from './hostSubagentStore';
import { createPluginSubagentsService, type PluginSubagentHostIdentity } from './pluginSubagentsService';
import { createServerPluginSubagentDurableCustody } from './serverPluginSubagentDurableCustody';

const identity: PluginSubagentHostIdentity = {
  pluginId: 'acme.plugin',
  contributionId: 'assistant',
  immutableGenerationId: 'generation-1',
  parentSessionId: 'session-1',
};
const credentials = {
  token: 'account-token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};
const tokenOnlyCredentials = {
  token: 'account-token',
  encryption: null,
} as const;
const capability = {
  capability: 'session.subagents.durable-custody.v1',
  maxRecords: 256,
  maxReceipts: 4_096,
  receiptRetentionMs: 86_400_000,
};

function rawSession(encryptionMode: 'plain' | 'e2ee', id = 'session-1') {
  return {
    id, seq: 1, createdAt: 10, updatedAt: 20, active: true, activeAt: 20,
    archivedAt: null, encryptionMode, metadata: encryptionMode === 'plain' ? '{}' : '', metadataVersion: 1,
    agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
  };
}

function service() {
  const store = createHostSubagentStore();
  return {
    store,
    service: createPluginSubagentsService({
      store,
      identity,
      isCurrent: () => true,
      durableCustody: createServerPluginSubagentDurableCustody({ credentials, identity }),
    }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('server-backed plugin subagent custody', () => {
  it('re-resolves credentials for every operation and fails closed after local revocation', async () => {
    let currentCredentials: typeof credentials | null = credentials;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : String(url).includes('/subagents/custody')
        ? { status: 200, data: { records: [] } } as never
        : { status: 200, data: { session: rawSession('plain') } } as never);
    const custody = createServerPluginSubagentDurableCustody({
      credentials,
      readCredentials: async () => currentCredentials,
      identity,
    });

    await custody.list({ scope: 'credential-currentness' });
    currentCredentials = { ...credentials, token: 'rotated-account-token' };
    await custody.list({ scope: 'credential-currentness' });

    const custodyRequests = vi.mocked(axios.get).mock.calls.filter(([url]) => (
      String(url).includes('/subagents/custody') && !String(url).endsWith('/capability')
    ));
    expect(custodyRequests.map(([, config]) => config?.headers?.Authorization)).toEqual([
      'Bearer account-token',
      'Bearer rotated-account-token',
    ]);

    currentCredentials = null;
    const callsBeforeRevocation = vi.mocked(axios.get).mock.calls.length;
    await expect(custody.list({ scope: 'credential-currentness' }))
      .rejects.toMatchObject({ code: 'plugin_subagent_credentials_unavailable' });
    expect(vi.mocked(axios.get).mock.calls).toHaveLength(callsBeforeRevocation);
  });

  it('sends explicit actor-wide immutable-generation retirement and safely retries after response loss', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: capability } as never);
    let attempts = 0;
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('response lost');
      return { status: 200, data: { retired: true } } as never;
    });
    const custody = createServerPluginSubagentDurableCustody({ credentials, identity });

    await expect(custody.retire()).rejects.toMatchObject({ code: 'plugin_subagent_durable_custody_unavailable' });
    await expect(custody.retire()).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(2);
    for (const [url, body] of post.mock.calls) {
      expect(String(url)).toContain('/v2/session-subagents/custody/generation-retirements');
      expect(body).toEqual({ pluginId: 'acme.plugin', immutableGenerationId: 'generation-1' });
    }
  });

  it('maps a retired-scope mutation to the generation-retired failure', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('plain') } } as never);
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { error: 'generation-retired' } } as never);

    await expect(service().service.observe({
      observationId: 'child', status: 'running',
    })).rejects.toMatchObject({ code: 'plugin_generation_retired' });
  });

  it('fails an old server closed and does not create process-local durable state', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: { error: 'Not found' } } as never);
    const current = service();

    await expect(current.service.observe({
      observationId: 'child', status: 'running',
    })).rejects.toMatchObject({ code: 'plugin_subagent_durable_custody_unavailable' });
    expect(current.service.capabilities().observe).toEqual({
      status: 'unavailable', code: 'plugin_subagent_durable_custody_unverified',
    });
    expect(await current.store.list()).toEqual([]);
  });

  it('hydrates durable actor-private records after service and store recreation', async () => {
    const record = {
      subagentId: `plugin-subagent-v1:sha256:${'a'.repeat(64)}`,
      groupId: 'workers', status: 'running', revision: 2, updatedAt: 200,
    } as const;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/capability')) return { status: 200, data: capability } as never;
      if (href.includes('/subagents/custody')) return { status: 200, data: { records: [record] } } as never;
      return { status: 200, data: { session: rawSession('plain') } } as never;
    });
    const recreated = service();

    await expect(recreated.service.list()).resolves.toMatchObject({
      items: [{ id: record.subagentId, groupId: 'workers', status: 'running' }],
    });
    await expect(recreated.service.get(record.subagentId)).resolves.toMatchObject({ status: 'running' });
  });

  it('keeps malformed server success responses out of the host inventory', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('plain') } } as never);
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { record: { status: 'running' } } } as never);
    const current = service();

    await expect(current.service.observe({
      observationId: 'child', status: 'running',
    })).rejects.toMatchObject({ code: 'plugin_subagent_server_response_invalid' });
    expect(await current.store.list()).toEqual([]);
  });

  it('rejects a server record whose revision does not satisfy the requested CAS transition', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('plain') } } as never);
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: request.groupId,
            status: request.status,
            revision: 7,
            updatedAt: 300,
          },
          replayed: false,
        },
      } as never;
    });
    const current = service();

    await expect(current.service.observe({
      observationId: 'child', status: 'running',
    })).rejects.toMatchObject({ code: 'plugin_subagent_server_response_invalid' });
    expect(await current.store.list()).toEqual([]);
  });

  it('accepts an immutable receipt replay after adapter recreation regardless of its committed revision', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('plain') } } as never);
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: request.groupId,
            status: request.status,
            revision: 7,
            updatedAt: 300,
          },
          replayed: true,
        },
      } as never;
    });
    const custody = createServerPluginSubagentDurableCustody({ credentials, identity });

    await expect(custody.mutate({
      scope: 'host-private',
      operationId: `plugin-subagent-observation-v1:sha256:${'a'.repeat(64)}`,
      subagentId: `plugin-subagent-v1:sha256:${'b'.repeat(64)}`,
      status: 'running',
    })).resolves.toMatchObject({ status: 'running', revision: '7' });
  });

  it('rejects a mismatched session snapshot before encryption or mutation', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('e2ee', 'different-session') } } as never);
    const post = vi.spyOn(axios, 'post');
    const current = service();

    await expect(current.service.observe({
      observationId: 'child', status: 'running',
      detail: { secret: 'must-not-encrypt-for-the-wrong-session' },
    })).rejects.toMatchObject({ code: 'plugin_subagent_server_response_invalid' });
    expect(post).not.toHaveBeenCalled();
    expect(await current.store.list()).toEqual([]);
  });

  it('keeps token-only plain custody writable and retained encrypted custody locked', async () => {
    let encryptionMode: 'plain' | 'e2ee' = 'plain';
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession(encryptionMode) } } as never);
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: request.groupId,
            status: request.status,
            revision: 0,
            updatedAt: 300,
          },
          replayed: false,
        },
      } as never;
    });
    const custody = createServerPluginSubagentDurableCustody({
      credentials: tokenOnlyCredentials,
      identity,
    });

    await expect(custody.mutate({
      scope: 'plain',
      operationId: 'plain-operation',
      subagentId: 'plain-subagent',
      status: 'running',
      detail: { visible: true },
    })).resolves.toMatchObject({ status: 'running' });
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      content: { t: 'plain', v: { visible: true } },
    });

    encryptionMode = 'e2ee';
    await expect(custody.mutate({
      scope: 'retained-encrypted',
      operationId: 'encrypted-operation',
      subagentId: 'encrypted-subagent',
      status: 'running',
      detail: { secret: true },
    })).rejects.toMatchObject({ code: 'encryption_material_unavailable' });
    expect(post).toHaveBeenCalledOnce();
  });

  it('retries capability negotiation after a transient server failure', async () => {
    let capabilityAttempts = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/capability')) {
        capabilityAttempts += 1;
        return capabilityAttempts === 1
          ? { status: 503, data: { error: 'temporarily unavailable' } } as never
          : { status: 200, data: capability } as never;
      }
      return { status: 200, data: { session: rawSession('plain') } } as never;
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: request.groupId,
            status: request.status,
            revision: 0,
            updatedAt: 301,
          },
          replayed: false,
        },
      } as never;
    });
    const current = service();
    const observation = { observationId: 'child', status: 'running' as const };

    await expect(current.service.observe(observation)).rejects.toMatchObject({ code: 'plugin_subagent_durable_custody_unavailable' });
    expect(current.service.capabilities().observe).toEqual({
      status: 'unavailable', code: 'plugin_subagent_durable_custody_unverified',
    });
    await expect(current.service.observe(observation)).resolves.toMatchObject({ status: 'running' });
    expect(capabilityAttempts).toBe(2);
  });

  it('retries capability negotiation after session visibility returns from a 404', async () => {
    let capabilityAttempts = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/capability')) {
        capabilityAttempts += 1;
        return capabilityAttempts === 1
          ? { status: 404, data: { error: 'Session not found' } } as never
          : { status: 200, data: capability } as never;
      }
      return { status: 200, data: { session: rawSession('plain') } } as never;
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: null,
            status: request.status,
            revision: 0,
            updatedAt: 202,
          },
          replayed: false,
        },
      } as never;
    });
    const current = service();
    const observation = {
      observationId: 'child',
      status: 'running' as const,
    };

    await expect(current.service.observe(observation)).rejects.toMatchObject({
      code: 'plugin_subagent_durable_custody_unavailable',
    });
    await expect(current.service.observe(observation)).resolves.toMatchObject({ status: 'running' });
    expect(capabilityAttempts).toBe(2);
  });

  it('aborts while fetching the session policy without sending a mutation', async () => {
    const controller = new AbortController();
    let resolveSession!: (value: unknown) => void;
    const pendingSession = new Promise((resolve) => { resolveSession = resolve; });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/capability')) return { status: 200, data: capability } as never;
      return await pendingSession as never;
    });
    const post = vi.spyOn(axios, 'post');
    const current = service();
    const mutation = current.service.observe({
      observationId: 'child', status: 'running',
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(2));

    controller.abort();
    resolveSession({ status: 200, data: { session: rawSession('plain') } });
    await expect(mutation).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    expect(post).not.toHaveBeenCalled();
    expect(await current.store.list()).toEqual([]);
  });

  it('detaches an aborted caller during the shared capability probe without poisoning the cache', async () => {
    const controller = new AbortController();
    let resolveCapability!: (value: unknown) => void;
    const pendingCapability = new Promise((resolve) => { resolveCapability = resolve; });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/capability')) return await pendingCapability as never;
      return { status: 200, data: { session: rawSession('plain') } } as never;
    });
    const post = vi.spyOn(axios, 'post');
    const current = service();
    const mutation = current.service.observe({
      observationId: 'child', status: 'running',
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(mutation).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    expect(current.service.capabilities().observe).toEqual({
      status: 'unavailable', code: 'plugin_subagent_durable_custody_unverified',
    });
    expect(post).not.toHaveBeenCalled();
    resolveCapability({ status: 200, data: capability });
    await vi.waitFor(() => expect(current.service.capabilities().observe).toEqual({ status: 'available' }));
  });

  it('binds encrypted semantic fingerprints to session and plugin custody scope', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const href = String(url);
      if (href.endsWith('/capability')) return { status: 200, data: capability } as never;
      const sessionId = href.includes('session-2') ? 'session-2' : 'session-1';
      return { status: 200, data: { session: rawSession('e2ee', sessionId) } } as never;
    });
    const requests: Record<string, unknown>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      requests.push(request);
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: request.groupId,
            status: request.status,
            revision: 0,
            updatedAt: 302,
          },
          replayed: false,
        },
      } as never;
    });
    const otherPluginIdentity = {
      ...identity,
      pluginId: 'other.plugin',
    };
    const otherSessionIdentity = {
      ...identity,
      parentSessionId: 'session-2',
    };
    const first = createServerPluginSubagentDurableCustody({ credentials, identity });
    const otherPlugin = createServerPluginSubagentDurableCustody({ credentials, identity: otherPluginIdentity });
    const otherSession = createServerPluginSubagentDurableCustody({ credentials, identity: otherSessionIdentity });
    const detail = { task: 'same semantic content' };

    await first.mutate({
      scope: 'first', operationId: 'same-operation', subagentId: 'subagent-a', status: 'running', detail,
    });
    await otherPlugin.mutate({
      scope: 'other-plugin', operationId: 'same-operation', subagentId: 'subagent-b', status: 'running', detail,
    });
    await otherSession.mutate({
      scope: 'other-session', operationId: 'same-operation', subagentId: 'subagent-c', status: 'running', detail,
    });
    expect(requests[1]!.contentFingerprint).not.toBe(requests[0]!.contentFingerprint);
    expect(requests[2]!.contentFingerprint).not.toBe(requests[0]!.contentFingerprint);
  });

  it('derives bounded server identities and encrypts detail for an E2EE session', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('e2ee') } } as never);
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return ({
      status: 200,
      data: {
        record: {
          subagentId: request.subagentId,
          groupId: request.groupId,
          status: request.status,
          revision: 0,
          updatedAt: 300,
        },
        replayed: false,
      },
      }) as never;
    });
    const current = service();
    const longGroupId = 'group'.repeat(1_000);

    const written = await current.service.observe({
      observationId: 'local'.repeat(1_000),
      groupId: longGroupId,
      status: 'running',
      detail: { secret: 'content-stays-in-envelope' },
    });
    const body = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.scope).toEqual({
      pluginId: 'acme.plugin', contributionId: 'assistant', immutableGenerationId: 'generation-1',
    });
    expect(String(body.operationId)).toMatch(/^plugin-subagent-observation-v1:sha256:[a-f0-9]{64}$/);
    expect(String(body.subagentId)).toMatch(/^plugin-subagent-v1:sha256:[a-f0-9]{64}$/);
    expect(String(body.groupId)).toMatch(/^plugin-group-v1:sha256:[a-f0-9]{64}$/);
    expect(body.content).toMatchObject({ t: 'encrypted', c: expect.any(String) });
    expect(JSON.stringify(body.content)).not.toContain('content-stays-in-envelope');
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        records: [{
          subagentId: written.id,
          groupId: body.groupId,
          status: 'running',
          revision: 0,
          updatedAt: 300,
        }],
      },
    } as never);
    await expect(current.service.list({ groupId: longGroupId })).resolves.toMatchObject({ items: [{ groupId: body.groupId }] });
  });

  it('serializes duplicate provider observations into one canonical host record', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('plain') } } as never);
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      return ({
      status: 200,
      data: {
        record: { subagentId: request.subagentId, groupId: null, status: 'running', revision: 0, updatedAt: 400 },
        replayed: true,
      },
      }) as never;
    });
    const current = service();
    const observation = { observationId: 'child', status: 'running' as const };

    const [first, second] = await Promise.all([
      current.service.observe(observation),
      current.service.observe(observation),
    ]);
    expect(second).toMatchObject({ id: first.id, status: first.status });
    expect(await current.store.list()).toHaveLength(1);
  });

  it('does not publish success after caller abort and replays the durable result after recreation', async () => {
    const controller = new AbortController();
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : String(url).includes('/subagents/custody')
        ? {
            status: 200,
            data: {
              records: [{
                subagentId: `plugin-subagent-v1:sha256:${'b'.repeat(64)}`,
                groupId: null,
                status: 'running',
                revision: 0,
                updatedAt: 500,
              }],
            },
          } as never
        : { status: 200, data: { session: rawSession('plain') } } as never);
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      controller.abort();
      return {
        status: 200,
        data: {
          record: { subagentId: request.subagentId, groupId: null, status: 'running', revision: 0, updatedAt: 500 },
          replayed: true,
        },
      } as never;
    });
    const first = service();

    await expect(first.service.observe({
      observationId: 'child',
      status: 'running',
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    expect(await first.store.list()).toEqual([]);

    const recreated = service();
    await expect(recreated.service.list()).resolves.toMatchObject({ items: [{ status: 'running' }] });
  });

  it('preserves semantic E2EE fingerprints when the same provider observation is repeated after recreation', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/capability')
      ? { status: 200, data: capability } as never
      : { status: 200, data: { session: rawSession('e2ee') } } as never);
    let firstRequest: Record<string, unknown> | null = null;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = body as Record<string, unknown>;
      if (firstRequest !== null && request.contentFingerprint !== firstRequest.contentFingerprint) {
        return { status: 409, data: { error: 'idempotency-conflict' } } as never;
      }
      const replayed = firstRequest !== null;
      if (firstRequest === null) firstRequest = request;
      return {
        status: 200,
        data: {
          record: {
            subagentId: request.subagentId,
            groupId: request.groupId,
            status: request.status,
            revision: 0,
            updatedAt: 600,
          },
          replayed,
        },
      } as never;
    });
    const observation = {
      observationId: 'child',
      status: 'running' as const,
      detail: { task: 'same semantic content', flags: { second: true, first: true } },
    };
    const first = await service().service.observe(observation);

    await expect(service().service.observe({
      ...observation,
      detail: { flags: { first: true, second: true }, task: 'same semantic content' },
    })).resolves.toMatchObject({
      id: first.id,
      status: first.status,
    });
    const postBodies = vi.mocked(axios.post).mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(postBodies[1]!.operationId).toBe(postBodies[0]!.operationId);
    expect(postBodies[1]!.contentFingerprint).toBe(postBodies[0]!.contentFingerprint);
    expect((postBodies[1]!.content as { c: string }).c).not.toBe((postBodies[0]!.content as { c: string }).c);
  });
});
