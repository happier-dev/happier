import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installAgentCliForTarget } from './install.js';
import type { AgentCliRuntimeDescriptor } from './resolution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** The other CPU architecture than this Machine's (a Session target this Machine cannot run its own CLI in). */
const foreign = process.arch === 'arm64' ? 'x64' as const : 'arm64' as const;

function runtime(managedInstall: AgentCliRuntimeDescriptor['managedInstall'], manualInstallRecipes: AgentCliRuntimeDescriptor['manualInstallRecipes'] = null): AgentCliRuntimeDescriptor {
  return { id: 'fixture-rel', title: 'Fixture', binaryName: 'omp', knownUserBinDirSuffixes: null, sourcePreferenceDefault: 'system-first',
    manualInstallKind: manualInstallRecipes ? 'vendor_recipe' : null, manualInstallRecipes, acceptsJavaScriptFileOverride: false, managedInstall } as AgentCliRuntimeDescriptor;
}

describe('installAgentCliForTarget (an Agent CLI release for another platform, staged on this Machine)', () => {
  it('picks the target architecture\'s conventional asset when the catalog declares no asset names', async () => {
    const tools = await mkdtemp(join(tmpdir(), 'cli-target-')); roots.push(tools);
    const downloads: string[] = [];
    const result = await installAgentCliForTarget({
      runtimeSpec: runtime({ kind: 'github_release_binary', githubRepo: 'example/omp', binaryName: 'omp' }),
      target: { platform: 'linux', arch: foreign },
      env: { ...process.env, HAPPIER_MANAGED_TOOLS_ROOT: tools, HAPPIER_HOME_DIR: tools },
      deps: {
        // GitHub is the boundary: both architectures are published.
        fetchGitHubLatestRelease: async () => ({ assets: ['omp-linux-arm64', 'omp-linux-x64'].map(name => ({
          name, browser_download_url: `https://example.test/${name}`, digest: `sha256:${'a'.repeat(64)}` })) }) as never,
        downloadGitHubReleaseAsset: async params => { downloads.push(params.url); await writeFile(params.destinationPath, 'bin'); },
        extractGitHubReleaseAsset: async params => { await mkdir(dirname(params.outputPath!), { recursive: true }); await writeFile(params.outputPath!, 'bin'); },
      },
    });
    expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
    expect(downloads).toEqual([`https://example.test/omp-linux-${foreign}`]);
    if (!result.ok) return;
    expect(result.command.startsWith(join(tools, 'targets', `linux-${foreign}`, 'providers', 'fixture-rel'))).toBe(true);
    expect(result.files).toEqual(['bin/omp']);
  });

  it('a CLI without a GitHub release cannot be staged for another platform (`no-recipe`)', async () => {
    const result = await installAgentCliForTarget({ runtimeSpec: runtime(null, { linux: [{ cmd: 'sh', args: ['-c', 'true'] }] }),
      target: { platform: 'linux', arch: foreign } });
    expect(result).toMatchObject({ ok: false, errorCode: 'no-recipe' });
  });
});
