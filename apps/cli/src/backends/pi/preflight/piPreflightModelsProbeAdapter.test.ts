import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { piPreflightModelsProbeAdapter } from './piPreflightModelsProbeAdapter';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const envKeys = ['HAPPIER_PI_PATH', 'PATH'] as const;
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

function writeFakePiListModelsBinary(dir: string, stderrLines: ReadonlyArray<string>): string {
  const isWindows = process.platform === 'win32';
  const fileName = isWindows ? 'pi.cmd' : 'pi';
  const contents = isWindows
    ? [
        '@echo off',
        ...stderrLines.map((l) => `echo ${l} 1>&2`),
        'exit /b 0',
      ].join('\r\n')
    : [
        '#!/bin/sh',
        ...stderrLines.map((l) => `printf '%s\\n' "${l}" 1>&2`),
        'exit 0',
      ].join('\n');
  return writeExecutableShimSync({ dir, fileName, contents });
}

describe('piPreflightModelsProbeAdapter', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('includes a model-scoped Thinking option when the Pi model list indicates thinking support', async () => {
    tempDir = makeTempDir('happier-pi-preflight-models-');
    const fakePi = writeFakePiListModelsBinary(tempDir, [
      'provider  model  context  max-out  thinking  images',
      'openai  gpt-5.4  200K  4K  yes  yes',
    ]);

    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = fakePi;

    const raw = await piPreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(raw).toEqual([
      {
        id: 'openai/gpt-5.4',
        name: 'gpt-5.4',
        description: 'openai',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'Max' },
            ],
          },
        ],
      },
    ]);
  });

  it('does not include a model-scoped Thinking option when the Pi model list indicates no thinking support', async () => {
    tempDir = makeTempDir('happier-pi-preflight-models-no-thinking-');
    const fakePi = writeFakePiListModelsBinary(tempDir, [
      'provider  model  context  max-out  thinking  images',
      'openai  gpt-4o-mini  128K  4K  no  yes',
    ]);

    process.env.PATH = '';
    process.env.HAPPIER_PI_PATH = fakePi;

    const raw = await piPreflightModelsProbeAdapter.probeModelsRaw?.({
      cwd: tempDir,
      timeoutMs: 2_000,
      backendTarget: undefined,
      accountSettings: null,
    });

    expect(raw).toEqual([
      {
        id: 'openai/gpt-4o-mini',
        name: 'gpt-4o-mini',
        description: 'openai',
      },
    ]);
  });
});
