import { describe, expect, it } from 'vitest';
import { ScriptKind, ScriptTarget, createSourceFile, isCallExpression, isIdentifier, isObjectLiteralExpression, isPropertyAssignment, isSatisfiesExpression, isVariableStatement } from 'typescript';

import { renderUiBundledPluginEntriesTs } from './agentUi.ts';
import { renderCliBundledPluginEntriesTs, renderCliBundledPluginManifestEntriesTs } from './registry.ts';
import { renderAgentIdsTs } from './agentFacts.ts';
import type { BundledPluginPackage } from './projectionFacts.ts';
import { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '../../../../../packages/agents/src/generated/agentIds';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../../src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { collectBundledPluginUiTranslations } from '../generateBundledPluginEntries.ts';
import { assertHostCanExcludeBundledPlugin } from '../../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';

function emittedMapKeys(source: string, name: string): string[] {
    const file = createSourceFile('projection.ts', source, ScriptTarget.Latest, true, ScriptKind.TS);
    for (const statement of file.statements) {
        if (!isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!isIdentifier(declaration.name) || declaration.name.text !== name) continue;
            if (!declaration.initializer || !isCallExpression(declaration.initializer)) throw new Error(`Missing ${name} initializer`);
            // Object.freeze may wrap an object with a satisfies expression.
            const argument = declaration.initializer.arguments[0];
            const object = argument && isSatisfiesExpression(argument) ? argument.expression : argument;
            if (!object || !isObjectLiteralExpression(object)) throw new Error(`Missing ${name} map`);
            return object.properties.filter(isPropertyAssignment).map((property) => property.name.getText(file).replace(/^['"]|['"]$/gu, ''));
        }
    }
    throw new Error(`Missing ${name}`);
}

describe('bundled Agent exclusion projections', () => {
    it('projects the admitted contribution identity when its local id differs from the UI routing id', () => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.pluginId === 'happier.agent.qwen');
        const parsed = ingestPluginManifestV2(locator?.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        // Like ohMyPi/ohmypi, a retained UI routing id is not the manifest local id.
        const manifest = { ...parsed.manifest, contributes: { ...parsed.manifest.contributes,
            agents: [{ ...parsed.manifest.contributes.agents![0]!, id: 'native-qwen' }],
        } };
        const pluginPackages: readonly BundledPluginPackage[] = [{
            pluginPackageId: 'qwen', pluginId: manifest.id, packageName: '@happier-dev/plugins-qwen',
            packageVersion: '0.0.0', agentId: 'qwen', manifest,
        }];
        const ui = renderUiBundledPluginEntriesTs({ packageNames: pluginPackages.map(entry => entry.packageName), pluginPackages });
        expect(emittedMapKeys(ui, 'BUNDLED_CANONICAL_AGENT_DECLARATIONS')).toEqual(['qwen']);
        expect(ui).toContain('"identity":{"pluginId":"happier.agent.qwen","localId":"native-qwen"}');
    });

    it('publishes Provider definitions and Agent requirements as admitted data without executable adapters', () => {
        const packages = ['happier.agent.qwen', 'happier.agent.claude', 'happier.provider.deepseek'].map(pluginId => {
            const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === pluginId);
            const parsed = ingestPluginManifestV2(locator?.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return parsed.manifest;
        });
        const [qwen, claude, deepseek] = packages;
        const connected = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => ingestPluginManifestV2(locator.manifest))
            .find(parsed => parsed.ok && (parsed.manifest.contributes.connectedAccountDescriptors?.length ?? 0) > 0);
        if (!connected?.ok) throw new Error('Missing admitted Connected Service declaration');
        const requirements = claude!.contributes.agents![0]!.providerRequirements;
        expect(requirements).toBeDefined();
        const manifest = { ...qwen!, contributes: { ...qwen!.contributes,
            agents: [{ ...qwen!.contributes.agents![0]!, providerRequirements: requirements }],
            providers: deepseek!.contributes.providers,
            connectedAccountDescriptors: connected.manifest.contributes.connectedAccountDescriptors,
        } };
        const pluginPackages: readonly BundledPluginPackage[] = [{ pluginPackageId: 'qwen', pluginId: manifest.id,
            packageName: '@happier-dev/plugins-qwen', packageVersion: '0.0.0', agentId: 'qwen', manifest }];
        const ui = renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages });
        expect(emittedMapKeys(ui, 'BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS')).toEqual([
            `${manifest.id}/${manifest.contributes.providers![0]!.id}`,
        ]);
        expect(ui).toContain(`"providerRequirements":${JSON.stringify(requirements)}`);
        expect(ui).toContain(`"definition":${JSON.stringify(manifest.contributes.providers![0])}`);
        expect(ui).not.toContain('"adapterVersion"');
        expect(emittedMapKeys(ui, 'BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS')).toEqual(
            manifest.contributes.connectedAccountDescriptors!.map(descriptor => `${manifest.id}/${descriptor.id}`));
    });

    it('omits excluded optional Agents from both UI maps and executable projections while retaining static identity facts', () => {
        // Full publication passes its admitted packages to these same renderers.
        // In particular the legacy Qwen renderer must not bypass admission.
        const pluginPackages: readonly BundledPluginPackage[] = [];
        for (const packageId of ['qwen', 'antigravity']) {
            expect(() => assertHostCanExcludeBundledPlugin('.', `@happier-dev/plugins-${packageId}`, new Error('fixture publication failed'))).not.toThrow();
        }
        const ui = renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages });
        expect(emittedMapKeys(ui, 'BUNDLED_CANONICAL_AGENTS_CORE')).toEqual([]);
        expect(emittedMapKeys(ui, 'BUNDLED_CANONICAL_AGENTS_UI')).toEqual([]);
        expect(emittedMapKeys(ui, 'BUNDLED_CANONICAL_AGENT_DECLARATIONS')).toEqual([]);
        expect(renderCliBundledPluginEntriesTs({ pluginPackages })).not.toContain('happier.agent.qwen');
        expect(renderCliBundledPluginManifestEntriesTs({ pluginPackages })).not.toContain('happier.agent.qwen');
        expect(collectBundledPluginUiTranslations(pluginPackages)).toEqual({});
        // Identity recognition is data, not admission to UI or executable maps.
        const identities = renderAgentIdsTs({ agentIds: AGENT_IDS, contributionIdentities: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES });
        expect(identities).toContain("'qwen'");
        expect(identities).toContain("'antigravity'");

        // A recovered optional package is included again through the same owner.
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.pluginId === 'happier.agent.qwen');
        const parsed = ingestPluginManifestV2(locator?.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const recoveredPackages: readonly BundledPluginPackage[] = [{
            pluginPackageId: 'qwen', pluginId: parsed.manifest.id,
            packageName: '@happier-dev/plugins-qwen', packageVersion: '0.0.0',
            agentId: 'qwen', manifest: parsed.manifest,
        }];
        const recoveredUi = renderUiBundledPluginEntriesTs({ packageNames: recoveredPackages.map((entry) => entry.packageName), pluginPackages: recoveredPackages });
        expect(emittedMapKeys(recoveredUi, 'BUNDLED_CANONICAL_AGENTS_CORE')).toEqual(['qwen']);
        expect(emittedMapKeys(recoveredUi, 'BUNDLED_CANONICAL_AGENTS_UI')).toEqual(['qwen']);
        expect(emittedMapKeys(recoveredUi, 'BUNDLED_CANONICAL_AGENT_DECLARATIONS')).toEqual(['qwen']);
        expect(renderCliBundledPluginManifestEntriesTs({ pluginPackages: recoveredPackages })).toContain('happier.agent.qwen');
    });
});
