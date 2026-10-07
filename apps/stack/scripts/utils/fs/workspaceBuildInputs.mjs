import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SOURCE_ROOTS = ['src', 'sources', 'scripts'];
const TEST_DIRECTORY_NAMES = new Set(['__fixtures__', '__tests__', 'fixtures', 'test', 'testkit', 'tests', 'test-support']);

export function isWorkspaceBuildSourcePath(path) {
  return SOURCE_ROOTS.includes(String(path).replaceAll('\\', '/').split('/')[0]);
}

// Package admission, recursive watch traversal and runtime capture share this
// source-membership rule. Explicit shipped resources are admitted separately.
export function isWorkspaceBuildInputIgnoredPath(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  return parts.some(part => TEST_DIRECTORY_NAMES.has(part))
    || /\.(?:test|spec|testkit|test-support)\.[^.]+$/.test(name)
    || /^vitestSetup\.[cm]?[jt]sx?$/.test(name)
    || name.startsWith('vitest.')
    || name.startsWith('test-setup.');
}

export function createWorkspaceBuildInputIgnorePath(packageDirs, { repoDir, hostDir, ...options } = {}) {
  // Inventory is the authority for exceptions: shipped/native data and relative
  // extended configs may legitimately have test-like names.
  const directories = Array.isArray(packageDirs) ? packageDirs : [packageDirs];
  const inputPath = path => repoDir ? relative(repoDir, path) : path;
  const admitted = new Set(directories.flatMap(packageDir =>
    readWorkspaceBuildInputs(packageDir, { ...options, includeDirectories: true }).map(path => join(packageDir, path)))
    .filter(path => isWorkspaceBuildInputIgnoredPath(inputPath(path))));
  return path => {
    if (hostDir) {
      const hostRelative = relative(hostDir, path);
      const belongsToHost = !isAbsolute(hostRelative) && hostRelative !== '..' && !hostRelative.startsWith(`..${sep}`);
      // Host assets, native support and Prisma inputs are opaque build data.
      if (belongsToHost && !isWorkspaceBuildSourcePath(hostRelative)) return false;
    }
    return isWorkspaceBuildInputIgnoredPath(inputPath(path)) && !admitted.has(path);
  };
}

function isWorkspaceBuildConfigFile(name) {
  if (name === 'package.json') return true;
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(name)) {
    return !/\.(?:test|tests|type-tests)\.json$/.test(name);
  }
  return /^(?:rollup|vite|esbuild|babel|swc|rspack|tsup|happier-plugin-ui)\.config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

// Source capture and reconciliation share this package-output boundary. The
// authored hosted-web tree is an input; its generated parents are not membership.
export function isGeneratedPluginArtifactPath(path) {
  const parts = String(path).replaceAll('\\', '/').replace(/^packages\/(?:plugins\/)?[^/]+\//, '').split('/');
  if (parts[0] !== '.happier-plugin') return false;
  return parts[1] !== 'ui' || parts[2] !== 'hosted-web';
}

// Both package admission and Stack source identities consume this input set.
export function readWorkspaceBuildInputs(packageDir, {
  readDir = readdirSync,
  stat = lstatSync,
  includeShippedFiles = false,
  includeDirectories = false,
  excludeGeneratedPluginManifest = false,
  excludeGeneratedPluginArtifacts = false,
} = {}) {
  const inputs = new Set();
  const visit = (path, { ignoreTests = true } = {}) => {
    const relativePath = relative(packageDir, path).split(sep).join('/');
    const generated = excludeGeneratedPluginArtifacts && isGeneratedPluginArtifactPath(relativePath);
    if (generated && relativePath !== '.happier-plugin' && relativePath !== '.happier-plugin/ui') return;
    if (excludeGeneratedPluginManifest && relativePath === '.happier-plugin/plugin.json') return;
    if (ignoreTests && isWorkspaceBuildInputIgnoredPath(relativePath)) return;

    let entryStat;
    try {
      entryStat = stat(path, { bigint: true });
    } catch {
      return;
    }
    if (entryStat.isDirectory()) {
      if (includeDirectories && !generated) inputs.add(relativePath);
      for (const childName of readDir(path)) visit(join(path, childName), { ignoreTests });
      return;
    }
    if (!generated) inputs.add(relativePath);
  };

  let entries = [];
  try {
    entries = readDir(packageDir, { withFileTypes: true });
  } catch {
    return [...inputs];
  }
  for (const entry of entries) {
    if (
      (entry.isDirectory() && SOURCE_ROOTS.includes(entry.name))
      || (entry.isFile() && (isWorkspaceBuildConfigFile(entry.name) || /\.(?:mjs|cjs|js)$|\.d\.[cm]?ts$/.test(entry.name)))
    ) visit(join(packageDir, entry.name));
  }
  visit(join(packageDir, '.happier-plugin', 'plugin.json'));
  visit(join(packageDir, '.happier-plugin', 'ui', 'hosted-web'), { ignoreTests: false });
  if (includeShippedFiles) {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    for (const entry of ['README.md', '.happier-plugin', ...(packageJson.files ?? [])]) {
      if (
        typeof entry !== 'string' || !entry || entry.includes('\\') || entry.startsWith('/')
        || entry.split('/').some((segment) => !segment || segment === '.' || segment === '..')
        || /[*?{}[\]]/.test(entry)
      ) throw new Error(`[workspace-build] invalid shipped package file: ${entry}`);
      if (entry === 'dist' || entry.startsWith('dist/') || entry === 'package.json') continue;
      visit(join(packageDir, entry), { ignoreTests: isWorkspaceBuildSourcePath(entry) });
    }
  }
  // A config excluded as a test-only root can still be a consumed build input
  // when another admitted config extends it. One path owner serves source
  // identity, package admission, and dedicated-workspace source capture.
  const configs = new Set();
  const visitConfig = (path) => {
    if (configs.has(path)) return;
    configs.add(path);
    const match = readFileSync(path, 'utf8').match(/"extends"\s*:\s*("[^"]+"|\[[^\]]+\])/);
    if (!match) return;
    const specs = match[1].startsWith('[')
      ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1])
      : [match[1].slice(1, -1)];
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(path), spec);
      const target = existsSync(base) ? base : `${base}.json`;
      if (!existsSync(target)) throw new Error(`[workspace-build] missing extended tsconfig: ${target}`);
      inputs.add(relative(packageDir, target).split(sep).join('/'));
      visitConfig(target);
    }
  };
  for (const path of [...inputs]) if (/^tsconfig(?:\.[^.]+)*\.json$/.test(basename(path))) visitConfig(join(packageDir, path));
  return [...inputs].sort();
}

export function resolveWorkspaceBuildInputWatchPaths(packageDir, {
  existsSyncImpl = existsSync,
  excludeGeneratedPluginManifest = true,
  excludeGeneratedPluginArtifacts = false,
  includeShippedFiles = false,
} = {}) {
  const membershipRoots = [...SOURCE_ROOTS, '.happier-plugin/ui/hosted-web'];
  return [...new Set([
    ...membershipRoots.map((path) => join(packageDir, path)),
    ...readWorkspaceBuildInputs(packageDir, { excludeGeneratedPluginManifest, excludeGeneratedPluginArtifacts, includeShippedFiles, includeDirectories: includeShippedFiles })
      .filter((path) => !membershipRoots.some((root) => path.startsWith(`${root}/`)))
      .map((path) => join(packageDir, path)),
  ])].filter((path) => existsSyncImpl(path));
}
