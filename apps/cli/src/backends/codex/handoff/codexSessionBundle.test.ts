import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportCodexSessionBundle } from './exportCodexSessionBundle';
import { importCodexSessionBundle } from './importCodexSessionBundle';

describe('codex session handoff bundle', () => {
  it('exports rollout files for the requested codex session', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_1.jsonl');
    await writeFile(rolloutPath, '{"event":"hello"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_1',
        codexBackendMode: 'appServer',
      },
      remoteSessionId: 'thread_1',
      env: {
        CODEX_HOME: codexHome,
      },
      activeServerDir: '/active-server',
    });

    expect(result.providerId).toBe('codex');
    expect(result.remoteSessionId).toBe('thread_1');
    expect(result.affinity).toEqual({
      backendMode: 'appServer',
    });
    expect(result.files).toEqual([
      {
        relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_1.jsonl',
        contentFile: { t: 'happier.handoff.file.v1', filePath: rolloutPath, offsetBytes: 0, sizeBytes: 18 },
      },
    ]);
    expect('codexBackendMode' in result).toBe(false);
  });

  it('exports rollout files as raw bytes without UTF-8 re-encoding', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-bytes-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_bytes.jsonl');
    const bytes = Buffer.from([0xff, 0x00, 0x61, 0x62, 0x80]);
    await writeFile(rolloutPath, bytes);

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_bytes',
        codexBackendMode: 'appServer',
      },
      remoteSessionId: 'thread_bytes',
      env: {
        CODEX_HOME: codexHome,
      },
      activeServerDir: '/active-server',
    });

    expect(result.files).toEqual([
      {
        relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_bytes.jsonl',
        contentFile: { t: 'happier.handoff.file.v1', filePath: rolloutPath, offsetBytes: 0, sizeBytes: bytes.length },
      },
    ]);
  });

  it('exports rollout files from the linked connected-service codex home instead of the current CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-connected-'));
    const userCodexHome = join(root, 'user-codex-home');
    const connectedCodexHome = join(
      root,
      'servers',
      'cloud',
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'profile-1',
      'codex',
      'codex-home',
    );
    const rolloutDir = join(connectedCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(userCodexHome, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_connected.jsonl');
    await writeFile(rolloutPath, '{"event":"hello-connected"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_connected',
        codexBackendMode: 'appServer',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine_1',
          remoteSessionId: 'thread_connected',
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
          },
          linkedAtMs: 1,
        },
      },
      remoteSessionId: 'thread_connected',
      env: {
        CODEX_HOME: userCodexHome,
      },
      activeServerDir: join(root, 'servers', 'cloud'),
    });

    expect(result.files).toEqual([
      {
        relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_connected.jsonl',
        contentFile: { t: 'happier.handoff.file.v1', filePath: rolloutPath, offsetBytes: 0, sizeBytes: 28 },
      },
    ]);
    expect(result.affinity).toEqual({
      backendMode: 'appServer',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
    });
  });

  it('exports the canonical codex runtime descriptor when present', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-runtime-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_runtime.jsonl'), '{"event":"hello"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_runtime',
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'primary-pool',
          },
        },
      },
      remoteSessionId: 'thread_runtime',
      env: {
        CODEX_HOME: codexHome,
      },
      activeServerDir: '/active-server',
    });

    expect(result.affinity?.runtimeDescriptor).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_runtime',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'primary-pool',
        providerExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
        },
      },
    });
  });

  it('uses codex runtime descriptor source affinity for persisted handoff export when directSessionV1 is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-runtime-source-'));
    const userCodexHome = join(root, 'user-codex-home');
    const connectedCodexHome = join(
      root,
      'servers',
      'cloud',
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'profile-1',
      'codex',
      'codex-home',
    );
    const rolloutDir = join(connectedCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(userCodexHome, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_runtime_only.jsonl');
    await writeFile(rolloutPath, '{"event":"hello-runtime-source"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_runtime_only',
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_runtime_only',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'profile-1',
            homePath: connectedCodexHome,
          },
        },
      },
      remoteSessionId: 'thread_runtime_only',
      env: {
        CODEX_HOME: userCodexHome,
      },
      activeServerDir: join(root, 'servers', 'cloud'),
    });

    expect(result.files).toEqual([{
      relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_runtime_only.jsonl',
      contentFile: expect.objectContaining({ offsetBytes: 0, sizeBytes: 33 }),
    }]);
    expect(result.files[0]!.contentFile?.filePath).toMatch(/rollout-2026-03-08T10-00-00-thread_runtime_only\.jsonl$/u);
    expect(result.affinity?.source).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
    });
  });

  it('does not export machine-specific codex homePath affinity in the bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-homepath-'));
    const userCodexHome = join(root, 'user-codex-home');
    const sourceCodexHome = join(root, 'source-machine-codex-home');
    const rolloutDir = join(sourceCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(userCodexHome, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_homepath.jsonl'), '{"event":"hello-homepath"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_homepath',
        codexBackendMode: 'appServer',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine_1',
          remoteSessionId: 'thread_homepath',
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: sourceCodexHome,
          },
          linkedAtMs: 1,
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_homepath',
            home: 'user',
            homePath: sourceCodexHome,
          },
        },
      },
      remoteSessionId: 'thread_homepath',
      env: {
        CODEX_HOME: userCodexHome,
      },
      activeServerDir: join(root, 'servers', 'cloud'),
    });

    expect(result.affinity?.source).toEqual({
      kind: 'codexHome',
      home: 'user',
    });
    const exportedHomePath = (result.affinity?.runtimeDescriptor?.provider as unknown as { homePath?: unknown } | undefined)?.homePath;
    expect(typeof exportedHomePath).not.toBe('string');
    expect(exportedHomePath ?? null).toBeNull();
  });

  it('keeps large rollout files disk-backed through export and import', async () => {
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-large-source-'));
    const targetCodexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-large-target-'));
    const rolloutDir = join(sourceCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_large.jsonl');
    const bytes = Buffer.alloc(5 * 1024 * 1024, '{"event":"large-session-record"}\n');
    await writeFile(rolloutPath, bytes);

    const bundle = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_large',
        codexBackendMode: 'appServer',
      },
      remoteSessionId: 'thread_large',
      env: { CODEX_HOME: sourceCodexHome },
      activeServerDir: '/active-server',
    });

    expect(bundle.files).toEqual([{
      relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_large.jsonl',
      contentFile: {
        t: 'happier.handoff.file.v1',
        filePath: rolloutPath,
        offsetBytes: 0,
        sizeBytes: bytes.length,
      },
    }]);
    expect('contentBase64' in bundle.files[0]!).toBe(false);

    await importCodexSessionBundle({
      bundle,
      targetPath: '/repo',
      env: { CODEX_HOME: targetCodexHome },
    });
    await expect(readFile(join(
      targetCodexHome,
      'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_large.jsonl',
    ))).resolves.toEqual(bytes);
  });

  it('imports rollout files into the target codex home and returns resume metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-'));
    const targetPath = join(tmpdir(), 'repo-target');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_1',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_1.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.remoteSessionId).toBe('thread_1');
    expect(result.directSource).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: codexHome,
    });
    expect(result.resume).toEqual({
      directory: targetPath,
      agent: 'codex',
      resume: 'thread_1',
      environmentVariables: {
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: codexHome,
      },
      transcriptStorage: 'direct',
      approvedNewDirectoryCreation: true,
      codexBackendMode: 'appServer',
    });

    const importedPath = join(codexHome, 'sessions', '2026', '03', '08', 'rollout-2026-03-08T10-00-00-thread_1.jsonl');
    await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"event":"hello"}\n');
  });

  it('uses the import env HOME fallback even when process.env.HOME points somewhere else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-env-home-'));
    const targetPath = join(tmpdir(), 'repo-target-env-home');
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, 'wrong-home');

    try {
      const result = await importCodexSessionBundle({
        bundle: {
          providerId: 'codex',
          remoteSessionId: 'thread_env_home',
          affinity: {
            backendMode: 'appServer',
          },
          files: [
            {
              relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_env_home.jsonl',
              contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
            },
          ],
        },
        targetPath,
        env: {
          HOME: join(root, 'expected-home'),
        },
      });

      expect(result.directSource).toEqual({
        kind: 'codexHome',
        home: 'user',
        homePath: join(root, 'expected-home', '.codex'),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('does not import source-machine codex homePath affinity into the target runtime descriptor', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-homepath-'));
    const targetPath = join(tmpdir(), 'repo-target-homepath');
    const sourceCodexHome = join(tmpdir(), 'source-machine-codex-home');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_homepath',
        affinity: {
          backendMode: 'appServer',
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: sourceCodexHome,
          },
          runtimeDescriptor: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread_homepath',
              home: 'user',
              homePath: sourceCodexHome,
            },
          },
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_homepath.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.directSource).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: codexHome,
    });
    expect(result.agentRuntimeDescriptorV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        home: 'user',
        homePath: codexHome,
      },
    });
  });

  it('imports connected-service codex affinity without collapsing the source or runtime descriptor', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-connected-'));
    const targetPath = join(tmpdir(), 'repo-target-connected');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_connected',
        affinity: {
          backendMode: 'appServer',
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            homePath: '/source-machine/codex-home',
          },
          runtimeDescriptor: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              vendorSessionId: 'thread_connected',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
              homePath: '/source-machine/codex-home',
            },
          },
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_connected.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.directSource).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
    });
    expect(result.agentRuntimeDescriptorV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_connected',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        providerExtra: {
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_connected',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
          },
        },
      },
    });
  });

  it('supports persisted resume plans when the handoff keeps persisted transcript storage', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-persisted-'));
    const targetPath = join(tmpdir(), 'repo-target-persisted');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_2',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_2.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
      sessionStorageMode: 'persisted',
    });

    expect(result.resume).toMatchObject({
      directory: targetPath,
      agent: 'codex',
      resume: 'thread_2',
      environmentVariables: {
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: codexHome,
      },
      transcriptStorage: 'persisted',
      approvedNewDirectoryCreation: true,
      codexBackendMode: 'appServer',
    });
  });

  it('preserves ACP backend affinity when importing an ACP handoff bundle', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-acp-'));
    const targetPath = join(tmpdir(), 'repo-target-acp');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_acp',
        affinity: {
          backendMode: 'acp',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_acp.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.resume).toMatchObject({
      codexBackendMode: 'acp',
    });
  });

  it('rebuilds connected-service codex source affinity from canonical handoff source data when runtimeDescriptor is omitted', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-source-'));
    const targetPath = join(tmpdir(), 'repo-target-source');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_source',
        affinity: {
          backendMode: 'appServer',
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'primary-pool',
          },
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_source.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.agentRuntimeDescriptorV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_source',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'primary-pool',
        providerExtra: {
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_source',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'primary-pool',
          },
        },
      },
    });
    expect(result.directSource).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'primary-pool',
    });
  });

  it('prefers canonical runtime-descriptor affinity when importing', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-affinity-'));
    const targetPath = join(tmpdir(), 'repo-target-affinity');

    const result = await importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_affinity',
        affinity: {
          backendMode: 'appServer',
          runtimeDescriptor: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'mcp',
              vendorSessionId: 'thread_legacy',
              home: 'user',
              providerExtra: {
                owner: 'codex',
                schemaId: 'codex.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeAffinity: {
                  backendMode: 'appServer',
                  vendorSessionId: 'thread_affinity',
                  home: 'connectedService',
                  connectedServiceId: 'openai-codex',
                },
              },
            },
          },
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_affinity.jsonl',
            contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    });

    expect(result.resume).toMatchObject({
      codexBackendMode: 'appServer',
    });
    expect(result.agentRuntimeDescriptorV1).toMatchObject({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_affinity',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        providerExtra: {
          v: 1,
          runtimeAffinity: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_affinity',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
          },
        },
      },
    });
  });

  it('rejects bundle files that escape the codex home directory', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-reject-'));
    const targetPath = join(tmpdir(), 'repo-target-reject');

    await expect(importCodexSessionBundle({
      bundle: {
        providerId: 'codex',
        remoteSessionId: 'thread_3',
        files: [
          {
            relativePath: '../escaped.txt',
            contentBase64: Buffer.from('oops\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        CODEX_HOME: codexHome,
      },
    })).rejects.toThrow(/CODEX_HOME|outside/i);
  });
});
