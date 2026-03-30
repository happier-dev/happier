import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeDistExecutableWrapper(params: Readonly<{
  targetPath: string;
}>): Promise<void> {
  await mkdir(dirname(params.targetPath), { recursive: true });
  await writeFile(params.targetPath, [
    '#!/usr/bin/env node',
    '',
    "const entrypoint = new URL('./hsetup.js', import.meta.url);",
    'const moduleExports = await import(entrypoint.href);',
    '',
    "if (typeof moduleExports.runHsetupCli !== 'function') {",
    "  throw new Error('dist/bin/hsetup.js does not export runHsetupCli');",
    '}',
    '',
    'const exitCode = await moduleExports.runHsetupCli(process.argv.slice(2));',
    'process.exitCode = exitCode;',
    '',
  ].join('\n'), 'utf8');
  await chmod(params.targetPath, 0o755);
}
