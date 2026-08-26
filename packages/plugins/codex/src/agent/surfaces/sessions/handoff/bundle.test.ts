import { access, mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeCodexHandoffBundleRelativePath } from './bundle.js';
import { exportCodexSessionBundle } from './export.js';
import { importCodexSessionBundle } from './import.js';
import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';

function nativeRolloutContent(params: Readonly<{
  sessionId: string;
  rootSessionId?: string;
  body?: unknown;
}>): Buffer {
  return Buffer.from([
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: params.sessionId,
        ...(params.rootSessionId === undefined ? {} : { session_id: params.rootSessionId }),
      },
    }),
    ...(params.body === undefined ? [] : [JSON.stringify(params.body)]),
    '',
  ].join('\n'), 'utf8');
}

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
    const content = nativeRolloutContent({ sessionId: 'thread_1', body: { event: 'hello' } });
    await writeFile(rolloutPath, content);

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_1',
        }),
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
        contentBase64: content.toString('base64'),
      },
    ]);
    expect('codexBackendMode' in result).toBe(false);
  });

  it('exports rollout files as raw bytes without UTF-8 re-encoding', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-bytes-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    const rolloutPath = join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_bytes.jsonl');
    const bytes = Buffer.concat([
      nativeRolloutContent({ sessionId: 'thread_bytes' }),
      Buffer.from([0xff, 0x00, 0x61, 0x62, 0x80]),
    ]);
    await writeFile(rolloutPath, bytes);

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_bytes',
        }),
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

  it('exports the native root rollout together with its sidechain family', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-root-family-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '08', '25');
    const rootRelativePath = 'sessions/2026/08/25/rollout-2026-08-25T10-00-00-thread-root.jsonl';
    const sidechainRelativePath = 'sessions/2026/08/25/rollout-2026-08-25T10-01-00-thread-sidechain.jsonl';
    const rootContent = nativeRolloutContent({ sessionId: 'thread-root', body: { event: 'root' } });
    const sidechainContent = nativeRolloutContent({
      sessionId: 'thread-sidechain',
      rootSessionId: 'thread-root',
      body: { event: 'sidechain' },
    });
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(join(codexHome, rootRelativePath), rootContent);
    await writeFile(join(codexHome, sidechainRelativePath), sidechainContent);

    await expect(exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread-root',
        }),
      },
      remoteSessionId: 'thread-root',
      env: { CODEX_HOME: codexHome },
      activeServerDir: '/active-server',
    })).resolves.toMatchObject({
      files: expect.arrayContaining([
        { relativePath: rootRelativePath, contentBase64: rootContent.toString('base64') },
        { relativePath: sidechainRelativePath, contentBase64: sidechainContent.toString('base64') },
      ]),
    });
  });

  it('exports legacy mcp affinity as null instead of writing an invalid handoff backend mode', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-mcp-'));
    const rolloutDir = join(codexHome, 'sessions', '2026', '03', '08');
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_mcp.jsonl'),
      nativeRolloutContent({ sessionId: 'thread_mcp', body: { event: 'hello' } }),
    );

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
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
    const content = nativeRolloutContent({ sessionId: 'thread_connected', body: { event: 'hello-connected' } });
    await writeFile(rolloutPath, content);

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_connected',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        }),
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
        contentBase64: content.toString('base64'),
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
    await writeFile(
      join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_runtime.jsonl'),
      nativeRolloutContent({ sessionId: 'thread_runtime', body: { event: 'hello' } }),
    );

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
        }),
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

  it('does not interpret legacy descriptor metadata at the plugin boundary', async () => {
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
    await writeFile(
      join(userRolloutDir, 'rollout-2026-03-08T10-00-00-thread_runtime_only.jsonl'),
      nativeRolloutContent({ sessionId: 'thread_runtime_only', body: { event: 'hello-runtime-source' } }),
    );

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
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
    expect(result.affinity?.runtimeDescriptor).toBeUndefined();
  });

  it('does not export machine-specific typed Codex source home paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-homepath-'));
    const userCodexHome = join(root, 'user-codex-home');
    const sourceCodexHome = join(root, 'source-machine-codex-home');
    const rolloutDir = join(sourceCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(userCodexHome, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(
      join(rolloutDir, 'rollout-2026-03-08T10-00-00-thread_homepath.jsonl'),
      nativeRolloutContent({ sessionId: 'thread_homepath', body: { event: 'hello-homepath' } }),
    );

    const result = await exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_homepath',
        }),
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

  it('refuses to export a same-id rollout from the caller environment home when the linked source home has none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-exclusive-'));
    const environmentCodexHome = join(root, 'environment-codex-home');
    const linkedSourceCodexHome = join(root, 'linked-source-codex-home');
    const environmentRolloutDir = join(environmentCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(environmentRolloutDir, { recursive: true });
    // The linked source home exists but holds no rollout for this id; the
    // caller environment home holds a DIFFERENT session that happens to share it.
    await mkdir(linkedSourceCodexHome, { recursive: true });
    await writeFile(
      join(environmentRolloutDir, 'rollout-2026-03-08T10-00-00-thread_exclusive.jsonl'),
      '{"event":"other-home"}\n',
      'utf8',
    );

    await expect(exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_exclusive',
        }),
        externalSessionSource: {
          kind: 'codexHome',
          home: 'user',
          homePath: linkedSourceCodexHome,
        },
      },
      remoteSessionId: 'thread_exclusive',
      env: {
        CODEX_HOME: environmentCodexHome,
      },
      activeServerDir: join(root, 'servers', 'cloud'),
    })).rejects.toThrow(/thread_exclusive/);
  });

  it('fails typed instead of falling back when the linked connected-service source home does not resolve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-export-unresolvable-'));
    const environmentCodexHome = join(root, 'environment-codex-home');
    const environmentRolloutDir = join(environmentCodexHome, 'sessions', '2026', '03', '08');
    await mkdir(environmentRolloutDir, { recursive: true });
    await writeFile(
      join(environmentRolloutDir, 'rollout-2026-03-08T10-00-00-thread_unresolvable.jsonl'),
      '{"event":"other-home"}\n',
      'utf8',
    );

    await expect(exportCodexSessionBundle({
      metadata: {
        path: '/repo',
        runtimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
          backendMode: 'appServer',
          providerSessionId: 'thread_unresolvable',
        }),
        externalSessionSource: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-missing',
        },
      },
      remoteSessionId: 'thread_unresolvable',
      env: {
        CODEX_HOME: environmentCodexHome,
      },
      activeServerDir: join(root, 'servers', 'cloud'),
    })).rejects.toThrow(/thread_unresolvable/);
  });

  it('imports rollout files into the target codex home and returns resume metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-'));
    const targetPath = join(tmpdir(), 'repo-target');
    const content = nativeRolloutContent({ sessionId: 'thread_1', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
        CODEX_SQLITE_HOME: codexHome,
      },
      resumePlanOptions: { codexBackendMode: 'appServer' },
    });

    const importedPath = join(codexHome, 'sessions', '2026', '03', '08', 'rollout-2026-03-08T10-00-00-thread_1.jsonl');
    await expect(readFile(importedPath)).resolves.toEqual(content);
  });

  it('rejects empty, non-rollout, and foreign-session bundles before creating CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-grammar-'));

    const cases: readonly Readonly<{
      name: string;
      remoteSessionId: string;
      files: readonly Readonly<{ relativePath: string; contentBase64: string }>[];
    }>[] = [
      {
        name: 'empty bundle',
        remoteSessionId: 'thread-empty',
        files: [],
      },
      {
        name: 'non-rollout file',
        remoteSessionId: 'thread-config',
        files: [{
          relativePath: 'config.toml',
          contentBase64: Buffer.from('notify = []\n', 'utf8').toString('base64'),
        }],
      },
      {
        name: 'foreign rollout',
        remoteSessionId: 'thread-target',
        files: [{
          relativePath: 'sessions/2026/08/25/rollout-foreign.jsonl',
          contentBase64: nativeRolloutContent({ sessionId: 'thread-foreign' }).toString('base64'),
        }],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const codexHome = join(root, `codex-home-${index}`);
      await expect(importCodexSessionBundle({
        bundle: {
          agentId: 'codex',
          remoteSessionId: testCase.remoteSessionId,
          files: testCase.files,
        },
        targetPath: '/repo-target',
        env: { CODEX_HOME: codexHome },
      }), testCase.name).rejects.toThrow();
      await expect(access(codexHome)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('imports a root rollout with its native sidechain family', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-root-family-'));
    const rootRelativePath = 'sessions/2026/08/25/rollout-root.jsonl';
    const sidechainRelativePath = 'sessions/2026/08/25/rollout-sidechain.jsonl';
    const rootContent = nativeRolloutContent({
      sessionId: 'thread-root',
      body: { type: 'response_item', payload: { type: 'message' } },
    });
    const sidechainContent = nativeRolloutContent({
      sessionId: 'thread-sidechain',
      rootSessionId: 'thread-root',
      body: { type: 'response_item', payload: { type: 'message' } },
    });

    await expect(importCodexSessionBundle({
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread-root',
        files: [
          { relativePath: rootRelativePath, contentBase64: rootContent.toString('base64') },
          { relativePath: sidechainRelativePath, contentBase64: sidechainContent.toString('base64') },
        ],
      },
      targetPath: '/repo-target',
      env: { CODEX_HOME: codexHome },
    })).resolves.toMatchObject({ remoteSessionId: 'thread-root' });

    await expect(readFile(join(codexHome, rootRelativePath))).resolves.toEqual(rootContent);
    await expect(readFile(join(codexHome, sidechainRelativePath))).resolves.toEqual(sidechainContent);
  });

  it('accepts an already-identical rollout without rewriting it', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-identical-'));
    const relativePath = 'sessions/2026/03/08/rollout-2026-03-08T10-00-00-thread_identical.jsonl';
    const importedPath = join(codexHome, relativePath);
    const content = nativeRolloutContent({ sessionId: 'thread_identical', body: { event: 'identical' } });
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
    const equalContent = nativeRolloutContent({ sessionId: 'thread_conflict', body: { event: 'equal' } });
    const existingDivergentContent = nativeRolloutContent({
      sessionId: 'thread_conflict',
      body: { event: 'existing' },
    });
    const missingContent = nativeRolloutContent({ sessionId: 'thread_conflict', body: { event: 'missing' } });
    const incomingDivergentContent = nativeRolloutContent({
      sessionId: 'thread_conflict',
      body: { event: 'incoming' },
    });
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
            contentBase64: missingContent.toString('base64'),
          },
          {
            relativePath: divergentRelativePath,
            contentBase64: incomingDivergentContent.toString('base64'),
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
    const existingContent = nativeRolloutContent({ sessionId: 'thread_retry', body: { event: 'existing' } });
    const missingContent = nativeRolloutContent({ sessionId: 'thread_retry', body: { event: 'retry' } });
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
    const content = nativeRolloutContent({ sessionId: 'thread_race', body: { event: 'race' } });
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
    const firstContent = nativeRolloutContent({
      sessionId: 'thread_divergent_race',
      body: { event: 'first' },
    });
    const secondContent = nativeRolloutContent({
      sessionId: 'thread_divergent_race',
      body: { event: 'second' },
    });
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
    const content = nativeRolloutContent({ sessionId: 'thread_home_tilde', body: { event: 'tilde' } });

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
            contentBase64: content.toString('base64'),
          },
        ],
      },
      targetPath,
      env: {
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: '~/target-codex',
        CODEX_SQLITE_HOME: '~/target-codex-state',
      },
    });

    const codexHome = join(homeDir, 'target-codex');
    expect(result.externalSource).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: codexHome,
    });
    expect(result.resume.environmentVariables).toEqual({
      CODEX_HOME: codexHome,
      CODEX_SQLITE_HOME: join(homeDir, 'target-codex-state'),
    });
    await expect(readFile(
      join(codexHome, 'sessions', '2026', '03', '08', 'rollout-2026-03-08T10-00-00-thread_home_tilde.jsonl'),
    )).resolves.toEqual(content);
  });

  it('imports a Windows-source rollout path into the portable target hierarchy', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-windows-path-'));
    const content = nativeRolloutContent({ sessionId: 'thread_portable', body: { event: 'portable' } });
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

  it('rejects a rollout outside the canonical native directory roots before creating CODEX_HOME', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-dot-dot-prefix-'));
    const content = nativeRolloutContent({
      sessionId: 'thread_dot_dot_prefix',
      body: { event: 'dot-dot-prefix' },
    });

    await expect(importCodexSessionBundle({
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
    })).rejects.toThrow(/canonical rollout/i);

    await expect(access(join(codexHome, '..build', 'rollout-dot-dot-prefix.jsonl')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not import source-machine codex homePath affinity into the target runtime descriptor', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-import-homepath-'));
    const targetPath = join(tmpdir(), 'repo-target-homepath');
    const sourceCodexHome = join(tmpdir(), 'source-machine-codex-home');
    const content = nativeRolloutContent({ sessionId: 'thread_homepath', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
    const content = nativeRolloutContent({ sessionId: 'thread_connected', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
    const content = nativeRolloutContent({ sessionId: 'thread_2', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
    const content = nativeRolloutContent({ sessionId: 'thread_acp', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
    const content = nativeRolloutContent({ sessionId: 'thread_source', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
    const content = nativeRolloutContent({ sessionId: 'thread_affinity', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
    const content = nativeRolloutContent({ sessionId: 'thread_mcp_import', body: { event: 'hello' } });

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
            contentBase64: content.toString('base64'),
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
