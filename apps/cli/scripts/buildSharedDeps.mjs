import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  // Fallback for older layouts (repoRoot/apps/cli/scripts).
  return resolve(startDir, '..', '..', '..');
}

const repoRoot = findRepoRoot(__dirname);

export function resolveTscBin({ exists } = {}) {
  const existsImpl = exists ?? existsSync;
  const isWindows = process.platform === 'win32';
  const binName = isWindows ? 'tsc.cmd' : 'tsc';
  const candidates = isWindows
    ? [
        // Windows: prefer cmd shims when present.
        resolve(repoRoot, 'node_modules', '.bin', binName),
        resolve(repoRoot, 'cli', 'node_modules', '.bin', binName),
        // Fallback: allow executing the JS entry via Node if shims are missing.
        resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        resolve(repoRoot, 'cli', 'node_modules', 'typescript', 'bin', 'tsc'),
      ]
    : [
        // Prefer the real TypeScript entrypoint over node_modules/.bin symlinks.
        // On macOS, workspace-hoisted `.bin/*` symlinks can intermittently fail with ENOENT.
        resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        resolve(repoRoot, 'cli', 'node_modules', 'typescript', 'bin', 'tsc'),
        resolve(repoRoot, 'node_modules', '.bin', binName),
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
  const platform = opts?.platform ?? process.platform;
  try {
    if (platform === 'win32' && (tsc.endsWith('.cmd') || tsc.endsWith('.bat'))) {
      const command = `"${tsc}" -p "${tsconfigPath}"`;
      exec('cmd.exe', ['/d', '/s', '/c', command], { stdio: 'inherit' });
    } else {
      // Execute tsc via Node to avoid `.bin/*` symlink spawn issues and shebang portability quirks.
      exec(process.execPath, [tsc, '-p', tsconfigPath], { stdio: 'inherit' });
    }
  } catch (error) {
    const suffix = tsconfigPath ? ` (${tsconfigPath})` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile shared workspace deps${suffix}: ${message}`);
  }
}

export function syncBundledWorkspaceDist(opts = {}) {
  const repoRootArg = opts.repoRoot;
  const repoRoot = typeof repoRootArg === 'string' && repoRootArg.trim() ? repoRootArg : findRepoRoot(__dirname);
  const exists = opts.existsSync ?? existsSync;
  const cp = opts.cpSync ?? cpSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const packages = Array.isArray(opts.packages) && opts.packages.length > 0 ? opts.packages : ['agents', 'cli-common', 'protocol'];

  for (const pkg of packages) {
    const srcDist = resolve(repoRoot, 'packages', pkg, 'dist');
    const destDist = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', pkg, 'dist');
    if (!exists(destDist)) continue;
    try {
      cp(srcDist, destDist, { recursive: true, force: true });
    } catch {
      // Best-effort: bundled deps may be missing or readonly.
    }

    const destPackageJsonPath = resolve(repoRoot, 'apps', 'cli', 'node_modules', '@happier-dev', pkg, 'package.json');
    if (!exists(destPackageJsonPath)) continue;
    try {
      const raw = JSON.parse(readFile(resolve(repoRoot, 'packages', pkg, 'package.json'), 'utf8'));
      const sanitized = sanitizeBundledWorkspacePackageJson(raw);
      writeFile(destPackageJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
    } catch {
      // Best-effort: keep local bundled deps usable even if package.json sync fails.
    }
  }
}

function sanitizeBundledWorkspacePackageJson(raw) {
  const {
    name,
    version,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};

  return {
    name,
    version,
    private: true,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  };
}

export function main() {
  runTsc(resolve(repoRoot, 'packages', 'agents', 'tsconfig.json'));
  runTsc(resolve(repoRoot, 'packages', 'cli-common', 'tsconfig.json'));
  runTsc(resolve(repoRoot, 'packages', 'protocol', 'tsconfig.json'));

  const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
  if (!existsSync(protocolDist)) {
    throw new Error(`Expected @happier-dev/protocol build output missing: ${protocolDist}`);
  }

  // If the CLI currently has bundled workspace deps under apps/cli/node_modules,
  // keep their dist outputs in sync so local builds/tests do not consume stale artifacts.
  syncBundledWorkspaceDist({ repoRoot });
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
