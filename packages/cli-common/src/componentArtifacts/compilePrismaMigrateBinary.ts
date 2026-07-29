import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BinaryTarget } from './targets.js';
import { execOrThrow, type RunCommand } from './commands.js';

export async function compilePrismaMigrateBinary({
  repoRoot,
  target,
  outfile,
  bunCommand,
  runCommand = execOrThrow,
}: {
  repoRoot: string;
  target: BinaryTarget;
  outfile: string;
  bunCommand: string;
  runCommand?: RunCommand;
}): Promise<void> {
  await mkdir(dirname(outfile), { recursive: true });
  await runCommand(
    bunCommand,
    [
      join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildPrismaMigrateBinary.mjs'),
      '--repo-root', repoRoot,
      '--target', target.bunTarget,
      '--outfile', outfile,
    ],
    { cwd: repoRoot },
  );
}
