import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { ScriptKind, ScriptTarget, createSourceFile, isCallExpression, isIdentifier, isObjectLiteralExpression, isPropertyAssignment, isSatisfiesExpression, isVariableStatement } from 'typescript';

import { renderBundledAgentPresentationTs, renderUiBundledPluginEntriesTs } from './agentUi.ts';
import { renderBundledAgentDeclarationTypeTs, renderBundledAgentDeclarationsTs, renderBundledUiDeclarationImportsTs } from './uiDeclarations.ts';
import { CLAUDE_UI_DESCRIPTOR } from '../../../../../packages/plugins/claude/src/ui/descriptor';
import { PLUGIN_MANIFEST as CLAUDE_MANIFEST } from '../../../../../packages/plugins/claude/src/manifest';
import { renderCliBundledPluginEntriesTs, renderCliBundledPluginManifestEntriesTs } from './registry.ts';
import { renderAgentIdsTs } from './agentFacts.ts';
import type { BundledPluginPackage } from './projectionFacts.ts';
import { AGENT_IDS, BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '../../../../../packages/agents/src/generated/agentIds';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../../src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { readBundledPluginManifest } from '../../../src/plugins/projection/registry/builtIn/locators';
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
    it('preserves the declared Claude organization usage requirement in the bundled account fallback', () => {
        const parsed = ingestPluginManifestV2(CLAUDE_MANIFEST);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const pluginPackages: readonly BundledPluginPackage[] = [{
            pluginPackageId: 'claude', pluginId: parsed.manifest.id, packageName: '@happier-dev/plugins-claude',
            packageVersion: '0.0.0', agentId: 'claude', manifest: parsed.manifest,
            agentUiDescriptor: CLAUDE_UI_DESCRIPTOR,
        }];
        const source = renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages });
        const file = createSourceFile('projection.ts', source, ScriptTarget.Latest, true, ScriptKind.TS);
        const declaration = file.statements.find(statement => isVariableStatement(statement)
            && statement.declarationList.declarations.some(entry => isIdentifier(entry.name)
                && entry.name.text === 'BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS'));
        if (!declaration) throw new Error('Missing bundled account fallback');
        const exports: Record<string, unknown> = {};
        runInNewContext(transpileModule(declaration.getText(file), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
        expect(exports.BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS).toMatchObject({
            'happier.agent.claude/claude-subscription': {
                descriptor: { usageIdentity: { requiredContext: 'organization' } },
            },
        });
    });

    it('compiles bundled Account settings with heterogeneous nested object schemas', () => {
        const admitted = ingestPluginManifestV2(CLAUDE_MANIFEST);
        if (!admitted.ok) throw new Error(JSON.stringify(admitted.diagnostics));
        const pluginPackages: readonly BundledPluginPackage[] = [{
            pluginPackageId: 'claude', pluginId: admitted.manifest.id, packageName: '@happier-dev/plugins-claude',
            packageVersion: '0.0.0', agentId: 'claude', manifest: admitted.manifest,
        }];
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        const fixtureDir = mkdtempSync(join(tmpdir(), 'bundled-agent-settings-types-'));
        try {
            const fixturePath = join(fixtureDir, 'projection.ts');
            writeFileSync(fixturePath, [
                "import type { CanonicalAgentId } from '@happier-dev/agents';",
                renderBundledUiDeclarationImportsTs(),
                renderBundledAgentDeclarationTypeTs(),
                renderBundledAgentDeclarationsTs(pluginPackages),
            ].join('\n'));
            const configPath = join(fixtureDir, 'tsconfig.json');
            writeFileSync(configPath, JSON.stringify({
                compilerOptions: {
                    strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
                    skipLibCheck: true, types: ['node'], typeRoots: [join(repoRoot, 'node_modules/@types')],
                },
                files: [fixturePath],
            }));
            const compilation = spawnSync(process.execPath, [
                'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit', '-p', configPath,
            ], { cwd: repoRoot, encoding: 'utf8', env: process.env });
            expect(compilation.error).toBeUndefined();
            expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0);
        } finally { rmSync(fixtureDir, { recursive: true, force: true }); }
    });

    it('publishes exact contributed presentation through the existing no-execute producer', () => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === 'happier.agent.claude');
        const parsed = ingestPluginManifestV2(locator ? readBundledPluginManifest(locator) : undefined);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const manifest = { ...parsed.manifest, contributes: { ...parsed.manifest.contributes,
            agents: parsed.manifest.contributes.agents!.map(agent => ({ ...agent,
                title: { key: 'research.agent.title', fallback: 'Declared Research Agent' },
            })),
        } };
        const source = renderBundledAgentPresentationTs([{
            pluginPackageId: 'claude', pluginId: manifest.id, packageName: '@happier-dev/plugins-claude',
            packageVersion: '0.0.0', agentId: 'claude', manifest,
            agentUiDescriptor: { ...CLAUDE_UI_DESCRIPTOR, identityColor: { light: '#112233', dark: '#aabbcc' } },
        }]);
        const exports: Record<string, unknown> = {};
        runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports });
        expect(exports.BUNDLED_AGENT_PRESENTATION).toEqual({
            claude: { name: 'Declared Research Agent', identityColor: { light: '#112233', dark: '#aabbcc' } },
        });
    });

    it('publishes declared provisioner kinds and billing without activating their runtimes', () => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === 'happier.machine.boat');
        const parsed = ingestPluginManifestV2(locator ? readBundledPluginManifest(locator) : undefined);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const pluginPackages: readonly BundledPluginPackage[] = [{ pluginPackageId: 'machine-boat', pluginId: parsed.manifest.id,
            packageName: '@happier-dev/plugins-machine-boat', packageVersion: '0.0.0', manifest: parsed.manifest }];
        const ui = renderUiBundledPluginEntriesTs({ packageNames: [], pluginPackages });
        expect(emittedMapKeys(ui, 'BUNDLED_MACHINE_PROVISIONER_DECLARATIONS')).toEqual(
            parsed.manifest.contributes.machineProvisioners!.map(descriptor => `${parsed.manifest.id}/${descriptor.id}`));
        expect(ui).toContain(`"descriptor":${JSON.stringify(parsed.manifest.contributes.machineProvisioners![0])}`);
        expect(ui).not.toContain('from "@happier-dev/plugins-machine-boat');
        const declaration = createSourceFile('projection.ts', ui, ScriptTarget.Latest, true, ScriptKind.TS).statements
            .find(statement => isVariableStatement(statement) && statement.declarationList.declarations
                .some(entry => isIdentifier(entry.name) && entry.name.text === 'BUNDLED_MACHINE_PROVISIONER_DECLARATIONS'));
        if (!declaration) throw new Error('Missing machine provisioner projection');
        const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
        const temporaryRoot = mkdtempSync(join(tmpdir(), 'bundled-provisioner-projection-'));
        const generated = join(temporaryRoot, 'projection.ts');
        writeFileSync(generated, [
            `import type { PluginContributionIdentityV1 } from ${JSON.stringify(join(repoRoot, 'packages/protocol/src/plugins/contributionIdentity.js'))};`,
            `import type { MachineProvisionerContributionV1 } from ${JSON.stringify(join(repoRoot, 'packages/protocol/src/plugins/contributions/machineProvisioners.js'))};`,
            declaration.getText(),
        ].join('\n'));
        try {
            execFileSync(process.execPath, [
                'scripts/workspaces/runTypeScriptCli.mjs', '--strict', '--noEmit', '--target', 'ES2022',
                '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--types', 'node', generated,
            ], {
                cwd: repoRoot, stdio: 'inherit',
                // The isolated generated-output check uses this already admitted suite's capacity.
                env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true',
                    HAPPIER_DEV_TARGET_EXECUTION: '0', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '' },
            });
        } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
    });
    it('projects the admitted contribution identity when its local id differs from the UI routing id', () => {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((entry) => entry.pluginId === 'happier.agent.qwen');
        const parsed = ingestPluginManifestV2(locator ? readBundledPluginManifest(locator) : undefined);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        // Like ohMyPi/ohmypi, a retained UI routing id is not the manifest local id.
        const withRegistryIdentity = ingestPluginManifestV2({ ...parsed.manifest, contributes: { ...parsed.manifest.contributes,
            agents: [{ ...parsed.manifest.contributes.agents![0]!, id: 'native-qwen', catalog: { acpRegistryIds: ['qwen-code'] } }],
        } });
        if (!withRegistryIdentity.ok) throw new Error(JSON.stringify(withRegistryIdentity.diagnostics));
        const manifest = withRegistryIdentity.manifest;
        const pluginPackages: readonly BundledPluginPackage[] = [{
            pluginPackageId: 'qwen', pluginId: manifest.id, packageName: '@happier-dev/plugins-qwen',
            packageVersion: '0.0.0', agentId: 'qwen', manifest,
        }];
        const ui = renderUiBundledPluginEntriesTs({ packageNames: pluginPackages.map(entry => entry.packageName), pluginPackages });
        expect(emittedMapKeys(ui, 'BUNDLED_CANONICAL_AGENT_DECLARATIONS')).toEqual(['qwen']);
        expect(ui).toContain('"identity":{"pluginId":"happier.agent.qwen","localId":"native-qwen"}');
        expect(ui).toContain('"acpRegistryIds":["qwen-code"]');
    });

    it('publishes Provider definitions and Agent requirements as admitted data without executable adapters', () => {
        const packages = ['happier.agent.qwen', 'happier.agent.claude', 'happier.provider.deepseek'].map(pluginId => {
            const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(entry => entry.pluginId === pluginId);
            const parsed = ingestPluginManifestV2(locator ? readBundledPluginManifest(locator) : undefined);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return parsed.manifest;
        });
        const [qwen, claude, deepseek] = packages;
        const connected = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator => ingestPluginManifestV2(readBundledPluginManifest(locator)))
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
        // Compile the emitted public declarations: omitted presentation is a valid
        // publication outcome even while the shared Agent identity remains known.
        const file = createSourceFile('projection.ts', ui, ScriptTarget.Latest, true, ScriptKind.TS);
        const maps = file.statements.filter(isVariableStatement).filter(statement => (
            statement.declarationList.declarations.some(declaration => (
                isIdentifier(declaration.name) && ['BUNDLED_CANONICAL_AGENTS_CORE', 'BUNDLED_CANONICAL_AGENTS_UI'].includes(declaration.name.text)
            ))
        )).map(statement => statement.getText(file));
        const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-agent-ui-declarations-'));
        try {
            const fixturePath = join(fixtureDir, 'projection.ts');
            writeFileSync(fixturePath, [
                "type CanonicalAgentId = 'qwen' | 'custom-acp';",
                'type AgentCoreConfig = Readonly<{ id: CanonicalAgentId }>;',
                'type AgentUiConfig = Readonly<{ id: string }>;',
                ...maps,
                "const core: AgentCoreConfig | undefined = BUNDLED_CANONICAL_AGENTS_CORE['custom-acp'];",
                "const ui: AgentUiConfig | undefined = BUNDLED_CANONICAL_AGENTS_UI['custom-acp'];",
            ].join('\n'));
            const compilation = spawnSync(process.execPath, [
                fileURLToPath(new URL('../../../../../scripts/workspaces/runTypeScriptCli.mjs', import.meta.url)),
                '--ignoreConfig', '--noEmit', '--strict', '--target', 'ES2022', fixturePath,
            ], { encoding: 'utf8', env: process.env });
            expect(compilation.error).toBeUndefined();
            expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0);
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
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
        const parsed = ingestPluginManifestV2(locator ? readBundledPluginManifest(locator) : undefined);
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
