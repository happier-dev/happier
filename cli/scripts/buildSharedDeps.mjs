import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const tscBin = resolve(repoRoot, 'cli', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

export function runTsc(tsconfigPath, opts) {
  const exec = opts?.execFileSync ?? execFileSync;
  try {
    exec(tscBin, ['-p', tsconfigPath], { stdio: 'inherit' });
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
