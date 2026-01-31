import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sanitizeBundledPackageJson(raw) {
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
  } = raw;

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

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false;
  cpSync(src, dest, { recursive: true });
  return true;
}

export function bundleWorkspaceDeps(opts = {}) {
  const repoRoot = opts.repoRoot ?? findRepoRoot(__dirname);
  const happyCliDir = opts.happyCliDir ?? resolve(repoRoot, 'packages', 'happy-cli');

  const bundles = [
    {
      name: '@happy/agents',
      srcDir: resolve(repoRoot, 'packages', 'happy-agents'),
      destDir: resolve(happyCliDir, 'node_modules', '@happy', 'agents'),
    },
    {
      name: '@happy/protocol',
      srcDir: resolve(repoRoot, 'packages', 'happy-protocol'),
      destDir: resolve(happyCliDir, 'node_modules', '@happy', 'protocol'),
    },
  ];

  for (const bundle of bundles) {
    const srcPackageJsonPath = resolve(bundle.srcDir, 'package.json');
    if (!existsSync(srcPackageJsonPath)) {
      throw new Error(`Missing workspace package.json for ${bundle.name}: ${srcPackageJsonPath}`);
    }

    const rawPackageJson = readJson(srcPackageJsonPath);
    if (rawPackageJson.name !== bundle.name) {
      throw new Error(
        `Unexpected package name at ${srcPackageJsonPath}: expected ${bundle.name}, got ${rawPackageJson.name}`,
      );
    }

    const distDir = resolve(bundle.srcDir, 'dist');
    if (!existsSync(distDir)) {
      throw new Error(`Missing dist/ for ${bundle.name}. Run: yarn -s build:shared (from packages/happy-cli)`);
    }

    resetDir(bundle.destDir);

    cpSync(distDir, resolve(bundle.destDir, 'dist'), { recursive: true });
    writeJson(resolve(bundle.destDir, 'package.json'), sanitizeBundledPackageJson(rawPackageJson));
    copyIfExists(resolve(bundle.srcDir, 'README.md'), resolve(bundle.destDir, 'README.md'));
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (invokedAsMain) {
  try {
    bundleWorkspaceDeps();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
