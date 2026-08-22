import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const LOADER_PATH = fileURLToPath(new URL('./readTypescriptModule.mjs', import.meta.url));
const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

function runLoader(modulePath: string): Readonly<{
  status: number | null;
  stderr: string;
  values: Record<string, unknown> | null;
}> {
  const result = spawnSync(process.execPath, [LOADER_PATH, modulePath], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  const markerIndex = result.stdout.lastIndexOf(OUTPUT_MARKER);
  const payload = markerIndex < 0
    ? null
    : JSON.parse(result.stdout.slice(markerIndex + OUTPUT_MARKER.length)) as {
      values: Record<string, unknown>;
    };
  return { status: result.status, stderr: result.stderr, values: payload?.values ?? null };
}

describe('readTypescriptModule loader', () => {
  it('reads a module whose directory name carries a URL-significant character', async () => {
    // The loader receives a filesystem path on argv, and an ESM specifier is a URL.
    // A raw path is not a URL: `#` starts a fragment, and a Windows drive letter
    // parses as a scheme. Both truncate or reject the real module location, so the
    // loader must convert the path through `pathToFileURL` before importing it.
    const root = await mkdtemp(join(tmpdir(), 'happier-read-ts-module-'));
    roots.push(root);
    const moduleDirectory = join(root, 'plug#in');
    await mkdir(moduleDirectory, { recursive: true });
    const modulePath = join(moduleDirectory, 'entry.ts');
    await writeFile(
      modulePath,
      "export const pluginId: string = 'acme.fragment';\nexport const enabled: boolean = true;\n",
      'utf8',
    );

    const result = runLoader(modulePath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.values).toEqual({ pluginId: 'acme.fragment', enabled: true });
  }, 120_000);

  it('cold-inspects bundled Triage manifests without traversing React Native UI code', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

    for (const packageId of [
      'posthog',
      'scm-azure-devops',
      'scm-bitbucket',
      'scm-github',
      'scm-gitlab',
      'sentry',
    ] as const) {
      const result = runLoader(join(repoRoot, `packages/plugins/${packageId}/src/manifest.ts`));

      expect(result.status, `${packageId} manifest inspection failed: ${result.stderr}`).toBe(0);
      expect(result.values?.PLUGIN_MANIFEST).toMatchObject({
        id: expect.stringMatching(/^happier\./u),
      });
    }
  }, 120_000);
});
