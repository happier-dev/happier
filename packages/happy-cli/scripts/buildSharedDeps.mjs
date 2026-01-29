import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // Fallback for older layouts (repoRoot/packages/happy-cli/scripts).
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);

export function resolveTscBin({ exists } = {}) {
  const existsImpl = exists ?? existsSync;
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const candidates = [
    // Monorepo: TypeScript is installed at the workspace root.
    resolve(repoRoot, 'node_modules', '.bin', binName),
    // Fallback: older layouts installed it under cli/.
    resolve(repoRoot, 'cli', 'node_modules', '.bin', binName),
  ];

  for (const candidate of candidates) {
    if (existsImpl(candidate)) return candidate;
  }

  return candidates[0];
}

const tscBin = resolveTscBin();

export function runTsc(tsconfigPath, opts) {
  const exec = opts?.execFileSync ?? execFileSync;
  const tsc = opts?.tscBin ?? tscBin;
  try {
    exec(tsc, ['-p', tsconfigPath], { stdio: 'inherit' });
  } catch (error) {
    const suffix = tsconfigPath ? ` (${tsconfigPath})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile shared workspace deps${suffix}: ${message}`);
  }
}

export function ensureSymlink({ linkPath, targetPath }) {
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  mkdirSync(resolve(linkPath, '..'), { recursive: true });
  symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

export function main() {
  // Ensure @happy/agents is resolvable from the protocol workspace.
  ensureSymlink({
    linkPath: resolve(repoRoot, 'packages', 'protocol', 'node_modules', '@happy', 'agents'),
    targetPath: resolve(repoRoot, 'packages', 'agents'),
  });

  runTsc(resolve(repoRoot, 'packages', 'agents', 'tsconfig.json'));
  runTsc(resolve(repoRoot, 'packages', 'protocol', 'tsconfig.json'));

  const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
  if (!existsSync(protocolDist)) {
    throw new Error(`Expected @happy/protocol build output missing: ${protocolDist}`);
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href;
})();

if (invokedAsMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
