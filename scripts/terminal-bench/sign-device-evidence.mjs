import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const callerCwd = process.cwd();
const pathOptions = new Set(['--draft', '--output', '--attestation', '--private-key']);
const args = process.argv.slice(2).map((value, index, values) => (
  index > 0 && pathOptions.has(values[index - 1]) ? resolve(callerCwd, value) : value
));
const result = spawnSync(process.execPath, [
  'scripts/runTsxEntrypoint.mjs',
  'src/testkit/terminal/deviceEvidenceCaptureCli.ts',
  ...args,
], { cwd: join(root, 'packages', 'tests'), env: process.env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 2);
