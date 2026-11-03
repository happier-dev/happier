import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { createCliBoundSessionMetadataReader, resolveCliActionCallerSession, resolveCliActionCallerWorkflowTarget } from './resolveCliActionCallerSession';

describe('Account Action caller Session metadata authority', () => {
  it.each(['cli-global', 'plugin-global'])('keeps the unbound %s host out of Session selector transport', async sessionId => {
    const credentials = { token: 'token', encryption: null };
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('unbound_host_has_no_session'));
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unbound_host_has_no_session'));
    try {
      const read = createCliBoundSessionMetadataReader({ credentials, token: credentials.token, sessionId, mode: 'plain', ctx: null,
        resolveTransportForSession: (id, signal) => resolveSessionTransportContext({ reason: 'requester-binding', credentials, idOrPrefix: id, signal }),
      });
      await expect(read()).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    } finally { get.mockRestore(); post.mockRestore(); }
  });
  it('cancels remote caller preparation at the Account-currentness boundary', async () => {
    const sessionId = 'c111111111111111111111111';
    const credentials = { token: 'token', encryption: null };
    const caller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const get = vi.spyOn(axios, 'get').mockImplementationOnce((_url, config) => new Promise((resolve, reject) => {
      config?.signal?.addEventListener?.('abort', () => reject(caller.signal.reason), { once: true });
      release = () => resolve({ status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
      entered();
    })).mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/owner/repo', machineId: 'caller-machine', flavor: 'codex' }) }) } });
    try {
      const pending = resolveCliActionCallerSession({ credentials, boundSessionId: 'cli-global',
        context: { surface: 'agent', actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
          defaultSessionId: sessionId, signal: caller.signal },
        readBoundSession: async () => ({ metadata: null, workDepth: undefined, backendTarget: null, machineId: null, directory: null }),
        resolveTransportForSession: (id, signal?: AbortSignal) => resolveSessionTransportContext({ reason: 'requester-binding', credentials, idOrPrefix: id, signal }),
      }).then(value => ({ value }), error => ({ error }));
      await ready;
      const reason = new Error('caller cancelled');
      caller.abort(reason);
      release();
      expect(await pending).toEqual({ error: reason });
      // Currentness and exact Session reads may overlap. Cancellation must
      // reach every dispatched HTTP read, independently of their ordering.
      expect(get.mock.calls.every(([, config]) => config?.signal?.aborted === true)).toBe(true);
    } finally { get.mockRestore(); }
  });
  it('keeps a Session bearer closed to layout-1 owner metadata', async () => {
    const sessionId = 'c111111111111111111111111';
    const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1,
      share: null, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: { t: 'plain', v: { v: 1, workspace: { path: '/owner/private' } } },
    });
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: rawSession } });
    try {
      const read = createCliBoundSessionMetadataReader({ token: 'session-bearer', sessionId, rawSession,
        mode: 'plain', ctx: null, resolveTransportForSession: async () => { throw new Error('Account transport is not authorized'); },
      });
      await expect(read()).resolves.toBeNull();
    } finally { get.mockRestore(); }
  });

  it.each(['cached', 'fetched'] as const)('opens bound layout-1 owner metadata from the %s record', async (source) => {
    const sessionId = 'c111111111111111111111111';
    const credentials = { token: 'token', encryption: null };
    const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      metadata: JSON.stringify({ v: 1, agentPresentation: { agentId: 'codex' } }),
      ownerMetadata: { t: 'plain', v: { v: 1, workspace: { path: '/bound/owner', machineId: 'bound-machine' } } } });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => ({ status: 200, data:
      String(url).endsWith('/v1/account/encryption/currentness')
        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
        : { session: rawSession } }));
    try {
      const read = createCliBoundSessionMetadataReader({ credentials, token: credentials.token, sessionId, mode: 'plain', ctx: null,
        ...(source === 'cached' ? { rawSession } : {}),
        resolveTransportForSession: (id) => resolveSessionTransportContext({ reason: 'requester-binding', credentials, idOrPrefix: id }),
      });
      await expect(read()).resolves.toMatchObject({ path: '/bound/owner', machineId: 'bound-machine' });
    } finally { get.mockRestore(); }
  });

  it.each([0, 1] as const)('opens caller workspace and Agent using layout %s, not the bound host', async (layout) => {
    const sessionId = 'c111111111111111111111111';
    const credentials = { token: 'token', encryption: null };
    const rawSession = createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: 'plain', workDepth: 2,
      ...(layout === 0 ? { metadata: JSON.stringify({ path: '/owner/repo', machineId: 'caller-machine', flavor: 'codex' }) }
        : { metadataLayoutVersion: 1, share: null, metadata: JSON.stringify({ v: 1, agentPresentation: { agentId: 'codex' } }),
          ownerMetadata: { t: 'plain', v: { v: 1, workspace: { path: '/owner/repo', machineId: 'caller-machine' },
            nativeSession: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } } } } }),
    });
    // Only HTTP is replaced; transport identity, content-mode opening and
    // owner/shared metadata projection run through their actual owners.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => ({ status: 200, data:
      String(url).endsWith('/v1/account/encryption/currentness')
        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
        : { session: rawSession } }));
    try {
      const params = { credentials, boundSessionId: 'cli-global',
        context: { surface: 'agent', actionCaller: { kind: 'session', sessionId, starterDepth: 2, turnDepth: 3 }, defaultSessionId: sessionId },
        // This is the bound process's real-shaped snapshot, not a normalizer.
        readBoundSession: async () => ({ metadata: { flavor: 'claude' }, workDepth: 0,
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          machineId: 'wrong-machine', directory: '/wrong/repo' }),
        resolveTransportForSession: (id: string) => resolveSessionTransportContext({ reason: 'requester-binding', credentials, idOrPrefix: id }),
      } satisfies Parameters<typeof resolveCliActionCallerSession>[0];
      const result = await resolveCliActionCallerSession(params);
      expect(result).toMatchObject({ sessionId, workDepth: 2, directory: '/owner/repo', machineId: 'caller-machine',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } });
      await expect(resolveCliActionCallerWorkflowTarget({ ...params, target: { kind: 'machine', machineId: 'caller-machine' } }))
        .resolves.toEqual({ kind: 'machine', machineId: 'caller-machine', project: { machineId: 'caller-machine', directory: '/owner/repo' } });
      await expect(resolveCliActionCallerWorkflowTarget({ ...params, target: { kind: 'machine', machineId: 'wrong-machine' } }))
        .resolves.toBeNull();
    } finally { get.mockRestore(); }
  });

  it('refuses owner content that disagrees with authoritative Account mode', async () => {
    const sessionId = 'c111111111111111111111111';
    const credentials = { token: 'token', encryption: null };
    const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      metadata: JSON.stringify({ v: 1 }), ownerMetadata: { t: 'plain', v: { v: 1,
        workspace: { path: '/must-not-disclose', machineId: 'caller-machine' } } } });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => ({ status: 200, data:
      String(url).endsWith('/v1/account/encryption/currentness')
        ? { mode: 'e2ee', version: 1, signingKeyFingerprint: 'a'.repeat(64), contentKeyFingerprint: 'b'.repeat(64), updatedAt: 1 }
        : { session: rawSession } }));
    try {
      await expect(resolveCliActionCallerSession({ credentials, boundSessionId: 'cli-global',
        context: { surface: 'agent', actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, defaultSessionId: sessionId },
        readBoundSession: async () => ({ metadata: null, workDepth: undefined, backendTarget: null, machineId: null, directory: null }),
        resolveTransportForSession: (id) => resolveSessionTransportContext({ reason: 'requester-binding', credentials, idOrPrefix: id }),
      })).resolves.toBeNull();
    } finally { get.mockRestore(); }
  });

  it('refuses selectors and a transport returning another Session identity', async () => {
    const sessionId = 'c111111111111111111111111';
    const credentials = { token: 'token', encryption: null };
    const rawSession = createSessionRecordFixture({ id: 'c222222222222222222222222', encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/other/repo', machineId: 'other-machine', flavor: 'codex' }) });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => ({ status: 200, data:
      String(url).endsWith('/v1/account/encryption/currentness')
        ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
        : { session: rawSession } }));
    const params = { credentials, boundSessionId: 'cli-global',
      readBoundSession: async () => ({ metadata: null, workDepth: undefined, backendTarget: null, machineId: null, directory: null }),
      resolveTransportForSession: (id: string) => resolveSessionTransportContext({ reason: 'requester-binding', credentials, idOrPrefix: id }),
    };
    try {
      await expect(resolveCliActionCallerSession({ ...params,
        context: { surface: 'agent', actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'another-selector' },
      })).resolves.toBeNull();
      await expect(resolveCliActionCallerSession({ ...params,
        context: { surface: 'agent', actionCaller: { kind: 'host' }, defaultSessionId: sessionId },
      })).resolves.toBeNull();
      await expect(resolveCliActionCallerSession({ ...params,
        context: { surface: 'agent', actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, defaultSessionId: sessionId },
      })).resolves.toBeNull();
    } finally { get.mockRestore(); }
  });
});
