import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const tscBin = (() => {
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const candidates = [
    resolve(repoRoot, 'node_modules', '.bin', binName),
    resolve(repoRoot, 'packages', 'happy-server', 'node_modules', '.bin', binName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
})();

function runTsc(tsconfigPath) {
  execFileSync(tscBin, ['-p', tsconfigPath], { stdio: 'inherit' });
}

// Build shared packages (dist/ is the runtime contract).
runTsc(resolve(repoRoot, 'packages', 'happy-agents', 'tsconfig.json'));
runTsc(resolve(repoRoot, 'packages', 'happy-protocol', 'tsconfig.json'));

// Sanity check: ensure protocol dist entry exists.
const protocolDist = resolve(repoRoot, 'packages', 'happy-protocol', 'dist', 'index.js');
if (!existsSync(protocolDist)) {
  throw new Error(`Expected @happy/protocol build output missing: ${protocolDist}`);
}
