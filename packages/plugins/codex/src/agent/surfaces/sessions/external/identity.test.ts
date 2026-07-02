import { join, resolve } from 'node:path';

import type { SessionMetadata } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  maybeUpdateCodexSessionIdMetadata,
  publishCodexSessionIdMetadata,
  resolveCodexExternalSessionLinkIdentity,
  type CodexSessionIdentityMetadata,
  type CodexSessionIdentityPublicationState,
} from './identity.js';

const DEFAULT_CODEX_HOME_PATH = resolve(join('/tmp', 'happier-codex-home', '.codex'));

function createMutableMetadataRecorder(initial: CodexSessionIdentityMetadata): Readonly<{
  updates: CodexSessionIdentityMetadata[];
  update: (updater: (metadata: CodexSessionIdentityMetadata) => CodexSessionIdentityMetadata) => void;
  getMetadata: () => CodexSessionIdentityMetadata;
}> {
  let metadata = initial;
  const updates: CodexSessionIdentityMetadata[] = [];
  return {
    updates,
    update: (updater) => {
      metadata = updater(metadata);
      updates.push(metadata);
    },
    getMetadata: () => metadata,
  };
}

async function flushCodexSessionIdPublication(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('Codex plugin session identity metadata', () => {
  it('no-ops when provider thread id is missing', () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => null,
      updateHappySessionMetadata: () => {
        called++;
        return { path: '/tmp', host: 'test' };
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes provider session id once per new thread id', () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    const recorder = createMutableMetadataRecorder({ path: '/tmp', host: 'test' });
    const providerMarkerUpdates: CodexSessionIdentityMetadata[] = [];

    const apply = (updater: (metadata: CodexSessionIdentityMetadata) => CodexSessionIdentityMetadata) => {
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
      { path: '/tmp', host: 'test', codexSessionId: 'thread-1' },
      { path: '/tmp', host: 'test', codexSessionId: 'thread-2' },
    ]);
  });

  it('publishes provider session id and runtime descriptor from app-server identity', async () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    const recorder = createMutableMetadataRecorder({ path: '/tmp', host: 'test' });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => ' thread-app-server ',
      backendMode: 'appServer',
      codexHome: DEFAULT_CODEX_HOME_PATH,
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.updates).toEqual([
      {
        path: '/tmp',
        host: 'test',
        codexSessionId: 'thread-app-server',
        codexBackendMode: 'appServer',
      },
      {
        path: '/tmp',
        host: 'test',
        codexSessionId: 'thread-app-server',
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'thread-app-server',
            home: 'user',
            homePath: DEFAULT_CODEX_HOME_PATH,
            providerExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'appServer',
                providerSessionId: 'thread-app-server',
                home: 'user',
                homePath: DEFAULT_CODEX_HOME_PATH,
              },
            },
          },
        },
      },
    ]);
  });

  it('publishes external-session metadata only for direct transcript storage with a machine id', async () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    const recorder = createMutableMetadataRecorder({
      path: '/tmp',
      host: 'test',
      machineId: 'machine-1',
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-direct',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      codexHome: DEFAULT_CODEX_HOME_PATH,
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.getMetadata().externalSessionV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'thread-direct',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: DEFAULT_CODEX_HOME_PATH,
      },
    });
  });

  it('republishes runtime descriptor when transcript storage changes for the same thread id', async () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    const recorder = createMutableMetadataRecorder({
      path: '/tmp',
      host: 'test',
      machineId: 'machine-1',
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'direct',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      backendMode: 'appServer',
      transcriptStorage: 'persisted',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    await flushCodexSessionIdPublication();

    const descriptorUpdates = recorder.updates.filter((metadata) => metadata.runtimeDescriptorV1);
    expect(descriptorUpdates[0]?.externalSessionV1).toBeTruthy();
    expect(descriptorUpdates[1]?.externalSessionV1).toBeUndefined();
  });

  it('publishes connected-service source affinity through the runtime descriptor', async () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    const recorder = createMutableMetadataRecorder({ path: '/repo', host: 'test' });
    const codexHome = '/Users/test/.happier/servers/cloud/daemon/connected-services/homes/openai-codex/profile-1/codex/codex-home';

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-connected',
      backendMode: 'appServer',
      codexHome,
      activeServerDir: '/Users/test/.happier/servers/cloud',
      updateHappySessionMetadata: recorder.update,
      lastPublished,
    });

    await flushCodexSessionIdPublication();

    expect(recorder.getMetadata().runtimeDescriptorV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerSessionId: 'thread-connected',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: codexHome,
      },
    });
  });

  it('does not mark provider session id as published when metadata update fails', async () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
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

  it('retries publishing when the session metadata write fails', async () => {
    const lastPublished: CodexSessionIdentityPublicationState = { value: null };
    let calls = 0;

    const session = {
      updateMetadata: async () => {
        calls++;
        if (calls === 1) {
          throw new Error('update failed');
        }
      },
    };

    publishCodexSessionIdMetadata({
      session,
      getCodexThreadId: () => 'thread-1',
      lastPublished,
    });
    await flushCodexSessionIdPublication();
    expect(lastPublished.value).toBeNull();

    publishCodexSessionIdMetadata({
      session,
      getCodexThreadId: () => 'thread-1',
      lastPublished,
    });
    await flushCodexSessionIdPublication();

    expect(calls).toBe(3);
    expect(lastPublished.value).toBe('thread-1');
  });

  it('accepts generic session metadata updaters with non-Codex external session metadata', () => {
    type GenericSessionMetadata = SessionMetadata & {
      path: string;
      host: string;
      externalSessionV1?: {
        v: 1;
        providerId: string;
        machineId: string;
        remoteSessionId: string;
        source: { kind: 'codexHome'; home: 'user'; homePath: string };
        linkedAtMs: number;
      };
    };
    let metadata: GenericSessionMetadata = {
      path: '/tmp',
      host: 'test',
      homeDir: '/home/test',
      happyHomeDir: '/home/test/.happier',
      happyLibDir: '/home/test/.happier/lib',
      happyToolsDir: '/home/test/.happier/tools',
      externalSessionV1: {
        v: 1,
        providerId: 'other',
        machineId: 'machine-1',
        remoteSessionId: 'other-thread',
        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/.codex' },
        linkedAtMs: 1,
      },
    };

    publishCodexSessionIdMetadata({
      session: {
        sessionId: 'happy-session',
        updateMetadata: (updater: (value: GenericSessionMetadata) => GenericSessionMetadata) => {
          metadata = updater(metadata);
        },
      },
      getCodexThreadId: () => 'thread-generic',
      backendMode: 'appServer',
      lastPublished: { value: null },
    });

    expect(metadata.codexSessionId).toBe('thread-generic');
  });

  it('resolves external-session link identity from canonical runtime descriptor affinity', () => {
    const result = resolveCodexExternalSessionLinkIdentity({
      remoteSessionId: 'fallback-thread',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/user-codex-home',
      },
      runtimeDescriptor: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread-from-runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/tmp/connected-codex-home',
        },
      },
      metadata: {
        codexBackendMode: 'acp',
      },
    });

    expect(result).toMatchObject({
      remoteSessionId: 'thread-from-runtime',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: '/tmp/connected-codex-home',
      },
      vendorMetadata: {
        codexBackendMode: 'appServer',
      },
      externalSessionMetadata: {
        codexBackendMode: 'appServer',
      },
      runtimeDescriptor: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread-from-runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/tmp/connected-codex-home',
        },
      },
    });
  });
});
