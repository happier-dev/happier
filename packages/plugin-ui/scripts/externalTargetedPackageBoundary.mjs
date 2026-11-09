import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAuthorPackageExport } from '../../../scripts/api-governance/authorExports.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const PLUGIN_UI_PACKAGE_NAME = '@happier-dev/plugin-ui';

export function pathIsInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === ''
    || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

async function listSourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(entryPath));
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readPublicImports() {
  const manifests = await Promise.all([
    readFile(join(packageRoot, '../plugin-sdk/package.json'), 'utf8'),
    readFile(join(packageRoot, 'package.json'), 'utf8'),
  ]);
  const imports = new Set(['react']);
  for (const manifest of manifests) {
    const { name, exports } = JSON.parse(manifest);
    for (const [specifier, target] of Object.entries(exports)) {
      if (target !== null && isAuthorPackageExport(name, specifier)) {
        imports.add(`${name}${specifier === '.' ? '' : specifier.slice(1)}`);
      }
    }
  }
  return imports;
}

/** Fail before compilation when the external target reaches around a public package export. */
export async function assertExternalTargetedPackagePublicBoundary({
  targetRoot,
  expectedPackageName = '@happier-fixture/physical-target',
  requiredPackageNames = [SDK_PACKAGE_NAME, PLUGIN_UI_PACKAGE_NAME],
} = {}) {
  if (typeof targetRoot !== 'string' || targetRoot.trim() === '') {
    throw new Error('External targeted package proof requires a target root');
  }
  const sourceRoot = join(targetRoot, 'src');
  const manifest = JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8'));
  if (manifest.name !== expectedPackageName) {
    throw new Error('External targeted package proof received the wrong package identity');
  }
  for (const [sectionName, dependencies] of Object.entries({
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  })) {
    for (const [packageName, version] of Object.entries(dependencies ?? {})) {
      if (typeof version !== 'string' || /^(?:file|link|workspace):/u.test(version)) {
        throw new Error(`External targeted package ${sectionName}.${packageName} substitutes workspace source`);
      }
    }
  }
  if (requiredPackageNames.some((packageName) => manifest.dependencies?.[packageName] !== '0.0.0')) {
    throw new Error('External targeted package must depend on its required public packages');
  }
  const sourceFiles = await listSourceFiles(sourceRoot);
  if (sourceFiles.length === 0) {
    throw new Error('External targeted package proof requires TypeScript source files');
  }
  const publicImports = await readPublicImports();
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8');
    const specifiers = source.matchAll(/\b(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu);
    for (const match of specifiers) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        if (!pathIsInside(sourceRoot, resolve(dirname(sourceFile), specifier))) {
          throw new Error(`External targeted package source escapes its package: ${specifier}`);
        }
        continue;
      }
      if (!publicImports.has(specifier)) {
        throw new Error(`External targeted package source imports a non-public dependency: ${specifier}`);
      }
    }
  }

  return Object.freeze([...sourceFiles].sort());
}
