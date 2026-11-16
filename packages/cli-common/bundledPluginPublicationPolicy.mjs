import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Host-owned imports and direct runtime staging require these packages even when
// their generated bundled-plugin locator is absent. Review this set whenever a
// host adds or removes a first-party executable dependency, including generated
// Voice activation imports. Data-only projections do not make a package required.
export const REQUIRED_BUNDLED_PLUGIN_PACKAGES = Object.freeze([
  '@happier-dev/plugins-codex',
  '@happier-dev/plugins-elevenlabs',
  '@happier-dev/plugins-openai',
  '@happier-dev/plugins-xai',
]);

export const BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH = '.project/tmp/bundled-plugin-publication/failures.json';

// The plugin UI graph a `plugin_ui_artifact_invalid` record describes, relative to the plugin package root.
export const BUNDLED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH = 'dist/happier-plugin-ui/ui-artifacts.json';

export const BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES = Object.freeze([
  'plugin_package_build_failed',
  'plugin_manifest_invalid',
  'plugin_ui_artifact_invalid',
]);

const UI_ARTIFACT_FAILURE_CODE = 'plugin_ui_artifact_invalid';
const UI_ARTIFACTS_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const requiredPackages = new Set(REQUIRED_BUNDLED_PLUGIN_PACKAGES);
const publicationDiagnosticCodes = new Set(BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES);

export function parseBundledPluginPublicationFailures(raw) {
  const failures = JSON.parse(raw);
  if (!Array.isArray(failures) || !failures.every((failure) => (
    failure && typeof failure === 'object'
    && typeof failure.packageName === 'string'
    && failure.packageName.startsWith('@happier-dev/plugins-')
    && typeof failure.pluginId === 'string' && failure.pluginId.trim()
    && failure.diagnostic && typeof failure.diagnostic === 'object'
    && publicationDiagnosticCodes.has(failure.diagnostic.code)
    && typeof failure.diagnostic.message === 'string'
    && failure.diagnostic.message.trim()
    && Buffer.byteLength(failure.diagnostic.message, 'utf8') <= 2_048
    && (failure.uiArtifactsDigest === undefined || (failure.diagnostic.code === UI_ARTIFACT_FAILURE_CODE
      && (failure.uiArtifactsDigest === null || UI_ARTIFACTS_DIGEST_PATTERN.test(failure.uiArtifactsDigest))))
  ))) {
    throw new Error('Invalid bundled plugin publication failures');
  }
  return failures;
}

export function isRequiredBundledPluginPackage(packageName) {
  return requiredPackages.has(packageName);
}

/** Identity of the UI graph published in one plugin package root; null when none is published. */
export function readBundledPluginUiArtifactsDigest(pluginRootPath) {
  let bytes;
  try {
    bytes = readFileSync(join(pluginRootPath, ...BUNDLED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH.split('/')));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The runtime meaning of recorded publication failures, shared by every reader.
 * - A UI record describes the UI graph it evaluated (`uiArtifactsDigest`). When the
 *   package root now publishes a different graph, or the record predates that scope,
 *   it describes an older publication: `superseded`, never applied.
 * - The writer records a host-required package only when its runtime stays admitted
 *   (UI-only unavailability or a retained last-good artifact), so such a record is
 *   `retained`: reported, never a withdrawal. A required package that really cannot
 *   load still fails where it is loaded.
 * - Everything else withdraws its optional package.
 * `readUiArtifactsDigest(packageName)` returns the current digest, or undefined when this
 * reader cannot observe the package root (the record is then taken as written).
 */
export function classifyBundledPluginPublicationFailures(failures, readUiArtifactsDigest) {
  const withdrawn = [];
  const superseded = [];
  const retained = [];
  for (const failure of failures) {
    if (failure.diagnostic.code === UI_ARTIFACT_FAILURE_CODE && readUiArtifactsDigest) {
      const current = readUiArtifactsDigest(failure.packageName);
      if (current !== undefined && failure.uiArtifactsDigest !== current) {
        superseded.push(failure);
        continue;
      }
    }
    if (requiredPackages.has(failure.packageName)) retained.push(failure);
    else withdrawn.push(failure);
  }
  return { withdrawn, superseded, retained };
}

export function assertHostCanExcludeBundledPlugin(_repoRoot, packageName, originalError) {
  if (!isRequiredBundledPluginPackage(packageName)) return;
  const detail = originalError instanceof Error ? originalError.message : String(originalError ?? '').trim();
  throw new Error(
    `Bundled plugin '${packageName}' is required by host code${detail ? `: ${detail}` : ''}`,
    originalError instanceof Error ? { cause: originalError } : undefined,
  );
}
