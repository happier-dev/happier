import { access, mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeCodexHandoffBundleRelativePath } from './bundle.js';
import { exportCodexSessionBundle } from './export.js';
import { importCodexSessionBundle } from './import.js';

describe('codex session handoff bundle', () => {
  it('encodes source-native rollout paths as portable bundle paths', () => {
    expect(normalizeCodexHandoffBundleRelativePath(
      'sessions\\2026\\03\\08\\rollout-portable.jsonl',
    )).toBe('sessions/2026/03/08/rollout-portable.jsonl');

    for (const unsafePath of [
      '/sessions/rollout.jsonl',
      '\\\\server\\share\\rollout.jsonl',
      'C:\\sessions\\rollout.jsonl',
      'C:sessions\\rollout.jsonl',
      '..\\escaped.jsonl',
    ]) {
      expect(() => normalizeCodexHandoffBundleRelativePath(unsafePath)).toThrow();
    }
  });

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

    expect(result.agentId).toBe('codex');
    expect(result.remoteSessionId).toBe('thread_1');
    expect(result.affinity).toMatchObject({
      backendMode: 'appServer',
      runtimeDescriptor: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread_1',
        },
      },
    });
    expect(result.files).toEqual([
      {
        relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_1.jsonl',
        contentBase64: Buffer.from('{"event":"hello"}\n', 'utf8').toString('base64'),
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
        contentBase64: bytes.toString('base64'),
      },
    ]);
  });

  it('exports legacy mcp affinity as null instead of writing an invalid handoff backend mode', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-mcp-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_mcp.jsonl'), '{"event":"hello"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_mcp',
        codexBackendMode: 'mcp',
      },
      remoteSessionId: 'thread_mcp',
      env: {
        CODEX_HOME: codexHome,
      },
      activeServerDir: '/active-server',
    });

    expect(result.affinity).toEqual({
      backendMode: null,
    });
  });

  it('exports rollout files from the typed linked connected-service Codex home', async () => {
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
        externalSessionSource: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
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
        contentBase64: Buffer.from('{"event":"hello-connected"}\n', 'utf8').toString('base64'),
      },
    ]);
    expect(result.affinity).toMatchObject({
      backendMode: 'appServer',
      runtimeDescriptor: {
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread_connected',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
    });
    expect(result.affinity?.source).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
    });
  });

  it('rebuilds a sanitized Codex runtime descriptor from the typed handoff metadata', async () => {
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
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'group-1',
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
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_runtime',
        agentExtra: {
          owner: 'codex',
          schemaId: 'codex.agentRuntimeDescriptorExtra',
          v: 1,
        },
      },
    });
  });

  it('ignores cast-injected raw runtime descriptor metadata at the plugin boundary', async () => {
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
    const userRolloutDir = join(userCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(userRolloutDir, { recursive: true });
    await mkdir(connectedCodexHome, { recursive: true });
    await writeFile(join(userRolloutDir, 'rollout-2026-03-08T10-00-00-thread_runtime_only.jsonl'), '{"event":"hello-runtime-source"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_runtime_only',
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime_only',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'profile-1',
            connectedServiceGroupId: 'group-1',
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

    expect(result.affinity?.source).toBeUndefined();
    expect(result.affinity?.runtimeDescriptor).toMatchObject({
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_runtime_only',
      },
    });
    expect(result.affinity?.runtimeDescriptor).not.toMatchObject({
      agent: { home: 'connectedService' },
    });
  });

  it('does not export machine-specific typed Codex source home paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-homepath-'));
    const userCodexHome = join(root, 'user-codex-home');
    const sourceCodexHome = join(root, 'source-machine-codex-home');
    const rolloutDir = join(userCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(sourceCodexHome, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_homepath.jsonl'), '{"event":"hello-homepath"}\n', 'utf8');

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        codexSessionId: 'thread_homepath',
        codexBackendMode: 'appServer',
        externalSessionSource: {
          kind: 'codexHome',
          home: 'user',
          homePath: sourceCodexHome,
        },
      },
      remoteSessionId: 'thread_homepath',
      env: {
        CODEX_HOME: userCodexHome,
      },
      activeServerDir: join(root, 'servers', 'cloud'),
    });

    expect(result.affinity?.source).toEqual({ kind: 'codexHome', home: 'user' });
    const exportedHomePath = (result.affinity?.runtimeDescriptor?.provider as unknown as { homePath?: unknown } | undefined)?.homePath;
    expect(typeof exportedHomePath).not.toBe('string');
    expect(exportedHomePath ?? null).toBeNull();
  });

  it('imports rollout files into the target codex home and returns resume metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-'));
    const targetPath = join(tmpdir(), 'repo-target');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
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
    expect(result.externalSource).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: codexHome,
    });
    expect(result.resume).toEqual({
      directory: targetPath,
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
      resumePlanOptions: { codexBackendMode: 'appServer' },
    });

    const importedPath = join(codexHome, 'sessions', '2026', '03', '08', 'rollout-2026-03-08T10-00-00-thread_1.jsonl');
    await expect(readFile(importedPath, 'utf8')).resolves.toBe('{"event":"hello"}\n');
  });

  it('accepts an already-identical rollout without rewriting it', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-identical-'));
    const relativePath = 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_identical.jsonl';
    const importedPath = join(codexHome, relativePath);
    const content = Buffer.from('{"event":"identical"}\n', 'utf8');
    await mkdir(join(codexHome, 'sessions', '2026', '03', '08'), { recursive: true });
    await writeFile(importedPath, content);
    await utimes(importedPath, new Date(1_000), new Date(1_000));
    const before = await stat(importedPath);

    await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_identical',
        files: [{
          relativePath,
          contentBase64: content.toString('base64'),
        }],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    });

    const after = await stat(importedPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(readFile(importedPath)).resolves.toEqual(content);
  });

  it('rejects mixed equal, divergent, and missing rollouts before creating or rewriting any file', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-conflict-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    const equalRelativePath = 'sessions/2026/03/08/rollout-equal.jsonl';
    const missingRelativePath = 'sessions/2026/03/08/rollout-missing.jsonl';
    const divergentRelativePath = 'sessions/2026/03/08/rollout-divergent.jsonl';
    const equalPath = join(codexHome, equalRelativePath);
    const missingPath = join(codexHome, missingRelativePath);
    const divergentPath = join(codexHome, divergentRelativePath);
    const equalContent = Buffer.from('{"event":"equal"}\n', 'utf8');
    const existingDivergentContent = Buffer.from('{"event":"existing"}\n', 'utf8');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(equalPath, equalContent);
    await writeFile(divergentPath, existingDivergentContent);
    await utimes(equalPath, new Date(1_000), new Date(1_000));
    await utimes(divergentPath, new Date(2_000), new Date(2_000));
    const equalBefore = await stat(equalPath);
    const divergentBefore = await stat(divergentPath);

    await expect(importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_conflict',
        files: [
          {
            relativePath: equalRelativePath,
            contentBase64: equalContent.toString('base64'),
          },
          {
            relativePath: missingRelativePath,
            contentBase64: Buffer.from('{"event":"missing"}\n', 'utf8').toString('base64'),
          },
          {
            relativePath: divergentRelativePath,
            contentBase64: Buffer.from('{"event":"incoming"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    })).rejects.toMatchObject({
      code: 'target_identity_conflict',
    });

    expect((await stat(equalPath)).mtimeMs).toBe(equalBefore.mtimeMs);
    expect((await stat(divergentPath)).mtimeMs).toBe(divergentBefore.mtimeMs);
    await expect(readFile(equalPath)).resolves.toEqual(equalContent);
    await expect(readFile(divergentPath)).resolves.toEqual(existingDivergentContent);
    await expect(access(missingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converges a partial equal-plus-missing retry and then performs no rewrites', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-retry-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    const existingRelativePath = 'sessions/2026/03/08/rollout-existing.jsonl';
    const missingRelativePath = 'sessions/2026/03/08/rollout-retry.jsonl';
    const existingPath = join(codexHome, existingRelativePath);
    const missingPath = join(codexHome, missingRelativePath);
    const existingContent = Buffer.from('{"event":"existing"}\n', 'utf8');
    const missingContent = Buffer.from('{"event":"retry"}\n', 'utf8');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(existingPath, existingContent);
    await utimes(existingPath, new Date(1_000), new Date(1_000));
    const bundle = {
      agentId: 'codex' as const,
      remoteSessionId: 'thread_retry',
      files: [
        {
          relativePath: existingRelativePath,
          contentBase64: existingContent.toString('base64'),
        },
        {
          relativePath: missingRelativePath,
          contentBase64: missingContent.toString('base64'),
        },
      ],
    };

    await importCodexSessionBundle({
      bundle,
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    });

    expect((await stat(existingPath)).mtimeMs).toBe(1_000);
    await expect(readFile(missingPath)).resolves.toEqual(missingContent);
    const missingBeforeRetry = await stat(missingPath);

    await importCodexSessionBundle({
      bundle,
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    });

    expect((await stat(existingPath)).mtimeMs).toBe(1_000);
    expect((await stat(missingPath)).mtimeMs).toBe(missingBeforeRetry.mtimeMs);
  });

  it('converges concurrent identical imports through exclusive same-path creation', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-race-'));
    const relativePath = 'sessions/2026/03/08/rollout-race.jsonl';
    const content = Buffer.from('{"event":"race"}\n', 'utf8');
    const params = {
      bundle: {
        agentId: 'codex' as const,
        remoteSessionId: 'thread_race',
        files: [{
          relativePath,
          contentBase64: content.toString('base64'),
        }],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    };

    const results = await Promise.allSettled([
      importCodexSessionBundle(params),
      importCodexSessionBundle(params),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(readFile(join(codexHome, relativePath))).resolves.toEqual(content);
  });

  it('never overwrites the winner of a divergent same-path creation race', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-divergent-race-'));
    const relativePath = 'sessions/2026/03/08/rollout-divergent-race.jsonl';
    const firstContent = Buffer.from('{"event":"first"}\n', 'utf8');
    const secondContent = Buffer.from('{"event":"second"}\n', 'utf8');
    const createParams = (content: Buffer) => ({
      bundle: {
        agentId: 'codex' as const,
        remoteSessionId: 'thread_divergent_race',
        files: [{
          relativePath,
          contentBase64: content.toString('base64'),
        }],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    });

    const results = await Promise.allSettled([
      importCodexSessionBundle(createParams(firstContent)),
      importCodexSessionBundle(createParams(secondContent)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'target_identity_conflict' });
    const persisted = await readFile(join(codexHome, relativePath));
    expect(persisted.equals(firstContent) || persisted.equals(secondContent)).toBe(true);
  });

  it('imports rollout files into CODEX_HOME expanded from the caller environment home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-home-'));
    const targetPath = join(tmpdir(), 'repo-target-home');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_home_tilde',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_home_tilde.jsonl',
            contentBase64: Buffer.from('{"event":"tilde"}\n', 'utf8').toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: '~/target-codex',
      },
    });

    const codexHome = join(homeDir, 'target-codex');
    expect(result.externalSource).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: codexHome,
    });
    expect(result.resume.environmentVariables).toEqual({ CODEX_HOME: codexHome });
    await expect(readFile(
      join(codexHome, 'sessions', '2026', '03', '08', 'rollout-2026-03-08T10-00-00-thread_home_tilde.jsonl'),
      'utf8',
    )).resolves.toBe('{"event":"tilde"}\n');
  });

  it('imports a Windows-source rollout path into the portable target hierarchy', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-windows-path-'));
    const content = Buffer.from('{"event":"portable"}\n', 'utf8');
    const portableRelativePath = 'sessions/2026/03/08/rollout-portable.jsonl';
    const windowsRelativePath = portableRelativePath.replaceAll('/', '\\');

    await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_portable',
        files: [{
          relativePath: windowsRelativePath,
          contentBase64: content.toString('base64'),
        }],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    });

    await expect(readFile(join(codexHome, ...portableRelativePath.split('/')))).resolves.toEqual(content);
    if (process.platform !== 'win32') {
      await expect(access(join(codexHome, windowsRelativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('imports a rollout below a dot-dot-prefixed directory without treating it as traversal', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-dot-dot-prefix-'));
    const content = Buffer.from('{"event":"dot-dot-prefix"}\n', 'utf8');

    await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_dot_dot_prefix',
        files: [{
          relativePath: '..build/rollout-dot-dot-prefix.jsonl',
          contentBase64: content.toString('base64'),
        }],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    });

    await expect(readFile(join(codexHome, '..build', 'rollout-dot-dot-prefix.jsonl')))
      .resolves.toEqual(content);
  });

  it('does not import source-machine codex homePath affinity into the target runtime descriptor', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-homepath-'));
    const targetPath = join(tmpdir(), 'repo-target-homepath');
    const sourceCodexHome = join(tmpdir(), 'source-machine-codex-home');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
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
            agentId: 'codex',
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'thread_homepath',
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

    expect(result.externalSource).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: codexHome,
    });
    expect(result.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: {
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
        agentId: 'codex',
        remoteSessionId: 'thread_connected',
        affinity: {
          backendMode: 'appServer',
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'group-1',
            homePath: '/source-machine/codex-home',
          },
          runtimeDescriptor: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'thread_connected',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
              connectedServiceGroupId: 'group-1',
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

    expect(result.externalSource).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'group-1',
    });
    expect(result.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_connected',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'group-1',
        homePath: codexHome,
      },
    });
  });

  it('returns author-safe launch hints for imported sessions', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-persisted-'));
    const targetPath = join(tmpdir(), 'repo-target-persisted');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
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
    });

    expect(result.resume).toMatchObject({
      directory: targetPath,
      environmentVariables: {
        CODEX_HOME: codexHome,
      },
      resumePlanOptions: { codexBackendMode: 'appServer' },
    });
  });

  it('preserves ACP backend affinity when importing an ACP handoff bundle', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-acp-'));
    const targetPath = join(tmpdir(), 'repo-target-acp');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
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
      resumePlanOptions: { codexBackendMode: 'acp' },
    });
  });

  it('rebuilds connected-service codex source affinity from canonical handoff source data when runtimeDescriptor is omitted', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-source-'));
    const targetPath = join(tmpdir(), 'repo-target-source');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_source',
        affinity: {
          backendMode: 'appServer',
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'group-1',
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

    expect(result.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_source',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'group-1',
        homePath: codexHome,
      },
    });
    expect(result.externalSource).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'group-1',
    });
  });

  it('prefers canonical runtime-descriptor affinity when importing', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-affinity-'));
    const targetPath = join(tmpdir(), 'repo-target-affinity');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_affinity',
        affinity: {
          backendMode: 'appServer',
          runtimeDescriptor: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'mcp',
              providerSessionId: 'thread_legacy',
              home: 'user',
              agentExtra: {
                owner: 'codex',
                schemaId: 'codex.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeAffinity: {
                  backendMode: 'appServer',
                  providerSessionId: 'thread_affinity',
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
      resumePlanOptions: { codexBackendMode: 'appServer' },
    });
    expect(result.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_affinity',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        homePath: codexHome,
      },
    });
  });

  it('imports legacy mcp handoff affinity as app-server resume metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-mcp-'));
    const targetPath = join(tmpdir(), 'repo-target-mcp');

    const result = await importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_mcp_import',
        affinity: {
          backendMode: 'mcp' as never,
        },
        files: [
          {
            relativePath: 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_mcp_import.jsonl',
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
      resumePlanOptions: { codexBackendMode: 'appServer' },
    });
    expect(result.runtimeDescriptorV1).toMatchObject({
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread_mcp_import',
      },
    });
  });

  it('rejects bundle files that escape the codex home directory', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-reject-'));
    const targetPath = join(tmpdir(), 'repo-target-reject');

    await expect(importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
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

    await expect(importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_3_windows',
        files: [
          {
            relativePath: '..\\escaped.txt',
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
