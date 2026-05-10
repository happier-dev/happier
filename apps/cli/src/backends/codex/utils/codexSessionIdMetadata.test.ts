import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { maybeUpdateCodexSessionIdMetadata, publishCodexSessionIdMetadata } from '@/backends/codex/identity/codexSessionIdMetadata';

const DEFAULT_CODEX_HOME_PATH = resolve(join('/tmp', 'happier-codex-home', '.codex'));

async function flushCodexSessionIdPublication(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

function createMutableMetadataRecorder(initial: Metadata): Readonly<{
  updates: Metadata[];
  update: (updater: (metadata: Metadata) => Metadata) => void;
  getMetadata: () => Metadata;
}> {
  let metadata = initial;
  const updates: Metadata[] = [];
  return {
    updates,
    update: (updater) => {
      metadata = updater(metadata);
      updates.push(metadata);
    },
    getMetadata: () => metadata,
  };
}

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
    const recorder = createMutableMetadataRecorder(createTestMetadata({ path: '/tmp' }));
    const providerMarkerUpdates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const before = recorder.getMetadata().codexSessionId;
      recorder.update(updater);
      const after = recorder.getMetadata().codexSessionId;
      if (after !== before) {
        providerMarkerUpdates.push(recorder.getMetadata());
      }
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

    expect(providerMarkerUpdates).toEqual([
      createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' }),
      createTestMetadata({ path: '/tmp', codexSessionId: 'thread-2' }),
    ]);
  });

  it('publishes codexBackendMode alongside codexSessionId', () => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata({ path: '/tmp' });
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-app-server',
      backendMode: 'appServer',
      codexHome: DEFAULT_CODEX_HOME_PATH,
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        metadata = updater(metadata);
        updates.push(metadata);
      },
      lastPublished,
    } as any);

    expect(updates).toEqual([
      {
        ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-app-server' }),
        codexBackendMode: 'appServer',
      },
      {
        ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-app-server' }),
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
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
	              runtimeHandle: {
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
    const recorder = createMutableMetadataRecorder(createTestMetadata({ path: '/tmp' }));

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'mcp',
      codexHome: DEFAULT_CODEX_HOME_PATH,
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      codexHome: DEFAULT_CODEX_HOME_PATH,
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    const runtimeDescriptorUpdates = recorder.updates.filter((metadata) => metadata.runtimeDescriptorV1);
    expect(runtimeDescriptorUpdates).toEqual([
      {
        ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' }),
        codexBackendMode: 'mcp',
        runtimeDescriptorV1: {
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
	              runtimeHandle: {
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
        runtimeDescriptorV1: {
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
	              runtimeHandle: {
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
    const recorder = createMutableMetadataRecorder(createTestMetadata({ path: '/tmp', machineId: 'machine-1' }));

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'persisted',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    const descriptorUpdates = recorder.updates.filter((metadata) => metadata.runtimeDescriptorV1);
    expect(descriptorUpdates[0]?.externalSessionV1).toBeTruthy();
    expect(descriptorUpdates[1]?.externalSessionV1).toBeUndefined();
  });

  it('republishes metadata when the exact codex source identity changes for the same thread id', () => {
    const lastPublished = { value: null as string | null };
    const recorder = createMutableMetadataRecorder(createTestMetadata({ path: '/tmp', machineId: 'machine-1' }));

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: '/tmp/connected-codex-home',
      activeServerDir: '/tmp/happier/servers/cloud',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    const descriptorUpdates = recorder.updates.filter((metadata) => metadata.runtimeDescriptorV1);
    expect(descriptorUpdates).toHaveLength(2);
    expect((descriptorUpdates[0] as Metadata & { runtimeDescriptorV1?: unknown })?.runtimeDescriptorV1).not.toEqual(
      (descriptorUpdates[1] as Metadata & { runtimeDescriptorV1?: unknown })?.runtimeDescriptorV1,
    );
  });

  it('overwrites prior codexSessionId while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const recorder = createMutableMetadataRecorder(createTestMetadata({ codexSessionId: 'thread-old', name: 'keep-name' }));

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-next',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    expect(recorder.getMetadata()).toEqual(createTestMetadata({ codexSessionId: 'thread-next', name: 'keep-name' }));
  });

  it('clears stale runtime descriptor metadata when publishing a thread id without backend mode', () => {
    const lastPublished = { value: null as string | null };
    const recorder = createMutableMetadataRecorder({
      ...createTestMetadata({
        codexSessionId: 'thread-old',
        codexBackendMode: 'appServer',
        name: 'keep-name',
      }),
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread-old',
        },
      },
    } as unknown as Metadata);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-next',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    expect(recorder.getMetadata()).toEqual(createTestMetadata({ codexSessionId: 'thread-next', name: 'keep-name' }));
  });

  it('publishes direct-session metadata when transcript storage is direct', () => {
    const lastPublished = { value: null as string | null };
    const recorder = createMutableMetadataRecorder(createTestMetadata({ machineId: 'machine-1', path: '/repo' }));

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-direct',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: '/Users/test/.codex',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    expect(recorder.getMetadata()).toEqual(
      {
        ...createTestMetadata({ machineId: 'machine-1', path: '/repo', codexSessionId: 'thread-direct' }),
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
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
              runtimeHandle: {
                backendMode: 'appServer',
                vendorSessionId: 'thread-direct',
                home: 'user',
                homePath: '/Users/test/.codex',
              },
            },
          },
        },
        externalSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'thread-direct',
          source: { kind: 'codexHome', home: 'user', homePath: '/Users/test/.codex' },
          linkedAtMs: expect.any(Number),
          runtimeDescriptorV1: {
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
                runtimeHandle: {
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
    );
  });

  it('builds nested external-session runtime descriptors through the session-state descriptor binding', () => {
    const lastPublished = { value: null as string | null };
    const recorder = createMutableMetadataRecorder({
      ...createTestMetadata({
        machineId: 'machine-1',
        path: '/repo',
        codexSessionId: 'thread-old',
      }),
      externalSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'thread-old',
        source: { kind: 'codexHome', home: 'user', homePath: '/Users/test/.codex' },
        linkedAtMs: 1,
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'mcp',
            vendorSessionId: 'thread-old',
          },
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'mcp',
            vendorSessionId: 'legacy-read-alias',
          },
        },
      },
    } as unknown as Metadata);

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-direct',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: '/Users/test/.codex',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    const externalSession = recorder.getMetadata().externalSessionV1 as Record<string, unknown>;
    expect(externalSession.runtimeDescriptorV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread-direct',
      },
    });
    expect(externalSession.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'mcp',
        vendorSessionId: 'legacy-read-alias',
      },
    });
  });

  it('keeps codex provider resume marker publication separate from runtime descriptor publication', () => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata({ path: '/tmp' });
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-separated',
      backendMode: 'appServer',
      codexHome: DEFAULT_CODEX_HOME_PATH,
      updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => {
        metadata = updater(metadata);
        updates.push(metadata);
      },
      lastPublished,
    } as any);

    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      ...createTestMetadata({ path: '/tmp', codexSessionId: 'thread-separated' }),
      codexBackendMode: 'appServer',
    });
    expect(updates[0]).not.toHaveProperty('runtimeDescriptorV1');
    expect(updates[1]).toMatchObject({
      codexSessionId: 'thread-separated',
      codexBackendMode: 'appServer',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread-separated',
        },
      },
    });
  });

  it('publishes connected-service Codex source affinity through the generic runtime descriptor', () => {
    const lastPublished = { value: null as string | null };
    const recorder = createMutableMetadataRecorder(createTestMetadata({ path: '/repo' }));

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-connected',
      backendMode: 'appServer',
      codexHome: '/Users/test/.happier/servers/cloud/daemon/connected-services/homes/openai-codex/profile-1/codex/codex-home',
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    expect(recorder.getMetadata()).toEqual(
      {
        ...createTestMetadata({ path: '/repo', codexSessionId: 'thread-connected' }),
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
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
                runtimeHandle: {
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
    );
  });

  it('clears stale direct-session metadata when transcript storage is no longer direct', () => {
    const lastPublished = { value: null as string | null, fingerprint: null as string | null };
    const recorder = createMutableMetadataRecorder({
      ...createTestMetadata({ machineId: 'machine-1', path: '/repo', codexSessionId: 'thread-direct' }),
      externalSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'thread-direct',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 1,
      },
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-direct',
      backendMode: 'appServer',
      transcriptStorage: 'persisted',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    } as any);

    expect(recorder.getMetadata()).not.toHaveProperty('externalSessionV1');
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

    await flushCodexSessionIdPublication();

    expect(called).toBe(2);
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
    await flushCodexSessionIdPublication();
    expect(lastPublished.value).toBeNull();

    publishCodexSessionIdMetadata({ session: session as any, getCodexThreadId: () => 'thread-1', lastPublished });
    await flushCodexSessionIdPublication();
    expect(calls).toBe(3);
    expect(lastPublished.value).toBe('thread-1');
  });
});
