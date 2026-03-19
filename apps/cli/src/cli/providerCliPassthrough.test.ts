import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { maybePassthroughProviderCliInfoRequest } from './providerCliPassthrough';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_GEMINI_PATH: process.env.HAPPIER_GEMINI_PATH,
  HAPPIER_JS_RUNTIME_PATH: process.env.HAPPIER_JS_RUNTIME_PATH,
  HAPPIER_MANAGED_NODE_BIN: process.env.HAPPIER_MANAGED_NODE_BIN,
  HAPPIER_NODE_PATH: process.env.HAPPIER_NODE_PATH,
};

const tempDirs = new Set<string>();

async function createExecutable(dir: string, name: string, contents: string): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, contents, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HAPPIER_GEMINI_PATH === undefined) delete process.env.HAPPIER_GEMINI_PATH;
  else process.env.HAPPIER_GEMINI_PATH = ORIGINAL_ENV.HAPPIER_GEMINI_PATH;
  if (ORIGINAL_ENV.HAPPIER_JS_RUNTIME_PATH === undefined) delete process.env.HAPPIER_JS_RUNTIME_PATH;
  else process.env.HAPPIER_JS_RUNTIME_PATH = ORIGINAL_ENV.HAPPIER_JS_RUNTIME_PATH;
  if (ORIGINAL_ENV.HAPPIER_MANAGED_NODE_BIN === undefined) delete process.env.HAPPIER_MANAGED_NODE_BIN;
  else process.env.HAPPIER_MANAGED_NODE_BIN = ORIGINAL_ENV.HAPPIER_MANAGED_NODE_BIN;
  if (ORIGINAL_ENV.HAPPIER_NODE_PATH === undefined) delete process.env.HAPPIER_NODE_PATH;
  else process.env.HAPPIER_NODE_PATH = ORIGINAL_ENV.HAPPIER_NODE_PATH;
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('maybePassthroughProviderCliInfoRequest', () => {
  it('runs system node-shebang provider CLIs through the resolved JS runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-provider-passthrough-'));
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
