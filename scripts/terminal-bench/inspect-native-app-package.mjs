import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testsDir = join(rootDir, 'packages', 'tests');

export function resolveNativeAppPackageArgs(args, callerCwd = process.cwd()) {
  return args.map((arg) => arg.startsWith('-') || ['ios', 'android'].includes(arg)
    || ['simulator-unsigned', 'simulator-adhoc', 'device-development', 'device-distribution', 'app-store-export'].includes(arg)
    ? arg
    : resolve(callerCwd, arg));
}

export function runNativeAppPackageInspection(args = process.argv.slice(2), callerCwd = process.cwd()) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/runTsxEntrypoint.mjs',
      'src/testkit/terminal/deviceEvidencePackageCli.ts',
      ...resolveNativeAppPackageArgs(args, callerCwd),
    ],
    { cwd: testsDir, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exit(runNativeAppPackageInspection());
