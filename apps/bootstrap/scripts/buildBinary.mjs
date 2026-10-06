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
  // Bun creates its temporary executable in cwd; keep it with ignored build outputs so
  // a continuously synchronized source mirror cannot remove it before promotion.
  cwd: outDir,
  // Freeze the QA acquisition gate in standalone hsetup; runtime NODE_ENV cannot enable it.
  defines: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV === 'development' ? 'development' : 'production') },
});
