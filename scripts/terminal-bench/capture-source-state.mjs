import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const callerCwd = process.cwd();
const args = process.argv.slice(2).map((arg, index) => index < 2 ? resolve(callerCwd, arg) : arg);
const result = spawnSync(process.execPath, [
  'scripts/runTsxEntrypoint.mjs',
  'src/testkit/terminal/deviceEvidenceSourceStateCli.ts',
  ...args,
], { cwd: join(root, 'packages', 'tests'), env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 2);
