import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { maybeUpdateOpenCodeSessionIdMetadata } from './opencodeSessionIdMetadata';

describe('maybeUpdateOpenCodeSessionIdMetadata', () => {
  it('no-ops when session id is missing', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    let called = 0;

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => null,
      backendMode: 'server',
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.sessionId).toBeNull();
    expect(lastPublished.backendMode).toBeNull();
    expect(lastPublished.serverBaseUrl).toBeNull();
    expect(lastPublished.serverBaseUrlExplicit).toBe(false);
  });

  it('publishes opencodeSessionId once per new session id and preserves other metadata', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = { path: '/tmp', flavor: 'opencode' } as unknown as Metadata;
      updates.push(updater(base));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => ' session-1 ',
      backendMode: 'server',
      serverBaseUrl: ' http://127.0.0.1:4096/ ',
      serverBaseUrlExplicit: true,
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-2',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      {
        path: '/tmp',
        flavor: 'opencode',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'session-1',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'session-1',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      } as unknown as Metadata,
      {
        path: '/tmp',
        flavor: 'opencode',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'session-2',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'session-2',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
        opencodeSessionId: 'session-2',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      } as unknown as Metadata,
    ]);
  });

  it('does not persist server base url affinity when the runtime server was not explicitly configured', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = { path: '/tmp', flavor: 'opencode' } as unknown as Metadata;
      updates.push(updater(base));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: false,
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      {
        path: '/tmp',
        flavor: 'opencode',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'session-1',
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'session-1',
              },
            },
          },
        },
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
      } as unknown as Metadata,
    ]);
  });

  it('publishes direct-session metadata for direct server-backed sessions', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    const updates: Metadata[] = [];

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      transcriptStorage: 'direct',
      updateHappySessionMetadata: (updater) => {
        const base = { machineId: 'machine-1', path: '/repo', flavor: 'opencode' } as unknown as Metadata;
        updates.push(updater(base));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      {
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'opencode',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'session-1',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'session-1',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
        directSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine-1',
          remoteSessionId: 'session-1',
          source: {
            kind: 'opencodeServer',
            baseUrl: 'http://127.0.0.1:4096/',
            directory: '/repo',
          },
          linkedAtMs: expect.any(Number),
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'opencode',
            provider: {
              backendMode: 'server',
              vendorSessionId: 'session-1',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
              providerExtra: {
                owner: 'opencode',
                schemaId: 'opencode.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: {
                  backendMode: 'server',
                  vendorSessionId: 'session-1',
                  serverBaseUrl: 'http://127.0.0.1:4096/',
                  serverBaseUrlExplicit: true,
                },
              },
            },
          },
        },
      } as unknown as Metadata,
    ]);
  });

  it('clears stale explicit server affinity when the runtime is no longer explicitly configured', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = {
        path: '/tmp',
        flavor: 'opencode',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      } as unknown as Metadata;
      updates.push(updater(base));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      backendMode: 'server',
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      {
        path: '/tmp',
        flavor: 'opencode',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'session-1',
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'session-1',
              },
            },
          },
        },
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
      } as unknown as Metadata,
    ]);
  });

  it('clears stale runtime descriptor metadata when publishing a session id without backend mode', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = {
        path: '/tmp',
        flavor: 'opencode',
        opencodeSessionId: 'session-old',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'session-old',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'session-old',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
      } as unknown as Metadata;
      updates.push(updater(base));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-next',
      backendMode: null,
      serverBaseUrl: null,
      serverBaseUrlExplicit: false,
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      {
        path: '/tmp',
        flavor: 'opencode',
        opencodeSessionId: 'session-next',
      } as unknown as Metadata,
    ]);
  });

  it('clears stale direct-session metadata when transcript storage is no longer direct', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    } as Record<string, unknown>;
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = {
        machineId: 'machine-1',
        path: '/tmp',
        flavor: 'opencode',
        opencodeSessionId: 'session-old',
        opencodeBackendMode: 'server',
        directSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine-1',
          remoteSessionId: 'session-old',
          source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
          linkedAtMs: 1,
        },
      } as unknown as Metadata;
      updates.push(updater(base));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-old',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      transcriptStorage: 'persisted',
      updateHappySessionMetadata: apply,
      lastPublished: lastPublished as any,
    });

    expect(updates[0]).not.toHaveProperty('directSessionV1');
  });

  it('does not mark non-explicit server URLs as explicit in direct-session runtime metadata', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    } as Record<string, unknown>;
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      updates.push(updater({ machineId: 'machine-1', path: '/tmp', flavor: 'opencode' } as unknown as Metadata));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: false,
      transcriptStorage: 'direct',
      updateHappySessionMetadata: apply,
      lastPublished: lastPublished as any,
    });

    expect(updates[0]?.directSessionV1).toMatchObject({
      agentRuntimeDescriptorV1: {
        provider: {
          backendMode: 'server',
          vendorSessionId: 'session-1',
        },
      },
    });
    expect(updates[0]?.directSessionV1).not.toMatchObject({
      agentRuntimeDescriptorV1: {
        provider: {
          serverBaseUrlExplicit: true,
        },
      },
    });
  });

  it('does not mark the session id as published when the metadata update fails', async () => {
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };
    let called = 0;

    await expect(
      maybeUpdateOpenCodeSessionIdMetadata({
        getOpenCodeSessionId: () => 'session-1',
        backendMode: 'server',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
        updateHappySessionMetadata: async () => {
          called++;
          throw new Error('update failed');
        },
        lastPublished,
      }),
    ).rejects.toThrow('update failed');

    expect(called).toBe(1);
    expect(lastPublished.sessionId).toBeNull();
    expect(lastPublished.backendMode).toBeNull();
    expect(lastPublished.serverBaseUrl).toBeNull();
    expect(lastPublished.serverBaseUrlExplicit).toBe(false);
  });
});
