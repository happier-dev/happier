import { mkdtemp, readFile } from 'node:fs/promises';
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
});
