import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execYarn } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { formatProblems, runContentChecks } from './checkContent.mjs';
import { renderRedirects } from './generateRedirects.mjs';

const require = createRequire(import.meta.url);
const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveNextCliPath() {
  return require.resolve('next/dist/bin/next');
}

export async function runDocsBuild({
  packageRoot = defaultPackageRoot,
  processExecPath = process.execPath,
  execYarnImpl = execYarn,
  resolveNextCliPathImpl = resolveNextCliPath,
  spawnSyncImpl = spawnSync,
  runContentChecksImpl = runContentChecks,
  renderRedirectsImpl = renderRedirects,
  writeFileImpl = writeFile,
} = {}) {
  // Before anything expensive: a broken internal link, a renamed UI label and a
  // stale generated page all build perfectly green, and all three mislead every
  // reader who hits them. Failing here is the only place they become visible.
  const contentProblems = await runContentChecksImpl();
  const problemCount =
    contentProblems.links.length + contentProblems.labels.length + (contentProblems.generated?.length ?? 0);
  if (problemCount > 0) {
    throw new Error(
      `Docs content checks failed with ${problemCount} problem${problemCount === 1 ? '' : 's'}:\n${formatProblems(contentProblems)}`,
    );
  }

  // public/_redirects has to exist BEFORE `next build`, because the export
  // copies public/ into out/ as part of the build. Generating it after would
  // produce an out/ with dead URLs and no sign anything was wrong.
  await writeFileImpl(
    resolve(packageRoot, 'public', '_redirects'),
    renderRedirectsImpl(),
    'utf8',
  );

  execYarnImpl(['-s', 'types:check'], { cwd: packageRoot, stdio: 'inherit' });
  const result = spawnSyncImpl(
    processExecPath,
    [resolveNextCliPathImpl(), 'build', '--webpack'],
    { cwd: packageRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Next build failed with code ${result.status ?? 'unknown'}`);
  }
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) await runDocsBuild();
