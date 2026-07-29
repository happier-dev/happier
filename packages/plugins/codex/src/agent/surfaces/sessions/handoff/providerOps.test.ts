import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexHandoffSurface } from './providerOps.js';

describe('codex handoff provider surface', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits codexBackendMode as provider-owned resume plan options on import', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-ops-'));
    vi.stubEnv('CODEX_HOME', codexHome);

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
            contentBase64: Buffer.from('{"event":"surface"}\n', 'utf8').toString('base64'),
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        providerSessionId: 'thread_surface_1',
        launch: {
          directory: '/repo',
          environmentVariables: { CODEX_HOME: codexHome },
          resumePlanOptions: {
            codexBackendMode: 'appServer',
          },
          sessionStateUpdates: expect.arrayContaining([
            expect.objectContaining({
              fieldId: 'identity.providerSessionId',
              value: 'thread_surface_1',
            }),
          ]),
        },
      },
    });

    await expect(readFile(
      join(codexHome, 'sessions', '2026', '06', '22', 'rollout-2026-06-22T10-00-00-thread_surface_1.jsonl'),
      'utf8',
    )).resolves.toBe('{"event":"surface"}\n');
  });

  it('rejects retired top-level runtime affinity fields before writing bundle files', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-invalid-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const relativePath = 'sessions/2026/06/22/rollout-invalid.jsonl';

    const result = await codexHandoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_invalid',
        codexBackendMode: 'appServer',
        files: [{
          relativePath,
          contentBase64: Buffer.from('{"event":"invalid"}\n', 'utf8').toString('base64'),
        }],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'bundle_invalid',
    });
    await expect(readFile(join(codexHome, relativePath), 'utf8')).rejects.toThrow();
  });

  it('returns the shared target identity conflict code without mutating a mixed destination', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-conflict-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const rolloutDir = join(codexHome, 'sessions', '2026', '06', '22');
    const missingRelativePath = 'sessions/2026/06/22/rollout-missing.jsonl';
    const divergentRelativePath = 'sessions/2026/06/22/rollout-divergent.jsonl';
    const divergentPath = join(codexHome, divergentRelativePath);
    await mkdir(rolloutDir, { recursive: true });
    await writeFile(divergentPath, '{"event":"existing"}\n', 'utf8');

    const result = await codexHandoffSurface.importBundle({
      targetDirectory: '/repo',
      bundle: {
        agentId: 'codex',
        remoteSessionId: 'thread_conflict',
        files: [
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
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'target_identity_conflict',
      retryable: false,
    });
    await expect(access(join(codexHome, missingRelativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(divergentPath, 'utf8')).resolves.toBe('{"event":"existing"}\n');
  });

  it('serializes divergent multi-file imports for one native session without leaving a hybrid target', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-provider-native-race-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    const remoteSessionId = '019c5b0c-b765-72e0-b799-6eca4714a46b';
    const firstFiles = [
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T10-00-00-${remoteSessionId}.jsonl`,
        content: Buffer.from('{"event":"first-main"}\n', 'utf8'),
      },
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T10-01-00-${remoteSessionId}.jsonl`,
        content: Buffer.from('{"event":"first-side"}\n', 'utf8'),
      },
    ];
    const secondFiles = [
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T11-01-00-${remoteSessionId}.jsonl`,
        content: Buffer.from('{"event":"second-side"}\n', 'utf8'),
      },
      {
        relativePath: `sessions/2026/06/22/rollout-2026-06-22T11-00-00-${remoteSessionId}.jsonl`,
        content: Buffer.from('{"event":"second-main"}\n', 'utf8'),
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
      }),
      codexHandoffSurface.importBundle({
        targetDirectory: '/repo',
        bundle: {
          agentId: 'codex',
          remoteSessionId,
          files: toBundleFiles(secondFiles),
        },
      }),
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
