import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

function isWorkspaceBuildConfigFile(name) {
  if (name === 'package.json') return true;
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(name)) {
    return !/\.(?:test|tests|type-tests)\.json$/.test(name);
  }
  return /^(?:rollup|vite|esbuild|babel|swc|rspack|tsup|happier-plugin-ui)\.config\.(?:js|cjs|mjs|ts|json)$/.test(name);
}

// Both package admission and Stack source identities consume this input set.
export function readWorkspaceBuildInputs(packageDir, {
  readDir = readdirSync,
  stat = lstatSync,
  includeShippedFiles = false,
  excludeGeneratedPluginManifest = false,
  excludeGeneratedPluginArtifacts = false,
} = {}) {
  const inputs = new Set();
  const visit = (path, { ignoreTests = true } = {}) => {
    const relativePath = relative(packageDir, path).split(sep).join('/');
    if (excludeGeneratedPluginArtifacts && relativePath.startsWith('.happier-plugin/')
      && relativePath !== '.happier-plugin/ui'
      && relativePath !== '.happier-plugin/ui/hosted-web'
      && !relativePath.startsWith('.happier-plugin/ui/hosted-web/')) return;
    if (excludeGeneratedPluginManifest && relativePath === '.happier-plugin/plugin.json') return;
    const name = path.split(sep).at(-1) ?? '';
    if (
      ignoreTests && (
      name === '__tests__'
      || name === 'test'
      || name === 'tests'
      || name === 'fixtures'
      || /\.(?:test|spec)\.[^.]+$/.test(name)
      )
    ) return;

    let entryStat;
    try {
      entryStat = stat(path, { bigint: true });
    } catch {
      return;
    }
    if (entryStat.isDirectory()) {
      for (const childName of readDir(path)) visit(join(path, childName), { ignoreTests });
      return;
    }
    inputs.add(relativePath);
  };

  let entries = [];
  try {
    entries = readDir(packageDir, { withFileTypes: true });
  } catch {
    return [...inputs];
  }
  for (const entry of entries) {
    if (
      (entry.isDirectory() && ['src', 'sources', 'scripts'].includes(entry.name))
      || (entry.isFile() && (isWorkspaceBuildConfigFile(entry.name) || /\.(?:mjs|cjs|js)$/.test(entry.name)))
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
      visit(join(packageDir, entry), { ignoreTests: false });
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
} = {}) {
  const membershipRoots = ['src', 'sources', 'scripts', '.happier-plugin/ui/hosted-web'];
  return [...new Set([
    ...membershipRoots.map((path) => join(packageDir, path)),
    ...readWorkspaceBuildInputs(packageDir, { excludeGeneratedPluginManifest })
      .filter((path) => !membershipRoots.some((root) => path.startsWith(`${root}/`)))
      .map((path) => join(packageDir, path)),
  ])].filter((path) => existsSyncImpl(path));
}
