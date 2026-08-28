import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const forwardedArgs = [...process.argv.slice(2)];
const outIndex = forwardedArgs.indexOf('--out');
if (outIndex >= 0 && forwardedArgs[outIndex + 1]) {
  forwardedArgs[outIndex + 1] = resolve(process.cwd(), forwardedArgs[outIndex + 1]);
}
const result = spawnSync(process.execPath, [
  'scripts/runTsxEntrypoint.mjs',
  'src/testkit/terminal/rendererBenchCli.ts',
  ...forwardedArgs,
], { cwd: join(rootDir, 'packages', 'tests'), env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
