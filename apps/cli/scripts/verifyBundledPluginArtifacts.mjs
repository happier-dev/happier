// Pack-time proof that the bundled plugin package trees a tarball ships are the exact
// bytes the generator's source-artifact integrity payload publishes beside it. That
// payload is a build-owned generated artifact (apps/cli/scripts/build-owned/
// generatedBundledPluginSourceIntegrities.json) emitted by the sole bundled publisher;
// the adjacent runtime generation record is deliberately structural and is never an
// artifact-digest authority.
// A truncated `dist/index.js` and a missing runtime chunk shipped this way before this
// assertion existed.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { readBundledPluginPackageNames } from './build-owned/bundledPluginMembership.ts';

const INVENTORY_RELATIVE_PATH = 'apps/cli/scripts/build-owned/generatedBundledPluginSourceIntegrities.json';
const SOURCE_ARTIFACT_INTEGRITIES_EXPORT = 'BUNDLED_FIRST_PARTY_SOURCE_ARTIFACT_INTEGRITIES';
// Vendored runtime dependency trees are resolved per host install and are not part of
// the plugin generation the inventory binds.
const UNINVENTORIED_PACKAGE_ROOT_ENTRIES = new Set(['node_modules']);

function toPortableRelativePath(packageDir, path) {
  return relative(packageDir, path).split(sep).join('/');
}

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function isBundledPluginPublishedRuntimeRelativePath(relativePath) {
  return relativePath.startsWith('dist/') || relativePath.startsWith('.happier-plugin/');
}

/**
 * Reads the generated pack-time source-artifact integrity inventory for a repository.
 * A repository that carries no such payload publishes no bundled package tree to bind;
 * `null` says exactly that. This reader deliberately does not consume the runtime
 * immutable-generation record: the runtime module carries structural generation facts
 * only and is never a digest authority.
 */
export function readBundledPluginArtifactInventory({ repoRoot, inventoryPath } = {}) {
  const path = inventoryPath ?? resolve(repoRoot, INVENTORY_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`[verify-bundled-plugin-artifacts] Unreadable bundled plugin source-artifact integrity inventory: ${path} (${String(error)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1
    || parsed[SOURCE_ARTIFACT_INTEGRITIES_EXPORT] === undefined) {
    throw new Error(`[verify-bundled-plugin-artifacts] Unreadable bundled plugin source-artifact integrity inventory: ${path}`);
  }
  const artifacts = parsed[SOURCE_ARTIFACT_INTEGRITIES_EXPORT];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`[verify-bundled-plugin-artifacts] Empty bundled plugin source-artifact integrity inventory: ${path}`);
  }
  return artifacts;
}

function collectPackageTreeRelativePaths(packageDir, includeRelativePath) {
  const found = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (path === packageDir && UNINVENTORIED_PACKAGE_ROOT_ENTRIES.has(entry.name)) continue;
        visit(resolve(path, entry.name));
      }
      return;
    }
    const relativePath = toPortableRelativePath(packageDir, path);
    // The generator excludes the TypeScript incremental cache from the inventory,
    // so a stale one on disk is not an artifact disagreement.
    if (relativePath.endsWith('.tsbuildinfo')) return;
    if (includeRelativePath(relativePath)) found.push(relativePath);
  };
  visit(packageDir);
  return found;
}

/**
 * Compares one bundled plugin package tree against its source-artifact integrity
 * entry. Every
 * inventoried file must be present with the exact byte length and digest, and the
 * tree must not carry a plugin file the inventory does not publish.
 */
export function compareBundledPluginPackageTreeToInventory({ artifact, packageDir, includeRelativePath = () => true }) {
  const packageName = String(artifact?.packageName ?? '');
  const inventoryFiles = (Array.isArray(artifact?.files) ? artifact.files : []).filter((file) => (
    includeRelativePath(String(file?.relativePath ?? ''))
  ));
  if (!existsSync(packageDir)) {
    return {
      packageName,
      packageDir,
      inventoryFileCount: inventoryFiles.length,
      matchedFileCount: 0,
      missing: inventoryFiles.map((file) => file.relativePath),
      mismatched: [],
      unexpected: [],
      packageDirMissing: true,
    };
  }

  const missing = [];
  const mismatched = [];
  let matchedFileCount = 0;
  for (const file of inventoryFiles) {
    const filePath = resolve(packageDir, ...file.relativePath.split('/'));
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
      missing.push(file.relativePath);
      continue;
    }
    const bytes = readFileSync(filePath);
    const digest = sha256Digest(bytes);
    if (bytes.byteLength !== file.byteLength || digest !== file.digest) {
      mismatched.push({
        relativePath: file.relativePath,
        expectedByteLength: file.byteLength,
        actualByteLength: bytes.byteLength,
        expectedDigest: file.digest,
        actualDigest: digest,
      });
      continue;
    }
    matchedFileCount += 1;
  }

  const inventoryPaths = new Set(inventoryFiles.map((file) => file.relativePath));
  const unexpected = collectPackageTreeRelativePaths(packageDir, includeRelativePath)
    .filter((relativePath) => !inventoryPaths.has(relativePath))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return {
    packageName,
    packageDir,
    inventoryFileCount: inventoryFiles.length,
    matchedFileCount,
    missing,
    mismatched,
    unexpected,
    packageDirMissing: false,
  };
}

/**
 * Reads the pack-time inventory, refusing to answer "nothing to bind" while the
 * repository canonically carries bundled plugins. A missing inventory used to be
 * indistinguishable from "no bundled plugins", so every downstream consumer (pack
 * admission, daemon-readiness stamping) verified an empty set and shipped plugin
 * bytes no producer had published. Canonical bundled membership comes from the
 * one membership owner (`readBundledPluginPackageNames`), never a copied list;
 * only a genuinely plugin-free repository may observe `null`.
 */
export function requireBundledPluginArtifactInventory({ repoRoot, inventoryPath } = {}) {
  const artifacts = readBundledPluginArtifactInventory({ repoRoot, inventoryPath });
  const membershipPath = inventoryPath ?? resolve(repoRoot, INVENTORY_RELATIVE_PATH);
  const bundledMembershipPackageNames = readBundledPluginPackageNames(repoRoot);
  if (artifacts !== null) {
    const inventoryPackageNames = artifacts.map((artifact) => String(artifact?.packageName ?? ''));
    const inventoryMembership = new Set(inventoryPackageNames);
    const canonicalMembership = new Set(bundledMembershipPackageNames);
    const missing = bundledMembershipPackageNames.filter((packageName) => !inventoryMembership.has(packageName));
    const extra = [...inventoryMembership].filter((packageName) => !canonicalMembership.has(packageName));
    const duplicate = inventoryPackageNames.filter((packageName, index) => (
      inventoryPackageNames.indexOf(packageName) !== index
    ));
    if (missing.length > 0 || extra.length > 0 || duplicate.length > 0) {
      throw new Error([
        `[verify-bundled-plugin-artifacts] Bundled plugin source-artifact inventory membership disagrees with canonical packages/plugins membership: ${membershipPath}`,
        `missing: ${missing.length > 0 ? missing.join(', ') : '(none)'}`,
        `extra: ${extra.length > 0 ? extra.map((name) => name || '(empty)').join(', ') : '(none)'}`,
        `duplicate: ${duplicate.length > 0 ? duplicate.join(', ') : '(none)'}`,
      ].join('\n'));
    }
    return artifacts;
  }
  if (bundledMembershipPackageNames.length === 0) return null;
  throw new Error(
    `[verify-bundled-plugin-artifacts] Missing bundled plugin source-artifact integrity inventory: ${membershipPath}\n`
    + `${bundledMembershipPackageNames.length} bundled plugin workspaces are members of this repository `
    + `(from packages/plugins/*), so a missing inventory is a fatal publication defect: the packed plugin `
    + 'trees would ship without the producer-published byte binding.\n'
    + 'Fix: rebuild the bundled plugin workspaces, then regenerate the inventory with\n'
    + 'node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode write',
  );
}

export function verifyBundledPluginArtifactsAgainstInventory({ repoRoot, resolvePackageDir, inventoryPath } = {}) {
  const artifacts = requireBundledPluginArtifactInventory({ repoRoot, inventoryPath });
  if (artifacts === null) return [];
  return artifacts.map((artifact) => compareBundledPluginPackageTreeToInventory({
    artifact,
    packageDir: resolvePackageDir(artifact.packageName),
  }));
}

export function formatBundledPluginArtifactVerification(results) {
  const failed = results.filter((result) => (
    result.packageDirMissing
    || result.missing.length > 0
    || result.mismatched.length > 0
    || result.unexpected.length > 0
  ));
  if (failed.length === 0) return null;

  const lines = [
    '[verify-bundled-plugin-artifacts] Bundled plugin files disagree with generatedBundledPluginSourceIntegrities.json',
  ];
  for (const result of failed) {
    lines.push(
      `- ${result.packageName}: ${result.matchedFileCount}/${result.inventoryFileCount} matching`
      + `, ${result.missing.length} missing`
      + `, ${result.mismatched.length} mismatched`
      + `, ${result.unexpected.length} unexpected`,
    );
    if (result.packageDirMissing) lines.push(`  package tree absent: ${result.packageDir}`);
    for (const relativePath of result.missing.slice(0, 10)) lines.push(`  missing: ${relativePath}`);
    for (const entry of result.mismatched.slice(0, 10)) {
      lines.push(
        `  mismatched: ${entry.relativePath} expected ${entry.expectedByteLength} B ${entry.expectedDigest}`
        + ` actual ${entry.actualByteLength} B ${entry.actualDigest}`,
      );
    }
    for (const relativePath of result.unexpected.slice(0, 10)) lines.push(`  unexpected: ${relativePath}`);
  }
  lines.push('', 'Fix: rebuild the bundled plugin workspaces, then regenerate the inventory with');
  lines.push('node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode write');
  return lines.join('\n');
}

export function assertBundledPluginArtifactsMatchInventory(params) {
  const results = verifyBundledPluginArtifactsAgainstInventory(params);
  const failure = formatBundledPluginArtifactVerification(results);
  if (failure) throw new Error(failure);
  return results;
}
