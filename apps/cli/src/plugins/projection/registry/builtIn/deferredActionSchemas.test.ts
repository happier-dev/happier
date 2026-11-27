import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { assertStrictPluginJsonValue, cloneStrictPluginJsonValue } from '@happier-dev/protocol/plugins/contributions/strictJsonValue';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { normalizeParsedPluginManifestV2 } from '@/plugins/manifest/normalize';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { resolveAgentFoundSkillSources } from '@/agent/skills/resolveAgentSkillsCapability';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../sources/generatedBundledPluginManifests';
import { loadCurrentBundledPluginLocatorResult } from './locators';
import { getResolvedContributionRegistry } from './snapshot';
import { resolveBundledPluginEnablement } from './enablement';
import { renderBundledDeclarationAsset } from './declarationAssets';
import { readIndexedBundledDeclarationManifest } from './declarationAssetFormat.mjs';
import { BundledPluginDeclarationChangedError, readBundledPluginCanonicalDeclarationDigest, readBundledPluginManifest } from './manifestFile';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';

const DEFERRED_KEYS = ['inputSchema', 'resultSchema'] as const;

function manifestPath(manifestRelativePath: string): string {
  return resolveCliRuntimeAssetPath(manifestRelativePath);
}

function readFileDeclaration(manifestRelativePath: string): CanonicalPluginManifest {
  return normalizeParsedPluginManifestV2(readIndexedBundledDeclarationManifest(
    manifestPath(manifestRelativePath)) as CanonicalPluginManifest);
}

function schemaSectionText(manifestRelativePath: string, kind: 'inputSchema' | 'resultSchema'): string {
  const asset = JSON.parse(readFileSync(manifestPath(manifestRelativePath), 'utf8'));
  return JSON.stringify(asset[kind === 'inputSchema' ? 2 : 3]);
}

function pluginsWithMaterializedActionSchemas(manifests: readonly CanonicalPluginManifest[]): string[] {
  return manifests.filter(manifest => manifest.contributes.actions.some(action => DEFERRED_KEYS.some(key =>
    Object.hasOwn(action, key) && !Object.getOwnPropertyDescriptor(action, key)?.get))).map(manifest => manifest.id);
}

function observeDecodes(texts: ReadonlyMap<string, string>, run: () => void): string[] {
  const idsByText = new Map([...texts].filter(([, text]) => text !== '{}').map(([id, text]) => [text, id]));
  const decode = vi.spyOn(JSON, 'parse');
  try {
    run();
    return decode.mock.calls.flatMap(([input]) => typeof input === 'string' && idsByText.has(input) ? [idsByText.get(input)!] : []);
  } finally {
    decode.mockRestore();
  }
}

const github = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(locator => locator.pluginId === 'happier.scm.forge.github')!;

describe('bundled plugin summary with on-demand Action schemas', () => {
  it('admits every bundled declaration from summaries, without parsing a full manifest or materializing a schema', () => {
    const sections = new Map(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.flatMap(locator => DEFERRED_KEYS.map(key =>
      [`${locator.pluginId}.${key}`, schemaSectionText(locator.manifestRelativePath, key)] as const)));
    const decoded = observeDecodes(sections, () => {
      // A runner's own Agent closure (Codex references Kimi and OpenAI services) is summary-only too.
      const codex = loadCurrentBundledPluginLocatorResult({ pluginIds: ['happier.agent.codex'] });
      expect(codex.loadedPlugins.map(plugin => plugin.pluginId)).toEqual(['happier.agent.codex']);
      expect(pluginsWithMaterializedActionSchemas(codex.loadedPlugins.map(plugin => plugin.manifest))).toEqual([]);
      const loaded = loadCurrentBundledPluginLocatorResult();
      const registry = getResolvedContributionRegistry();
      expect(loaded.loadedPlugins.length).toBe(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.length);
      expect(registry.actions.length).toBeGreaterThan(100);
      // Cross-Agent catalog readers (capability projection, skill sources) answer from the summary.
      expect(resolveAgentFoundSkillSources(registry).length).toBe(Object.keys(registry.catalogEntriesById).length);
      // Action forms (the daemon's UI projection) read precomputed hints, not schemas.
      for (const action of registry.actions) void action.definition.inputHints;
      for (const action of registry.actions) void action.localizedPresentation?.inputHints;
      expect(pluginsWithMaterializedActionSchemas(loaded.loadedPlugins.map(plugin => plugin.manifest))).toEqual([]);
    });
    expect(decoded).toEqual([]);
  });

  it('decodes each Action schema section once on demand for the admitted declaration', () => {
    const registry = getResolvedContributionRegistry({ pluginEnablementById: resolveBundledPluginEnablement({
      pluginIds: BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => locator.pluginId),
      // A changed enabled set re-admits the summary; the enable-while-running path.
      machineEnabledById: { [BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS[0]!.pluginId]: false },
    }) });
    const actions = registry.actions.filter(action => action.pluginId === github.pluginId);
    expect(actions.length).toBeGreaterThan(5);
    const inputs = new Map([[github.pluginId, schemaSectionText(github.manifestRelativePath, 'inputSchema')]]);
    const results = new Map([[github.pluginId, schemaSectionText(github.manifestRelativePath, 'resultSchema')]]);
    expect(observeDecodes(inputs, () => {
      expect(actions[0]!.definition.inputSchema).toBeTypeOf('object');
      for (const action of actions) void action.definition.inputSchema;
    })).toEqual([github.pluginId]);
    expect(observeDecodes(results, () => {
      for (const action of actions) void (action.definition as { outputSchema?: unknown }).outputSchema;
      for (const action of actions) void action.admittedTarget?.declaration.resultSchema;
    })).toEqual([github.pluginId]);
  });

  it('keeps every full declaration exact, including key order, once read', () => {
    const loaded = loadCurrentBundledPluginLocatorResult();
    for (const locator of BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS) {
      const plugin = loaded.loadedPlugins.find(candidate => candidate.pluginId === locator.pluginId)!;
      expect(JSON.stringify(plugin.manifest), locator.pluginId).toBe(JSON.stringify(readFileDeclaration(locator.manifestRelativePath)));
    }
  });

  it('projects the same registry Action schemas and hints as the declarations', () => {
    const registry = getResolvedContributionRegistry();
    const declarations = new Map(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => [locator.pluginId, readFileDeclaration(locator.manifestRelativePath)]));
    let compared = 0;
    for (const action of registry.actions) {
      const declared = declarations.get(action.pluginId!)!.contributes.actions.find(candidate => candidate.id === action.definition.id)!;
      expect(action.definition.inputSchema, action.definition.id).toEqual(declared.inputSchema);
      expect((action.definition as { outputSchema?: unknown }).outputSchema, action.definition.id).toEqual(declared.resultSchema);
      expect(action.admittedTarget?.declaration.resultSchema, action.definition.id).toEqual(declared.resultSchema);
      expect(action.definition.inputHints, action.definition.id)
        .toEqual(normalizePluginActionInputHintsV2(declared.inputHints, declared.inputSchema) ?? null);
      compared += 1;
    }
    expect(compared).toBe(registry.actions.length);
    // Agent-facing Action discovery (`action_spec_get`) and invocation read the indexed Actions.
    for (const [key, action] of registry.actionsById ?? new Map()) {
      const declared = declarations.get(action.pluginId!)!.contributes.actions.find(candidate => candidate.id === action.definition.id)!;
      expect(action.definition.inputSchema, key).toEqual(declared.inputSchema);
    }
    expect(registry.actionsById?.size).toBe(registry.actions.length);
  });

  it('strict-checks and re-admits any admitted Action and declaration through the strict JSON owner', () => {
    const loaded = loadCurrentBundledPluginLocatorResult();
    const registry = getResolvedContributionRegistry();
    for (const action of registry.actions) {
      const declaration = action.admittedTarget!.declaration;
      expect(() => assertStrictPluginJsonValue(declaration, 'declaration'), action.definition.id).not.toThrow();
      expect(cloneStrictPluginJsonValue(declaration, 'declaration')).toEqual(JSON.parse(JSON.stringify(declaration)));
      expect(() => assertStrictPluginJsonValue(JSON.parse(JSON.stringify(action.definition)), 'definition')).not.toThrow();
    }
    const plugin = loaded.loadedPlugins.find(candidate => candidate.pluginId === github.pluginId)!;
    const ingestion = ingestPluginManifestV2(plugin.manifest, { mode: 'load' });
    expect(ingestion.ok, ingestion.ok ? undefined : JSON.stringify(ingestion.diagnostics)).toBe(true);
  });

  it('withdraws a deferred section from an old admission after atomic publication', () => {
    const relativePath = github.manifestRelativePath;
    const raw = readIndexedBundledDeclarationManifest(manifestPath(relativePath)) as {
      displayName: string;
      contributes: { actions: Array<Record<string, unknown>> };
    };
    const root = mkdtempSync(join(tmpdir(), 'happier-bundled-declaration-'));
    try {
      const active = join(root, relativePath);
      mkdirSync(dirname(active), { recursive: true });
      writeFileSync(active, renderBundledDeclarationAsset(JSON.stringify(raw)));
      const read = () => readBundledPluginManifest({ manifestRelativePath: relativePath }, root) as typeof raw;
      const admitted = read();
      const firstAction = raw.contributes.actions.findIndex(action => action.inputSchema);
      expect(firstAction).toBeGreaterThanOrEqual(0);
      const schema = { type: 'object', properties: { renamed: { type: 'string' } } };
      raw.contributes.actions[firstAction]!.inputSchema = schema;
      const changed = `${active}.changed`;
      writeFileSync(changed, renderBundledDeclarationAsset(JSON.stringify(raw)));
      renameSync(changed, active);
      expect(() => admitted.contributes.actions[firstAction]!.inputSchema).toThrow(BundledPluginDeclarationChangedError);
      expect(read().contributes.actions[firstAction]!.inputSchema).toEqual(schema);
      expect(readBundledPluginCanonicalDeclarationDigest({ manifestRelativePath: relativePath }, root)).toBe(
        computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(
          createCanonicalJsonSigningInput(raw as Parameters<typeof createCanonicalJsonSigningInput>[0]),
        )),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
