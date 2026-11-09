import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { bundleCliSourceSidecars, readWorkspacePackages } from '@happier-dev/cli-common/sourceRuntimeEntries';

// The sidecar runs inside every Runner that terminates a process tree. Its graph
// must not pull the CLI file logger's Account/persistence closure into that heap.
it('builds process_tree.cjs without the CLI logger closure and it still terminates a real tree', async () => {
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
    // The logger's own Account/persistence closure is what must be absent.
    expect(processTreeInputs.filter(path => path.endsWith('apps/cli/src/persistence.ts'))).toEqual([]);

    // The bundled census and termination path must still run outside the CLI.
    await promisify(execFile)(process.execPath, ['-e', `
      const tree = require(${JSON.stringify(join(outputDir, 'process_tree.cjs'))});
      tree.terminateProcessTree({ pid: ${child.pid} }, { timeoutMs: 15000 }).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
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
