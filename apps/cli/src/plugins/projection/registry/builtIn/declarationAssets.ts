import { createHash } from 'node:crypto';

import { computePluginManifestDigestV2 } from '@happier-dev/protocol/plugins/manifest/digest';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import type { ParsedPluginManifestV2, PluginActionContributionV2 } from '@happier-dev/protocol';

import {
    SCHEMA_SECTIONS, renderIndexedBundledDeclaration, type SchemaValues,
} from './declarationAssetFormat.mjs';

/** Render one indexed publication from the canonical publisher's admitted manifest. */
export function renderBundledDeclarationAsset(manifestText: string): string {
  const declarationDigest = createHash('sha256').update(manifestText).digest('hex');
  // This text is the canonical publisher's already-admitted manifest.
  const parsedManifest = JSON.parse(manifestText) as ParsedPluginManifestV2;
  const canonicalDeclarationDigest = computePluginManifestDigestV2(parsedManifest);
  const manifest = parsedManifest as unknown as Record<string, unknown> & { contributes?: { actions?: unknown } };
  const values: Record<typeof SCHEMA_SECTIONS[number], SchemaValues> = { inputSchema: {}, resultSchema: {} };
  const inputHintsByActionId: Record<string, unknown> = {};
  const actions = Array.isArray(manifest.contributes?.actions) ? manifest.contributes.actions as Record<string, unknown>[] : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object' || typeof action.id !== 'string') continue;
    const definition = action as unknown as PluginActionContributionV2;
    // JSON spelling: optional members that derive as undefined are omitted.
    inputHintsByActionId[action.id] = JSON.parse(JSON.stringify(
      normalizePluginActionInputHintsV2(definition.inputHints, definition.inputSchema) ?? null,
    )) as unknown;
    for (const key of SCHEMA_SECTIONS) {
      if (!Object.hasOwn(action, key)) continue;
      values[key][action.id] = action[key];
      action[key] = null;
    }
  }
  return renderIndexedBundledDeclaration({
    summary: { v: 1, declarationDigest, canonicalDeclarationDigest, manifest, inputHintsByActionId },
    inputSchema: { valuesByActionId: values.inputSchema },
    resultSchema: { valuesByActionId: values.resultSchema },
  });
}
