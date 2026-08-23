// Compatibility entrypoint for local package tooling. The implementation is
// repository-owned so plugin-ui never reaches into plugin-sdk internals.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as runApiGovernanceCli } from '../../../scripts/api-governance/cli.mjs';

export async function main(args = process.argv.slice(2)) {
  return runApiGovernanceCli(['--profile', 'plugin-ui', ...args]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
