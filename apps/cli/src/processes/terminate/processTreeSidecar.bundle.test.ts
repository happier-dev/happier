import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { bundleCliSourceSidecars, readWorkspacePackages } from '@happier-dev/cli-common/sourceRuntimeEntries';

// process_tree.cjs is loaded inside every Runner and the daemon (createRequire), where
// the census and process tools come from the host graph as adapters. Any bundled
// workspace closure in it is a second, never-run copy retained as source text in
// each of those heaps. Only the standalone launcher composes its own census.
it('keeps process_tree.cjs free of bundled workspace code and the standalone launcher still terminates a real tree', async () => {
  // Bundled sidecars keep npm packages external, so the output must resolve the installed node_modules.
  const cacheDir = resolve(__dirname, '../../../node_modules/.cache');
  await mkdir(cacheDir, { recursive: true });
  const root = await mkdtemp(join(cacheDir, 'happier-process-tree-sidecar-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const repoDir = resolve(__dirname, '../../../../..');
    const outputDir = join(root, 'scripts');
    const { metafile } = await bundleCliSourceSidecars({ repoDir, outputDir, build,
      workspacePackages: await readWorkspacePackages(repoDir),
      requireFromProject: createRequire(join(repoDir, 'apps/cli/package.json')) });
    const inputs = Object.keys(metafile.outputs).find(key => key.endsWith('process_tree.cjs'));
    expect(inputs, 'sidecar output present').toBeDefined();
    const processTreeInputs = Object.keys(metafile.outputs[inputs!].inputs);
    expect(processTreeInputs).toEqual(['apps/cli/scripts/process_tree.cjs']);
    const launcher = Object.keys(metafile.outputs).find(key => key.endsWith('terminal_launch_spec_runner.cjs'));
    // The launcher's own CLI-independent graph still must not carry the CLI logger's Account/persistence closure.
    expect(Object.keys(metafile.outputs[launcher!].inputs).filter(path => path.endsWith('apps/cli/src/persistence.ts'))).toEqual([]);

    // The bundled census and termination path must still run outside the CLI.
    await promisify(execFile)(process.execPath, ['-e', `
      const launcher = require(${JSON.stringify(join(outputDir, 'terminal_launch_spec_runner.cjs'))});
      launcher.terminateProcessTree({ pid: ${child.pid} }, { timeoutMs: 15000 }).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    `], { timeout: 30_000 });
    expect(child.exitCode !== null || child.signalCode !== null || await new Promise(done => {
      child.once('exit', () => done(true));
      setTimeout(() => done(false), 5_000);
    })).toBe(true);
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
