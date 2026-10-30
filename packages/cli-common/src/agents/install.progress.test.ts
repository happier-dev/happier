import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { installAgentCliForRuntime } from './install.js';
import type { AgentCliRuntimeDescriptor } from './resolution.js';

it('retains download completion in the default install log without logging every chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-install-progress-'));
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  const assetName = `fixture-${platform === 'win32' ? 'windows' : platform}-${process.arch}${platform === 'win32' ? '.exe' : ''}`;
  const runtimeSpec: AgentCliRuntimeDescriptor = {
    id: 'progress-fixture', title: 'Progress fixture', binaryName: 'fixture',
    sourcePreferenceDefault: 'managed-first', acceptsJavaScriptFileOverride: false,
    managedInstall: { kind: 'github_release_binary', githubRepo: 'fixture/tool', binaryName: 'fixture' },
    manualInstallKind: 'command', manualInstallRecipes: null,
  };
  try {
    const result = await installAgentCliForRuntime({
      runtimeSpec, platform, env: { HAPPIER_HOME_DIR: root, PATH: '' }, skipIfInstalled: false,
      deps: {
        // Release metadata and streamed asset bytes are external network boundaries.
        fetchGitHubLatestRelease: async () => ({ assets: [{
          name: assetName, browser_download_url: 'https://example.invalid/fixture', digest: 'sha256:fixture',
        }] }),
        downloadGitHubReleaseAsset: async ({ destinationPath, onProgress }) => {
          for (let bytesDone = 1; bytesDone <= 1000; bytesDone++) {
            onProgress?.({ t: 'progress', bytesDone, bytesTotal: 1000 });
          }
          await writeFile(destinationPath, Buffer.alloc(1000, 1));
        },
      },
    });
    expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
    const log = result.logPath ? await readFile(result.logPath, 'utf8') : '';
    expect(log).toContain('1000/1000');
    expect(log.split('\n').length).toBeLessThan(30);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
