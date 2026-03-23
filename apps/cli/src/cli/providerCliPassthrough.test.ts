import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { maybePassthroughProviderCliInfoRequest } from './providerCliPassthrough';

const envKeys = [
  'PATH',
  'HAPPIER_GEMINI_PATH',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;

const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createExecutable(dir: string, name: string, contents: string): Promise<string> {
  return await writeExecutableShim({
    dir,
    fileName: process.platform === 'win32' ? `${name}.cmd` : name,
    contents,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('maybePassthroughProviderCliInfoRequest', () => {
  it('runs system node-shebang provider CLIs through the resolved JS runtime', async () => {
    const root = await createTempDir('happier-provider-passthrough-');
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    const runtimeDir = join(root, 'runtime');
    await mkdir(pathDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const providerPath = await createExecutable(
      pathDir,
      'gemini',
      '#!/usr/bin/env node\nprocess.stdout.write(\"fake-system-gemini-help\\n\")\n',
    );
    const markerPath = join(root, 'runtime-marker.txt');
    const runtimePath = await createExecutable(
      runtimeDir,
      'node',
      `#!/bin/sh\nprintf '%s\\n' \"$1\" > ${JSON.stringify(markerPath)}\n`,
    );

    process.env.PATH = pathDir;
    process.env.HAPPIER_JS_RUNTIME_PATH = runtimePath;

    const handled = maybePassthroughProviderCliInfoRequest({
      agentId: 'gemini',
      args: ['--help'],
      processEnv: { ...process.env, PATH: pathDir, HAPPIER_JS_RUNTIME_PATH: runtimePath },
    });

    expect(handled).toBe(true);
    await expect(readFile(markerPath, 'utf8')).resolves.toContain(providerPath);
  });
});
