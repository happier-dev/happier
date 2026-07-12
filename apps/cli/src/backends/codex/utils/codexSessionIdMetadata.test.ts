import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { maybeUpdateCodexSessionIdMetadata, publishCodexSessionIdMetadata } from './codexSessionIdMetadata';
import { resolveConfiguredCodexHome } from './resolveConfiguredCodexHome';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

const TEST_HOME_PATH = resolve(join('/tmp', 'happier-codex-home'));
const TEST_CODEX_HOME_ENV: NodeJS.ProcessEnv = {
  HOME: TEST_HOME_PATH,
  USERPROFILE: TEST_HOME_PATH,
  CODEX_HOME: '',
};
const DEFAULT_CODEX_HOME_PATH = resolveConfiguredCodexHome(TEST_CODEX_HOME_ENV);

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
      processEnv: TEST_CODEX_HOME_ENV,
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ path: '/tmp' })));
      },
      lastPublished,
    });

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
      processEnv: TEST_CODEX_HOME_ENV,
      updateHappySessionMetadata: apply,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      processEnv: TEST_CODEX_HOME_ENV,
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

  it('uses the provided processEnv HOME when deriving the default codex direct-session source', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-scoped-home',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      processEnv: {
        HOME: '/scoped/home',
      },
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ machineId: 'machine-1', path: '/repo' })));
      },
      lastPublished,
    } as any);

    expect(updates[0]?.directSessionV1).toMatchObject({
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/scoped/home/.codex',
      },
    });
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

  it('publishes connected-service Codex source affinity from child selection env for isolated materialized homes', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];
    const codexHome = '/Users/test/.happier/servers/cloud/daemon/connected-services/materialized/csm_session_1/codex/codex-home';

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-materialized-connected',
      backendMode: 'appServer',
      codexHome,
      activeServerDir: '/Users/test/.happier/servers/cloud',
      processEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'profile-1',
        }]),
      },
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ path: '/repo' })));
      },
      lastPublished,
    } as any);

    expect(updates[0]?.agentRuntimeDescriptorV1).toMatchObject({
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread-materialized-connected',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: codexHome,
        providerExtra: {
          runtimeAffinity: {
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'profile-1',
            homePath: codexHome,
          },
        },
      },
    });
  });

  it('publishes connected-service Codex group affinity through the generic runtime descriptor', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-group',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: '/Users/test/.happier/servers/cloud/daemon/connected-services/homes/openai-codex/__groups/main/codex/codex-home',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        updates.push(updater(createTestMetadata({ machineId: 'machine-1', path: '/repo' })));
      },
      lastPublished,
    } as any);

    expect(updates[0]?.agentRuntimeDescriptorV1).toMatchObject({
      providerId: 'codex',
      provider: {
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'main',
        providerExtra: {
          runtimeAffinity: {
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'main',
          },
        },
      },
    });
    expect(updates[0]?.directSessionV1).toMatchObject({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'main',
      },
    });
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

    await expect(publishCodexSessionIdMetadata({
      session: session as any,
      getCodexThreadId: () => 'thread-1',
      lastPublished,
    })).rejects.toThrow('update failed');
    expect(lastPublished.value).toBeNull();

    await publishCodexSessionIdMetadata({
      session: session as any,
      getCodexThreadId: () => 'thread-1',
      lastPublished,
    });
    expect(calls).toBe(2);
    expect(lastPublished.value).toBe('thread-1');
  });

  it('skips a redundant resume write only when the persisted Codex identity fingerprint is equivalent', async () => {
    let metadata = createTestMetadata({ path: '/tmp', codexSessionId: 'stale' });
    const seedSession = {
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
    };
    await publishCodexSessionIdMetadata({
      session: seedSession,
      operation: 'create',
      getCodexThreadId: () => 'thread-resume',
      backendMode: 'acp',
      transcriptStorage: 'persisted',
      processEnv: TEST_CODEX_HOME_ENV,
      lastPublished: { value: null },
    });

    const failingUpdate = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    await expect(publishCodexSessionIdMetadata({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: failingUpdate,
      },
      operation: 'resume',
      getCodexThreadId: () => 'thread-resume',
      backendMode: 'acp',
      transcriptStorage: 'persisted',
      processEnv: TEST_CODEX_HOME_ENV,
      lastPublished: { value: null },
    })).resolves.toBeUndefined();
    expect(failingUpdate).not.toHaveBeenCalled();

    const changedDescriptor = metadata.agentRuntimeDescriptorV1 as Record<string, unknown>;
    metadata = {
      ...metadata,
      agentRuntimeDescriptorV1: {
        ...changedDescriptor,
        provider: {
          ...(changedDescriptor.provider as Record<string, unknown>),
          homePath: '/different/codex-home',
        },
      },
    };
    await expect(publishCodexSessionIdMetadata({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: failingUpdate,
      },
      operation: 'resume',
      getCodexThreadId: () => 'thread-resume',
      backendMode: 'acp',
      transcriptStorage: 'persisted',
      processEnv: TEST_CODEX_HOME_ENV,
      lastPublished: { value: null },
    })).rejects.toThrow('metadata unavailable');
    expect(failingUpdate).toHaveBeenCalledTimes(1);
  });

  it('treats a trimmed persisted Codex id as the same durable resume identity', async () => {
    let metadata = createTestMetadata({ path: '/tmp' });
    await publishCodexSessionIdMetadata({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => {
          metadata = updater(metadata);
        },
      },
      operation: 'create',
      getCodexThreadId: () => 'thread-trimmed-resume',
      backendMode: 'acp',
      transcriptStorage: 'persisted',
      processEnv: TEST_CODEX_HOME_ENV,
      lastPublished: { value: null },
    });
    metadata = { ...metadata, codexSessionId: '  thread-trimmed-resume  ' };

    const failingUpdate = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    await expect(publishCodexSessionIdMetadata({
      session: { getMetadataSnapshot: () => metadata, updateMetadata: failingUpdate },
      operation: 'resume',
      getCodexThreadId: () => 'thread-trimmed-resume',
      backendMode: 'acp',
      transcriptStorage: 'persisted',
      processEnv: TEST_CODEX_HOME_ENV,
      lastPublished: { value: null },
    })).resolves.toBeUndefined();
    expect(failingUpdate).not.toHaveBeenCalled();
  });

  it('keeps create and non-durable resume publication acknowledged even when the thread id matches', async () => {
    let metadata = createTestMetadata({ codexSessionId: 'thread-resume' });
    const failingUpdate = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    const common = {
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: failingUpdate,
      },
      getCodexThreadId: () => 'thread-resume',
      backendMode: 'acp' as const,
      transcriptStorage: 'persisted' as const,
      processEnv: TEST_CODEX_HOME_ENV,
    };

    await expect(publishCodexSessionIdMetadata({
      ...common,
      operation: 'resume',
      lastPublished: { value: null },
    })).rejects.toThrow('metadata unavailable');

    metadata = createTestMetadata({ path: '/tmp' });
    await publishCodexSessionIdMetadata({
      ...common,
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => {
          metadata = updater(metadata);
        },
      },
      operation: 'create',
      lastPublished: { value: null },
    });
    await expect(publishCodexSessionIdMetadata({
      ...common,
      operation: 'create',
      lastPublished: { value: null },
    })).rejects.toThrow('metadata unavailable');
    expect(failingUpdate).toHaveBeenCalledTimes(2);
  });

  it('requires an equivalent direct-session source and nested runtime descriptor before skipping resume publication', async () => {
    let metadata = createTestMetadata({ machineId: 'machine-1', path: '/tmp' });
    const seedSession = {
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
    };
    const common = {
      getCodexThreadId: () => 'thread-direct-resume',
      backendMode: 'acp' as const,
      transcriptStorage: 'direct' as const,
      codexHome: '/Users/test/.codex',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      processEnv: TEST_CODEX_HOME_ENV,
    };
    await publishCodexSessionIdMetadata({
      ...common,
      session: seedSession,
      operation: 'create',
      lastPublished: { value: null },
    });

    const failingUpdate = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    await expect(publishCodexSessionIdMetadata({
      ...common,
      session: { getMetadataSnapshot: () => metadata, updateMetadata: failingUpdate },
      operation: 'resume',
      lastPublished: { value: null },
    })).resolves.toBeUndefined();
    expect(failingUpdate).not.toHaveBeenCalled();

    metadata = {
      ...metadata,
      directSessionV1: {
        ...(metadata.directSessionV1 as Record<string, unknown>),
        source: { kind: 'codexHome', home: 'user', homePath: '/different/codex-home' },
      },
    } as Metadata;
    await expect(publishCodexSessionIdMetadata({
      ...common,
      session: { getMetadataSnapshot: () => metadata, updateMetadata: failingUpdate },
      operation: 'resume',
      lastPublished: { value: null },
    })).rejects.toThrow('metadata unavailable');
    expect(failingUpdate).toHaveBeenCalledTimes(1);
  });
});
