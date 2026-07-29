import { rmSync } from 'node:fs';
import { basename, delimiter } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildKimiAcpArgv, buildKimiAcpEnv } from './callbacks.js';

function collectKimiShimDir(env: Readonly<Record<string, string>> | undefined): string | null {
  const firstPythonPathEntry = env?.PYTHONPATH?.split(delimiter)[0];
  if (!firstPythonPathEntry || !basename(firstPythonPathEntry).startsWith('kimi-acp-poll-selector-')) {
    return null;
  }
  return firstPythonPathEntry;
}

describe('Kimi ACP callbacks', () => {
  it('maps the canonical yolo permission intent into Kimi argv', () => {
    expect(buildKimiAcpArgv({
      baseArgs: ['--model', 'kimi-k2'],
      cwd: '/workspace',
      permissionIntent: 'yolo',
    })).toEqual([
      '--work-dir',
      '/workspace',
      '--yolo',
      '--model',
      'kimi-k2',
    ]);
  });

  it('normalizes mixed-case Python selector env values through the callback env builder', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const envs: Array<Readonly<Record<string, string>> | undefined> = [];

    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    try {
      for (const selector of ['poll', 'POLL', ' PoLl ']) {
        const env = buildKimiAcpEnv({
          launchEnvironment: {
            values: {
              HAPPIER_KIMI_ACP_SELECTOR: selector,
              PYTHONPATH: '/existing',
            },
            unset: [],
          },
        });
        envs.push(env);
      }

      for (const env of envs) {
        expect(collectKimiShimDir(env)).toEqual(expect.stringContaining('kimi-acp-poll-selector-'));
        expect(env?.PYTHONPATH).toContain('/existing');
      }
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
      for (const env of envs) {
        const shimDir = collectKimiShimDir(env);
        if (shimDir) {
          rmSync(shimDir, { recursive: true, force: true });
        }
      }
    }
  });
});
