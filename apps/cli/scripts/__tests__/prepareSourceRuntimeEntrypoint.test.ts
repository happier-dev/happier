import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { copyCliBinRuntimeFiles } from './testkit/cliBinPreflightSandbox';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

it('prepares current daemon source after a Protocol export is removed without loading the old compiled closure', async () => {
  const root = createTempDirSync('happier-cli-source-preparation-');
  const cli = join(root, 'apps/cli');
  const common = join(root, 'packages/cli-common');
  const protocol = join(root, 'packages/protocol');
  const write = (path: string, content: string) => {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  try {
    for (const name of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs',
      'sourceRuntimeDependencies.mjs', 'cliRuntimeSidecars.mjs', 'cliSourceLoader.mjs']) {
      mkdirSync(common, { recursive: true });
      cpSync(join(repoRoot, 'packages/cli-common', name), join(common, name));
    }
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    write(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    write(join(root, 'scripts/workspaces/syncBundledWorkspacePackages.mjs'), 'export {};');
    write(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {
      '.': { 'happier-source': './src/index.ts', default: './dist/index.mjs' },
      './mcp/bridges/happierMcpStdioBridge': { 'happier-source': './src/mcp/bridges/happierMcpStdioBridge.ts', default: './dist/mcp/bridges/happierMcpStdioBridge.mjs' },
    } }));
    write(join(cli, 'tsconfig.runtime.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    write(join(protocol, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: {
      './actions/invocationAuthority': { 'happier-source': './src/actions/invocationAuthority.ts', default: './src/actions/invocationAuthority.ts' },
    } }));
    mkdirSync(join(cli, 'node_modules/@happier-dev'), { recursive: true });
    symlinkSync(protocol, join(cli, 'node_modules/@happier-dev/protocol'), process.platform === 'win32' ? 'junction' : 'dir');
    copyCliBinRuntimeFiles({ binDir: join(cli, 'bin'), repoRoot });
    cpSync(join(repoRoot, 'apps/cli/bin/happier-dev.mjs'), join(cli, 'bin/happier-dev.mjs'));
    const oldClosure = "import { removedPolicy } from '@happier-dev/protocol/actions/invocationAuthority'; console.log(removedPolicy);";
    write(join(cli, 'dist/index.mjs'), oldClosure);
    cliDistBuildManifest.writeCliDistBuildManifest(join(cli, 'dist/index.mjs'), { outputDir: join(cli, 'dist') });
    write(join(cli, 'src/index.ts'), "setImmediate(async () => { const { policy } = await import('@/daemon/policy'); console.log(policy); });");
    write(join(cli, 'src/daemon/policy.ts'), "export { removedPolicy as policy } from '@happier-dev/protocol/actions/invocationAuthority';");
    write(join(protocol, 'src/actions/invocationAuthority.ts'), "export const removedPolicy = 'before';");
    write(join(cli, 'src/mcp/bridges/happierMcpStdioBridge.ts'), "console.log('bridge-current');");
    const probe = join(cli, 'bin/probe.mjs');
    write(probe, "import { importPreparedRuntimeEntrypoint } from './_importRuntimeEntrypoint.mjs'; await importPreparedRuntimeEntrypoint(process.argv[2], process.argv[3]);");
    const run = (entry = 'index.mjs') => promisify(execFile)(process.execPath, entry === 'index.mjs'
      ? ['--no-warnings', '--no-deprecation', join(cli, 'bin/happier-dev.mjs')]
      : [probe, cli, entry], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: '', TSX_TSCONFIG_PATH: '' },
    });
    expect((await run()).stdout.trim()).toBe('before');
    write(join(protocol, 'src/actions/invocationAuthority.ts'), "export const currentPolicy = 'after';");
    write(join(cli, 'src/daemon/policy.ts'), "export { currentPolicy as policy } from '@happier-dev/protocol/actions/invocationAuthority';");
    expect((await run()).stdout.trim()).toBe('after');
    expect(readFileSync(join(cli, 'dist/index.mjs'), 'utf8')).toBe(oldClosure);
    expect((await run('mcp/bridges/happierMcpStdioBridge.mjs')).stdout.trim()).toBe('bridge-current');
    expect((await run('mcp\\bridges\\happierMcpStdioBridge.mjs')).stdout.trim()).toBe('bridge-current');
    rmSync(join(cli, 'dist'), { recursive: true });
    expect((await run()).stdout.trim()).toBe('after');
    write(join(cli, 'dist/index.mjs'), "console.log('stale-fallback');");
    cliDistBuildManifest.writeCliDistBuildManifest(join(cli, 'dist/index.mjs'), { outputDir: join(cli, 'dist') });
    write(join(cli, 'src/daemon/policy.ts'), "export { removedPolicy as policy } from '@happier-dev/protocol/actions/invocationAuthority';");
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('removedPolicy') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
