import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const DEFAULT_RUNTIME_ROOTS = Object.freeze(['dist', '.happier-plugin', '.happier-plugin-build']);

function portableRelativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function collectRuntimeFiles(packageDir, runtimeRoots) {
  const files = new Map();
  for (const runtimeRoot of runtimeRoots) {
    const absoluteRoot = resolve(packageDir, runtimeRoot);
    if (!existsSync(absoluteRoot)) continue;
    const visit = (path) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Bundled plugin runtime tree contains a non-regular entry: ${path}`);
      }
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          visit(resolve(path, entry.name));
        }
        return;
      }
      const relativePath = portableRelativePath(packageDir, path);
      if (!relativePath.endsWith('.tsbuildinfo')) {
        files.set(relativePath, readFileSync(path));
      }
    };
    visit(absoluteRoot);
  }
  return files;
}

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function compareBundledPluginPackageTrees({
  packageName,
  sourceDir,
  packageDir,
  runtimeRoots = DEFAULT_RUNTIME_ROOTS,
}) {
  if (!existsSync(sourceDir) || !existsSync(packageDir)) {
    return {
      packageName,
      sourceDir,
      packageDir,
      expectedFileCount: 0,
      matchedFileCount: 0,
      missing: [],
      mismatched: [],
      unexpected: [],
      sourceDirMissing: !existsSync(sourceDir),
      packageDirMissing: !existsSync(packageDir),
    };
  }

  const expectedFiles = collectRuntimeFiles(sourceDir, runtimeRoots);
  const actualFiles = collectRuntimeFiles(packageDir, runtimeRoots);
  const missing = [];
  const mismatched = [];
  let matchedFileCount = 0;
  for (const [relativePath, expectedBytes] of expectedFiles) {
    const actualBytes = actualFiles.get(relativePath);
    if (!actualBytes) {
      missing.push(relativePath);
      continue;
    }
    if (!expectedBytes.equals(actualBytes)) {
      mismatched.push({
        relativePath,
        expectedByteLength: expectedBytes.byteLength,
        actualByteLength: actualBytes.byteLength,
        expectedDigest: sha256Digest(expectedBytes),
        actualDigest: sha256Digest(actualBytes),
      });
      continue;
    }
    matchedFileCount += 1;
  }
  const unexpected = [...actualFiles.keys()]
    .filter((relativePath) => !expectedFiles.has(relativePath))
    .sort((left, right) => left.localeCompare(right));
  return {
    packageName,
    sourceDir,
    packageDir,
    expectedFileCount: expectedFiles.size,
    matchedFileCount,
    missing,
    mismatched,
    unexpected,
    sourceDirMissing: false,
    packageDirMissing: false,
  };
}

export function formatBundledPluginPackageCorrespondence(results) {
  const failed = results.filter((result) => (
    result.sourceDirMissing
    || result.packageDirMissing
    || result.missing.length > 0
    || result.mismatched.length > 0
    || result.unexpected.length > 0
  ));
  if (failed.length === 0) return null;

  const lines = ['[bundle-workspace-deps] Bundled plugin packaged runtime differs from its current producer tree'];
  for (const result of failed) {
    lines.push(
      `- ${result.packageName}: ${result.matchedFileCount}/${result.expectedFileCount} matching`
      + `, ${result.missing.length} missing`
      + `, ${result.mismatched.length} mismatched`
      + `, ${result.unexpected.length} unexpected`,
    );
    if (result.sourceDirMissing) lines.push(`  producer tree absent: ${result.sourceDir}`);
    if (result.packageDirMissing) lines.push(`  packaged tree absent: ${result.packageDir}`);
    for (const relativePath of result.missing.slice(0, 10)) lines.push(`  missing: ${relativePath}`);
    for (const entry of result.mismatched.slice(0, 10)) {
      lines.push(
        `  mismatched: ${entry.relativePath} expected ${entry.expectedByteLength} B ${entry.expectedDigest}`
        + ` actual ${entry.actualByteLength} B ${entry.actualDigest}`,
      );
    }
    for (const relativePath of result.unexpected.slice(0, 10)) lines.push(`  unexpected: ${relativePath}`);
  }
  return lines.join('\n');
}

export function assertBundledPluginPackageCorrespondence(params) {
  const result = compareBundledPluginPackageTrees(params);
  const failure = formatBundledPluginPackageCorrespondence([result]);
  if (failure) throw new Error(failure);
  return result;
}
