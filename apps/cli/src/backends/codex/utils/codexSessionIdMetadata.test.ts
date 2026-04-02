import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { maybeUpdateCodexSessionIdMetadata, publishCodexSessionIdMetadata } from './codexSessionIdMetadata';

const DEFAULT_CODEX_HOME_PATH = resolve(join(homedir(), '.codex'));

describe('maybeUpdateCodexSessionIdMetadata', () => {
  it('no-ops when thread id is missing', () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => null,
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('no-ops when thread id is whitespace-only', () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => '   ',
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes codexSessionId once per new thread id and preserves other metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = createTestMetadata({ path: '/tmp' });
      updates.push(updater(base));
    };

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => ' thread-1 ',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-2',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' }),
      createTestMetadata({ path: '/tmp', codexSessionId: 'thread-2' }),
    ]);
  });

  it('publishes codexBackendMode alongside codexSessionId', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-app-server',
      backendMode: 'appServer',
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ path: '/tmp' })));
      },
      lastPublished,
    } as any);

    expect(updates).toEqual([
      {
        ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-app-server' }),
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
	          provider: {
	            backendMode: 'appServer',
	            vendorSessionId: 'thread-app-server',
	            home: 'user',
	            homePath: DEFAULT_CODEX_HOME_PATH,
	            providerExtra: {
	              owner: 'codex',
	              schemaId: 'codex.agentRuntimeDescriptorExtra',
	              v: 1,
	              runtimeAffinity: {
	                backendMode: 'appServer',
	                vendorSessionId: 'thread-app-server',
	                home: 'user',
	                homePath: DEFAULT_CODEX_HOME_PATH,
	              },
	            },
	          },
        },
      } as Metadata,
    ]);
  });

  it('republishes metadata when codex backend mode changes for the same thread id', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      updates.push(updater(createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' })));
    };

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'mcp',
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    expect(updates).toEqual([
      {
        ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' }),
        codexBackendMode: 'mcp',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
	          provider: {
	            backendMode: 'mcp',
	            vendorSessionId: 'thread-1',
	            home: 'user',
	            homePath: DEFAULT_CODEX_HOME_PATH,
	            providerExtra: {
	              owner: 'codex',
	              schemaId: 'codex.agentRuntimeDescriptorExtra',
	              v: 1,
	              runtimeAffinity: {
	                backendMode: 'mcp',
	                vendorSessionId: 'thread-1',
	                home: 'user',
	                homePath: DEFAULT_CODEX_HOME_PATH,
	              },
	            },
	          },
        },
      } as Metadata,
      {
        ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' }),
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
	          provider: {
	            backendMode: 'appServer',
	            vendorSessionId: 'thread-1',
	            home: 'user',
	            homePath: DEFAULT_CODEX_HOME_PATH,
	            providerExtra: {
	              owner: 'codex',
	              schemaId: 'codex.agentRuntimeDescriptorExtra',
	              v: 1,
	              runtimeAffinity: {
	                backendMode: 'appServer',
	                vendorSessionId: 'thread-1',
	                home: 'user',
	                homePath: DEFAULT_CODEX_HOME_PATH,
	              },
	            },
	          },
        },
      } as Metadata,
    ]);
  });

  it('republishes metadata when transcript storage changes for the same thread id', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      updates.push(updater(createTestMetadata({ path: '/tmp', machineId: 'machine-1', codexSessionId: 'thread-1' })));
    };

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'persisted',
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    expect(updates[0]?.directSessionV1).toBeTruthy();
    expect(updates[1]?.directSessionV1).toBeUndefined();
  });

  it('republishes metadata when the exact codex source identity changes for the same thread id', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      updates.push(updater(createTestMetadata({ path: '/tmp', machineId: 'machine-1', codexSessionId: 'thread-1' })));
    };

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: '/tmp/connected-codex-home',
      activeServerDir: '/tmp/happier/servers/cloud',
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    expect(updates).toHaveLength(2);
    expect(updates[0]?.agentRuntimeDescriptorV1).not.toEqual(updates[1]?.agentRuntimeDescriptorV1);
  });

  it('overwrites prior codexSessionId while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ codexSessionId: 'thread-old', name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ codexSessionId: 'thread-next', name: 'keep-name' }),
    ]);
  });

  it('clears stale runtime descriptor metadata when publishing a thread id without backend mode', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({
          codexSessionId: 'thread-old',
          codexBackendMode: 'appServer',
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-old',
            },
          },
          name: 'keep-name',
        })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ codexSessionId: 'thread-next', name: 'keep-name' }),
    ]);
  });

  it('publishes direct-session metadata when transcript storage is direct', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-direct',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: '/Users/test/.codex',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ machineId: 'machine-1', path: '/repo' })));
      },
      lastPublished,
    } as any);

    expect(updates).toEqual([
      {
        ...createTestMetadata({ machineId: 'machine-1', path: '/repo', codexSessionId: 'thread-direct' }),
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread-direct',
            home: 'user',
            homePath: '/Users/test/.codex',
            providerExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeAffinity: {
                backendMode: 'appServer',
                vendorSessionId: 'thread-direct',
                home: 'user',
                homePath: '/Users/test/.codex',
              },
            },
          },
        },
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'thread-direct',
          source: { kind: 'codexHome', home: 'user', homePath: '/Users/test/.codex' },
          linkedAtMs: expect.any(Number),
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread-direct',
              home: 'user',
              homePath: '/Users/test/.codex',
              providerExtra: {
                owner: 'codex',
                schemaId: 'codex.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeAffinity: {
                  backendMode: 'appServer',
                  vendorSessionId: 'thread-direct',
                  home: 'user',
                  homePath: '/Users/test/.codex',
                },
              },
            },
          },
        },
      } as Metadata,
    ]);
  });

  it('publishes connected-service Codex source affinity through the generic runtime descriptor', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-connected',
      backendMode: 'appServer',
      codexHome: '/Users/test/.happier/servers/cloud/daemon/connected-services/homes/openai-codex/profile-1/codex/codex-home',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ path: '/repo' })));
      },
      lastPublished,
    } as any);

    expect(updates).toEqual([
      {
        ...createTestMetadata({ path: '/repo', codexSessionId: 'thread-connected' }),
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread-connected',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'profile-1',
            homePath: '/Users/test/.happier/servers/cloud/daemon/connected-services/homes/openai-codex/profile-1/codex/codex-home',
              providerExtra: {
                owner: 'codex',
                schemaId: 'codex.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeAffinity: {
                backendMode: 'appServer',
                vendorSessionId: 'thread-connected',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'profile-1',
                homePath: '/Users/test/.happier/servers/cloud/daemon/connected-services/homes/openai-codex/profile-1/codex/codex-home',
              },
            },
          },
        },
      } as Metadata,
    ]);
  });

  it('clears stale direct-session metadata when transcript storage is no longer direct', () => {
    const lastPublished = { value: null as string | null, fingerprint: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-direct',
      backendMode: 'appServer',
      transcriptStorage: 'persisted',
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater({
          ...createTestMetadata({ machineId: 'machine-1', path: '/repo', codexSessionId: 'thread-direct' }),
          directSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'thread-direct',
            source: { kind: 'codexHome', home: 'user' },
            linkedAtMs: 1,
          },
        }));
      },
      lastPublished,
    } as any);

    expect(updates[0]).not.toHaveProperty('directSessionV1');
  });

  it('does not mark thread id as published when the metadata update fails', async () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      updateHappySessionMetadata: async () => {
        called++;
        throw new Error('update failed');
      },
      lastPublished,
    });

    // Flush microtasks so the rejection handler can revert the optimistic publish.
    await Promise.resolve();
    await Promise.resolve();

    expect(called).toBe(1);
    expect(lastPublished.value).toBeNull();
  });

  it('retries publishing when a session.updateMetadata call fails', async () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    const session = {
      updateMetadata: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('update failed');
        }
      },
    };

    publishCodexSessionIdMetadata({ session: session as any, getCodexThreadId: () => 'thread-1', lastPublished });
    await Promise.resolve();
    await Promise.resolve();
    expect(lastPublished.value).toBeNull();

    publishCodexSessionIdMetadata({ session: session as any, getCodexThreadId: () => 'thread-1', lastPublished });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(lastPublished.value).toBe('thread-1');
  });
});
