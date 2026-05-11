import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeExpoShimPairCaptureInvocation({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });

  const expoPath = join(binDir, 'expo');
  await writeFile(
    expoPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "shim=posix bin=$0 args=$*" >> ${JSON.stringify(outputPath)}`,
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(expoPath, 0o755);

  await writeFile(
    join(binDir, 'expo.cmd'),
    [
      '@echo off',
      `echo shim=cmd bin=%~f0 args=%*>>"${outputPath}"`,
      'exit /b 0',
    ].join('\r\n') + '\r\n',
    'utf-8',
  );
}
