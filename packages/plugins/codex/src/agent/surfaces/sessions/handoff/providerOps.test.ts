import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeHandoffSurface } from '@happier-dev/plugin-sdk/agents/runtime';

import { codexHandoffSurface } from './providerOps.js';

function handoffContext(): import('@happier-dev/plugin-sdk').PluginInvocationContext {
  return { signal: new AbortController().signal } as import('@happier-dev/plugin-sdk').PluginInvocationContext;
}

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

describe('codex handoff provider surface', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exports the exact host-admitted Session id instead of a stale generic metadata id', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-export-id-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '22');
    await mkdir(rolloutDir, { recursive: true });
    const content = nativeRolloutContent({ sessionId: 'current-thread', body: { event: 'current' } });
    await writeFile(
      join(rolloutDir, 'rollout-2026-06-22T10-00-00-current-thread.jsonl'),
      content,
    );

    const result = await codexHandoffSurface.exportBundle({
      sessionId: 'current-thread',
      metadata: {
        path: '/repo',
        providerSessionId: 'stale-other-agent-thread',
        codexBackendMode: 'appServer',
      },
      directory: '/active-server',
    }, handoffContext());

    expect(result).toMatchObject({
      ok: true,
      value: {
        bundle: {
          agentId: 'codex',
          remoteSessionId: 'current-thread',
        },
      },
    });
  });

  it('keeps Codex runtime selection in the runtime descriptor on import', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-ops-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const content = nativeRolloutContent({ sessionId: 'thread_surface_1', body: { event: 'surface' } });

    const result = await codexHandoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_surface_1',
        affinity: {
          backendMode: 'appServer',
        },
        files: [
          {
            relativePath: 'sessions/2026/06/22/rollout-2026-06-22T10-00-00-thread_surface_1.jsonl',
            contentBase64: content.toString('base64'),
          },
        ],
      },
    }, handoffContext());

    expect(result).toMatchObject({
      ok: true,
      value: {
        providerSessionId: 'thread_surface_1',
        launch: {
          directory: '/repo',
          environmentVariables: { CODEX_HOME: codexHome },
          sessionStateUpdates: expect.arrayContaining([
            expect.objectContaining({
              fieldId: 'identity.providerSessionId',
              value: 'thread_surface_1',
            }),
          ]),
        },
      },
    });
    if (!result.ok) throw new Error(`Expected successful import, received ${result.code}`);
    expect(result.value).not.toHaveProperty('runtimeDescriptorV1');

    await expect(readFile(
      join(codexHome, 'sessions', '2026', '06', '22', 'rollout-2026-06-22T10-00-00-thread_surface_1.jsonl'),
    )).resolves.toEqual(content);
  });

  it('stops later native writes when the runtime generation retires during a multi-file import', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-retired-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const remoteSessionId = 'thread_retired';
    const firstRelativePath = `sessions/2026/06/22/rollout-2026-06-22T10-00-00-${remoteSessionId}.jsonl`;
    const secondRelativePath = `sessions/2026/06/22/rollout-2026-06-22T10-01-00-${remoteSessionId}.jsonl`;
    const firstPath = join(codexHome, firstRelativePath);
    const secondPath = join(codexHome, secondRelativePath);
    const firstContent = nativeRolloutContent({ sessionId: remoteSessionId, body: { event: 'first' } });
    const secondContent = nativeRolloutContent({
      sessionId: 'thread_retired_sidechain',
      rootSessionId: remoteSessionId,
      body: { event: 'second' },
    });
    const retirementReason = new Error('runtime generation retired');
    const signal = {
      get aborted() {
        return existsSync(firstPath);
      },
      reason: retirementReason,
      throwIfAborted() {
        if (this.aborted) throw this.reason;
      },
    } as AbortSignal;

    const handoffSurface: AgentRuntimeHandoffSurface = codexHandoffSurface;
    const result = await handoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId,
        files: [
          {
            relativePath: firstRelativePath,
            contentBase64: firstContent.toString('base64'),
          },
          {
            relativePath: secondRelativePath,
            contentBase64: secondContent.toString('base64'),
          },
        ],
      },
    }, { signal } as import('@happier-dev/plugin-sdk').PluginInvocationContext);

    expect(signal.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      code: 'target_import_failed',
      message: 'runtime generation retired',
    });
    await expect(readFile(firstPath)).resolves.toEqual(firstContent);
    await expect(access(secondPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects retired top-level runtime affinity fields before writing bundle files', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-invalid-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const relativePath = 'sessions/2026/06/22/rollout-invalid.jsonl';
    const content = nativeRolloutContent({ sessionId: 'thread_invalid', body: { event: 'invalid' } });

    const result = await codexHandoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_invalid',
        codexBackendMode: 'appServer',
        files: [{
          relativePath,
          contentBase64: content.toString('base64'),
        }],
      },
    }, handoffContext());

    expect(result).toMatchObject({
      ok: false,
      code: 'bundle_invalid',
    });
    await expect(readFile(join(codexHome, relativePath), 'utf8')).rejects.toThrow();
  });

  it('returns bundle_invalid for a semantic non-rollout bundle before creating CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-semantic-invalid-'));
    const codexHome = join(root, 'missing-codex-home');
    vi.stubEnv('CODEX_HOME', codexHome);

    const result = await codexHandoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_semantic_invalid',
        files: [{
          relativePath: 'config.toml',
          contentBase64: Buffer.from('notify = []\n', 'utf8').toString('base64'),
        }],
      },
    }, handoffContext());

    expect(result).toMatchObject({ ok: false, code: 'bundle_invalid' });
    await expect(access(codexHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns the shared target identity conflict code without mutating a mixed destination', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-conflict-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '22');
    const missingRelativePath = 'sessions/2026/06/22/rollout-missing.jsonl';
    const divergentRelativePath = 'sessions/2026/06/22/rollout-divergent.jsonl';
    const divergentPath = join(codexHome, divergentRelativePath);
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
    await writeFile(divergentPath, existingDivergentContent);

    const result = await codexHandoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_conflict',
        files: [
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
    }, handoffContext());

    expect(result).toMatchObject({
      ok: false,
      code: 'target_identity_conflict',
      retryable: false,
    });
    await expect(access(join(codexHome, missingRelativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(divergentPath)).resolves.toEqual(existingDivergentContent);
  });

  it('serializes divergent multi-file imports for one native session without leaving a hybrid target', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-native-race-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const remoteSessionId = '019c5b0c-b765-72e0-b799-6eca4714a46b';
    const firstFiles = [
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T10-00-00-${remoteSessionId}.jsonl`,
        content: nativeRolloutContent({ sessionId: remoteSessionId, body: { event: 'first-main' } }),
      },
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T10-01-00-${remoteSessionId}.jsonl`,
        content: nativeRolloutContent({
          sessionId: `${remoteSessionId}-first-sidechain`,
          rootSessionId: remoteSessionId,
          body: { event: 'first-side' },
        }),
      },
    ];
    const secondFiles = [
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T11-01-00-${remoteSessionId}.jsonl`,
        content: nativeRolloutContent({
          sessionId: `${remoteSessionId}-second-sidechain`,
          rootSessionId: remoteSessionId,
          body: { event: 'second-side' },
        }),
      },
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T11-00-00-${remoteSessionId}.jsonl`,
        content: nativeRolloutContent({ sessionId: remoteSessionId, body: { event: 'second-main' } }),
      },
    ];
    const toBundleFiles = (files: typeof firstFiles) => files.map((file) => ({
      relativePath: file.relativePath,
      contentBase64: file.content.toString('base64'),
    }));

    const results = await Promise.all([
      codexHandoffSurface.importBundle({
        targetDirectory: '/repo',
        bundle: {
          agentId: 'codex',
          remoteSessionId,
          files: toBundleFiles(firstFiles),
        },
      }, handoffContext()),
      codexHandoffSurface.importBundle({
        targetDirectory: '/repo',
        bundle: {
          agentId: 'codex',
          remoteSessionId,
          files: toBundleFiles(secondFiles),
        },
      }, handoffContext()),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        ok: false,
        code: 'target_identity_conflict',
      }),
    ]);
    const winnerFiles = results[0]?.ok ? firstFiles : secondFiles;
    const loserFiles = results[0]?.ok ? secondFiles : firstFiles;
    for (const file of winnerFiles) {
      await expect(readFile(join(codexHome, file.relativePath))).resolves.toEqual(file.content);
    }
    for (const file of loserFiles) {
      await expect(access(join(codexHome, file.relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
