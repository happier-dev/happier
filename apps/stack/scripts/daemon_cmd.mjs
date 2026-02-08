import './utils/env/env.mjs';

import { join } from 'node:path';

import { run } from './utils/proc/proc.mjs';
import { getRootDir } from './utils/paths/paths.mjs';

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);

  // Delegate to the stack daemon implementation, targeting the main stack.
  // This keeps the logic centralized in one place.
  await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'daemon', 'main', ...argv], {
    cwd: rootDir,
    env: process.env,
  });
}

main().catch((e) => {
  // Keep output minimal and allow upstream scripts to format errors.
  const msg = e && typeof e === 'object' && 'message' in e ? e.message : String(e);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});

