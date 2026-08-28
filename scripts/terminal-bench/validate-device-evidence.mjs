import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testsDir = join(rootDir, 'packages', 'tests');
export function resolveDeviceEvidenceCliArgs(args, callerCwd = process.cwd()) {
  return args.map((arg) => arg.startsWith('-') ? arg : resolve(callerCwd, arg));
}

export function runDeviceEvidenceCli(args = process.argv.slice(2), callerCwd = process.cwd()) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/runTsxEntrypoint.mjs',
      'src/testkit/terminal/deviceEvidenceCli.ts',
      ...resolveDeviceEvidenceCliArgs(args, callerCwd),
    ],
    { cwd: testsDir, env: process.env, stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  return result.status ?? 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exit(runDeviceEvidenceCli());
}
