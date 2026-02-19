import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);
const tscInvocation = (() => {
  // Prefer resolving the TypeScript CLI via Node module resolution rather than relying on
  // node_modules/.bin symlinks (which can be missing/unstable in some workspace setups).
  try {
    const require = createRequire(import.meta.url);
    const tscJs = require.resolve('typescript/bin/tsc');
    return { command: process.execPath, argsPrefix: [tscJs] };
  } catch {
    // Fall back to .bin lookup for compatibility with unusual installs.
    const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
    const candidates = [
      resolve(repoRoot, 'node_modules', '.bin', binName),
      resolve(repoRoot, 'apps', 'server', 'node_modules', '.bin', binName),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { command: candidate, argsPrefix: [] };
    }
    return { command: candidates[0], argsPrefix: [] };
  }
})();

function runTsc(tsconfigPath) {
  execFileSync(tscInvocation.command, [...tscInvocation.argsPrefix, '-p', tsconfigPath], { stdio: 'inherit' });
}

// Build shared packages (dist/ is the runtime contract).
runTsc(resolve(repoRoot, 'packages', 'agents', 'tsconfig.json'));
runTsc(resolve(repoRoot, 'packages', 'protocol', 'tsconfig.json'));

// Sanity check: ensure protocol dist entry exists.
const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
if (!existsSync(protocolDist)) {
  throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
}
