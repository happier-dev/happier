import { createHash } from 'node:crypto';

import { computePluginManifestDigestV2 } from '@happier-dev/protocol/plugins/manifest/digest';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import type { ParsedPluginManifestV2, PluginActionContributionV2 } from '@happier-dev/protocol';

/**
 * Bundled declaration assets derived by the bundled-plugin publisher from the
 * exact serialized manifest (`assets/bundled-plugin-manifests/<id>.json`):
 *
 * - `declarations/<id>.summary.json`: the declaration with every Action
 *   `inputSchema`/`resultSchema` value replaced by `null` in its key position,
 *   plus the Action input hints those schemas derive. Every process reads this.
 * - `declarations/<id>.input-schemas.json` / `.result-schemas.json`: the
 *   deferred values by Action id, read on first use.
 *
 * All three carry the SHA-256 of the manifest text they were cut from; a reader
 * never joins a summary with schemas from another publication. The publisher's
 * write/check emitter owns freshness (drift fails the check).
 */
export const BUNDLED_DECLARATION_ASSET_DIR = 'declarations';
export const BUNDLED_DEFERRED_ACTION_KEYS = ['inputSchema', 'resultSchema'] as const;
export type BundledDeferredActionKey = typeof BUNDLED_DEFERRED_ACTION_KEYS[number];
export type BundledDeclarationAssetKind = 'summary' | BundledDeferredActionKey;

const FILE_SUFFIX: Readonly<Record<BundledDeclarationAssetKind, string>> = {
  summary: 'summary',
  inputSchema: 'input-schemas',
  resultSchema: 'result-schemas',
};

/** File name inside `BUNDLED_DECLARATION_ASSET_DIR`, beside the manifest `<base>.json`. */
export function bundledDeclarationAssetFileName(manifestFileName: string, kind: BundledDeclarationAssetKind): string {
  return `${manifestFileName.replace(/\.json$/u, '')}.${FILE_SUFFIX[kind]}.json`;
}

export type BundledDeclarationSummaryV1 = Readonly<{
  v: 1;
  declarationDigest: string;
  /**
   * The server's release-less declaration digest of this manifest
   * (`sha256:` over `createCanonicalJsonSigningInput` of the parsed manifest,
   * as `createReleaseLessDeclarationV1` computes it), so a claim can name the
   * declaration without materializing its Action schemas.
   */
  canonicalDeclarationDigest: string;
  manifest: Readonly<Record<string, unknown>>;
  /** Normalized Action input hints (`normalizePluginActionInputHintsV2`), `null` when none. */
  inputHintsByActionId: Readonly<Record<string, unknown>>;
}>;

export type BundledDeclarationValuesV1 = Readonly<{
  v: 1;
  declarationDigest: string;
  valuesByActionId: Readonly<Record<string, unknown>>;
}>;

export function digestBundledDeclarationText(manifestText: string): string {
  return createHash('sha256').update(manifestText).digest('hex');
}

/** Derive the summary and deferred values from one serialized manifest (build time and drift tests). */
export function projectBundledDeclarationAssets(manifestText: string): Readonly<{
  summary: BundledDeclarationSummaryV1;
  inputSchema: BundledDeclarationValuesV1;
  resultSchema: BundledDeclarationValuesV1;
}> {
  const declarationDigest = digestBundledDeclarationText(manifestText);
  // This text is the canonical publisher's already-admitted manifest.
  const parsedManifest = JSON.parse(manifestText) as ParsedPluginManifestV2;
  const canonicalDeclarationDigest = computePluginManifestDigestV2(parsedManifest);
  const manifest = parsedManifest as unknown as Record<string, unknown> & { contributes?: { actions?: unknown } };
  const values: Record<BundledDeferredActionKey, Record<string, unknown>> = { inputSchema: {}, resultSchema: {} };
  const inputHintsByActionId: Record<string, unknown> = {};
  const actions = Array.isArray(manifest.contributes?.actions) ? manifest.contributes.actions as Record<string, unknown>[] : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object' || typeof action.id !== 'string') continue;
    const definition = action as unknown as PluginActionContributionV2;
    // JSON spelling: optional members that derive as undefined are omitted.
    inputHintsByActionId[action.id] = JSON.parse(JSON.stringify(
      normalizePluginActionInputHintsV2(definition.inputHints, definition.inputSchema) ?? null,
    )) as unknown;
    for (const key of BUNDLED_DEFERRED_ACTION_KEYS) {
      if (!Object.hasOwn(action, key)) continue;
      values[key][action.id] = action[key];
      action[key] = null;
    }
  }
  return {
    summary: { v: 1, declarationDigest, canonicalDeclarationDigest, manifest, inputHintsByActionId },
    inputSchema: { v: 1, declarationDigest, valuesByActionId: values.inputSchema },
    resultSchema: { v: 1, declarationDigest, valuesByActionId: values.resultSchema },
  };
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  // The publisher's compact JSON order (`renderCompactJsonLiteral`), so the summary keeps the declaration's key order.
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) sorted[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
  return sorted;
}

/** Exact bytes of the three declaration assets for one serialized manifest (publisher and drift tests). */
export function renderBundledDeclarationAssets(manifestText: string): Readonly<Record<BundledDeclarationAssetKind, string>> {
  const projected = projectBundledDeclarationAssets(manifestText);
  const render = (value: unknown) => `${JSON.stringify(sortJsonKeys(value))}\n`;
  return { summary: render(projected.summary), inputSchema: render(projected.inputSchema), resultSchema: render(projected.resultSchema) };
}
