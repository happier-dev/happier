import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { componentArtifacts } from '@happier-dev/cli-common';
import { resolveBuildBinaryTarget } from './buildBinaryTarget.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = join(repoRoot, 'apps', 'bootstrap', 'dist', 'bin');
const target = resolveBuildBinaryTarget({
  bunTargetOverride: process.env.HAPPIER_BUN_TARGET,
});
const exeName = componentArtifacts.resolveExecutableName({
  baseName: 'hsetup',
  target,
});

await mkdir(outDir, { recursive: true });
await rm(join(outDir, 'hsetup'), { force: true });
await rm(join(outDir, exeName), { force: true });
await componentArtifacts.compileBunBinary({
  entrypoint: join(repoRoot, 'apps', 'bootstrap', 'src', 'bin', 'hsetup.ts'),
  bunTarget: process.env.HAPPIER_BUN_TARGET ?? target.bunTarget,
  outfile: join(outDir, exeName),
  cwd: repoRoot,
});
