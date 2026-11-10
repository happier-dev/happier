/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { applyProjectedCredentialKindRestrictions, resolveCanonicalAgentIdFromFlavor } from '@happier-dev/agents';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveEngineBackendIdForCatalogAgent } from '@/agent/runtime/registry/engineRegistry/contributions';

import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';

// Read authored contributions, so a missing hook cannot hide behind an older
// published manifest. The generated membership owns which plugins ship Agents.
type AuthoredPlugin = Parameters<typeof createPluginTestkit>[0]['module'] & Readonly<{
  manifest: Parameters<typeof createPluginTestkit>[0]['manifest'];
}>;
const manifests = import.meta.glob<Record<string, unknown> & {
  PLUGIN_MANIFEST: Parameters<typeof createPluginTestkit>[0]['manifest'];
  activate?: AuthoredPlugin['activate'];
}>('../../../../../packages/plugins/*/src/manifest.ts');

describe('registered Agent contribution contracts', () => {
  it('declares account, resume, model-source and install contracts for every registered Agent', async () => {
    const offenders: string[] = [];
    for (const metadata of BUNDLED_FIRST_PARTY_PLUGIN_METADATA) {
      const bindings = BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS.filter(binding => binding.identity.pluginId === metadata.pluginId);
      if (bindings.length === 0) continue;
      const load = manifests[`../../../../../packages/plugins/${metadata.pluginPackageId}/src/manifest.ts`];
      expect(load, metadata.pluginId).toBeTypeOf('function');
      const source = await load!();
      const module = Object.values(source).find((value): value is AuthoredPlugin => (
        value !== null && typeof value === 'object' && 'manifest' in value
        && value.manifest !== null && typeof value.manifest === 'object' && 'id' in value.manifest
        && value.manifest.id === metadata.pluginId && 'activate' in value && typeof value.activate === 'function'
      ));
      const activate = source.activate ?? module?.activate;
      expect(activate, metadata.pluginId).toBeTypeOf('function');
      let manifest: ReturnType<typeof normalizePluginManifestV2>;
      try {
        manifest = normalizePluginManifestV2(source.PLUGIN_MANIFEST);
      } catch (error) {
        offenders.push(`${metadata.pluginId}: invalid manifest (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      const fixture = await createPluginTestkit({ manifest: source.PLUGIN_MANIFEST, module: { activate: activate! } });
      try {
        for (const binding of bindings) {
          const id = binding.identity.localId;
          const declaration = manifest.contributes.agents?.find(agent => agent.id === id);
          const authoredDeclaration = source.PLUGIN_MANIFEST.contributes?.agents?.find(agent => agent.id === id);
          expect(declaration, `${metadata.pluginId}/${id}`).toBeDefined();
          if (!declaration) continue;
          // Reconstruct the declaration exactly as an admitted runner does;
          // package/local spelling must not replace its execution identity.
          const projected = projectManifestAgentContribution({
            definition: declaration, pluginId: metadata.pluginId,
            provenance: 'first_party', source: { kind: 'bundled' },
            admittedAgentId: binding.implementationOwnerId,
            systemTools: manifest.contributes.systemTools,
          });
          const contributions = createResolvedContributionRegistry({ agents: [projected] });
          expect(projected.identity).toEqual(binding.identity);
          expect(projected.id, `${metadata.pluginId}/${id}: admitted runner identity`).toBe(binding.implementationOwnerId);
          expect(resolveEngineBackendIdForCatalogAgent(contributions, projected.id)).toBe(binding.implementationOwnerId);
          if (!Array.isArray(authoredDeclaration?.connectedAccounts)) offenders.push(`${id}: account support omitted (use [] for unsupported)`);
          if (!declaration.catalog?.vendorResume) offenders.push(`${id}: resume support omitted`);
          for (const purpose of declaration.connectedAccounts ?? []) {
            if (!purpose.credentialKinds?.length) offenders.push(`${id}/${purpose.purpose}: credential kinds omitted`);
            const service = typeof purpose.service === 'string'
              ? { pluginId: metadata.pluginId, localId: purpose.service } : purpose.service;
            const key = buildQualifiedPluginContributionKey(service);
            // Exercise the real shared inventory decision with the authored
            // declaration: unknown kinds retain health, known exclusions do not.
            for (const kind of [null, 'oauth', 'token'] as const) {
              const projected = applyProjectedCredentialKindRestrictions({
                connectedAccounts: [{ ...purpose, service }],
                optionsByServiceId: { [key]: [{ profileId: 'contract-account', kind, status: 'connected' }] },
              });
              expect(projected[key]?.[0]?.status, `${id}/${purpose.purpose}/${kind}`).toBe(
                kind && purpose.credentialKinds?.length && !purpose.credentialKinds.includes(kind)
                  ? 'unsupported_kind' : 'connected',
              );
            }
          }
          const registration = fixture.registration('agents', id);
          // Declarative ACP owns its native session/new model catalog. A finite
          // execution-only contribution declares no Session model surface.
          if (declaration.connectedAccounts?.length && declaration.primary !== 'executionRuns'
            && declaration.runtime.kind !== 'acp') {
            const preflight = registration?.preflightSessionControls;
            if (!preflight?.models && !preflight?.probeModels && !preflight?.catalogs && !preflight?.probeCatalogs) {
              offenders.push(`${id}: account model source omitted`);
            }
          }
          // Coding Agent installation accepts the package spelling (ohmypi /
          // ohMyPi) through its existing flavor owner. Finite reviewers use
          // their contributed id and do not participate in that flavor catalog.
          if (declaration.primary !== 'executionRuns' && declaration.cli
            && resolveCanonicalAgentIdFromFlavor(metadata.pluginPackageId) !== binding.implementationOwnerId) {
            offenders.push(`${id}: package install identity does not resolve to the catalog identity`);
          }
          if (declaration.connectedAccounts?.length && declaration.catalog?.vendorResume?.support !== 'unsupported'
            && typeof registration?.connectedAccountLaunch?.continuity?.verifyResumeReachable !== 'function') {
            offenders.push(`${id}: resume reachability hook omitted`);
          }
        }
      } finally {
        await fixture.dispose();
      }
    }
    expect(offenders).toEqual([]);
  });
});
