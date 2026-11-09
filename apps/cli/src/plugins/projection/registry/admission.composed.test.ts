import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { projectBundledPluginCatalogEntries } from '@/plugins/projection/catalog/installed';
import { ConnectedServiceMaterializedHomeCleanupScheduler } from '@/daemon/connectedServices/materialize/cleanup/ConnectedServiceMaterializedHomeCleanupScheduler';
import { loadBundledPluginLocatorResult, type BundledPluginLocator } from './builtIn/locators';
import { projectBuiltInAgents } from './builtIn/agents';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from './fullProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';

function locator(id: string, contributes: Record<string, unknown>): BundledPluginLocator {
    return {
        pluginId: id, manifestPath: `bundled:${id}`, daemonEntryPath: `/plugins/${id}/daemon.mjs`,
        sourceSpec: { kind: 'bundled', locator: `@happier-dev/plugins-${id.split('.').at(-1)}`,
            trustPolicy: 'local_trusted', installPolicy: 'link' },
        manifest: createPluginManifestV2Fixture({ id, contributes }),
    };
}

const missingAccount = { pluginId: 'happier.fixture.accounts', localId: 'missing' };
function consumer(id = 'happier.fixture.consumer') {
    return locator(id, {
        agents: [{ id: 'consumer', title: 'Consumer', runtime: { kind: 'custom' }, primary: 'sessions',
            capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            connectedAccounts: [{ purpose: 'api', service: missingAccount, required: false,
                credentialKinds: ['token'], materializationKinds: ['environment'] }] }],
    });
}

describe('plugin admission through startup projection and cleanup reconcile', () => {
    it.each([false, true])('activates only admitted declarations (register skipped=%s)', async (registerSkipped) => {
        const action = { title: 'Action', scopes: ['session'], surfaces: ['cli'],
            execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' };
        const bundled = loadBundledPluginLocatorResult([locator('happier.fixture.activation-admission', {
            actions: [{ ...action, id: 'healthy' }, { ...action, id: 'future', futureRestriction: true }],
        })]);
        const projected = projectLoadedPluginContributes({ provenance: 'first_party',
            loadResult: { loadedPlugins: bundled.loadedPlugins, diagnosticsByPluginId: {} } });
        const target = projected.activationTargets?.[0];
        expect(target?.manifest.contributes.actions.map(action => action.id)).toEqual(['healthy']);
        if (!target) throw new Error('Expected admitted activation target');
        const result = await activateContributionModule({ pluginId: target.pluginId,
            occurrenceId: 'admitted-activation', isOccurrenceCurrent: () => true,
            manifest: target.manifest, manifestAuthority: 'bundled_first_party',
            moduleNamespace: { activate(api: PluginApi) {
                api.actions.register('healthy', async () => ({ healthy: true }));
                if (registerSkipped) api.actions.register('future', async () => ({ future: true }));
            } },
        });
        try {
            expect(result.status).toBe(registerSkipped ? 'unavailable' : 'active');
            expect(result.registrations.map(row => row.localId)).toEqual(registerSkipped ? [] : ['healthy']);
            if (registerSkipped) expect(result.diagnostics).toMatchObject([{ code: 'plugin_activation_failed' }]);
            expect(projected.pluginDiagnosticsByPluginId?.[target.pluginId]).toMatchObject([
                { code: 'plugin_contribution_skipped', contribution: { pluginId: target.pluginId, localId: 'future' } },
            ]);
        } finally { await result.dispose(); }
    });
    it('keeps healthy bundled contributions and presents skipped declarations in the catalog', () => {
        const bundled = loadBundledPluginLocatorResult([locator('happier.fixture.partial', {
            actions: [{ id: 'healthy', title: 'Healthy', scopes: ['session'], surfaces: ['cli'],
                execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' },
            { id: 'future', title: 'Future', futureRestriction: true }],
        })]);
        expect(bundled.pluginFailures).toEqual([]);
        expect(bundled.loadedPlugins).toMatchObject([{ manifest: { contributes: { actions: [{ id: 'healthy' }] } } }]);
        expect(projectBundledPluginCatalogEntries(bundled)).toMatchObject([{ enabled: true,
            diagnostics: [expect.objectContaining({ code: 'plugin_contribution_skipped' })] }]);
    });
    it('isolates an invalid Agent manifest even when host imports require its package', () => {
        const bad = locator('happier.agent.codex', {});
        const bundled = loadBundledPluginLocatorResult([{ ...bad, manifest: { schemaVersion: 99 } }], [], [{
            identity: { pluginId: bad.pluginId, localId: 'codex' }, implementationOwnerId: 'codex', registrationFamily: 'agents',
        }]);
        expect(projectBundledPluginCatalogEntries(bundled)).toMatchObject([{
            pluginId: bad.pluginId, enabled: false, compatibility: { status: 'load_error' },
            diagnostics: [{ code: 'plugin_manifest_invalid' }],
        }]);
    });
    it('skips an installed contribution with an unresolved reference before activation', () => {
        const candidate = consumer();
        if (!('manifest' in candidate)) throw new Error('Expected inline fixture');
        const plugin: LoadedPlugin = {
            pluginId: candidate.pluginId, pluginRootPath: '/plugins/consumer', manifestPath: candidate.manifestPath,
            daemonEntryPath: candidate.daemonEntryPath, devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/consumer', trustPolicy: 'local_trusted', installPolicy: 'link' },
            manifest: normalizePluginManifestV2(candidate.manifest),
        };
        const inputs = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [plugin], diagnosticsByPluginId: {} }, provenance: 'external',
        });
        expect(inputs.agents).toEqual([]);
        expect(inputs.pluginDeclarations).toMatchObject([{ pluginId: plugin.pluginId }]);
        expect(inputs.activationTargets).toMatchObject([{ pluginId: plugin.pluginId, manifest: { contributes: { agents: [] } } }]);
        expect(inputs.pluginDiagnosticsByPluginId?.[plugin.pluginId]).toEqual([expect.objectContaining({
            code: 'plugin_contribution_skipped',
        })]);
    });
    it('isolates a bundled dangling descriptor and keeps the healthy graph usable', async () => {
        const provenance = 'first_party';
        const bundled = loadBundledPluginLocatorResult([
            consumer(), locator('happier.fixture.healthy', {}), locator('happier.fixture.accounts', {}),
        ]);
        const inputs = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: bundled.loadedPlugins, diagnosticsByPluginId: Object.fromEntries(
                bundled.pluginFailures.map(failure => [failure.pluginId, [failure.diagnostic]]),
            ) }, provenance,
        });
        const registry = createResolvedContributionRegistry(inputs);
        expect(registry.agents).toEqual([]);
        expect(inputs.activationTargets?.find(target => target.pluginId === 'happier.fixture.consumer')?.manifest.contributes.agents).toEqual([]);
        expect(projectBundledPluginCatalogEntries(bundled)).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: 'happier.fixture.consumer', enabled: true,
                compatibility: expect.objectContaining({ status: 'compatible' }),
                diagnostics: [expect.objectContaining({ code: 'plugin_contribution_skipped' })] }),
            expect.objectContaining({ pluginId: 'happier.fixture.healthy', enabled: true }),
        ]));
        const runtime = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { contributes: registry, pluginIds: [] },
        });
        try {
            expect(runtime.registry.contributes.pluginDeclarations?.map(plugin => plugin.pluginId)).toContain('happier.fixture.healthy');
            const scheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
                baseDir: join(runtime.happyHomeDir, 'homes'), nowMs: () => 0, getLiveMaterializationKeys: () => [],
                getRetainedMaterializationKeys: () => {
                    expect(runtime.registry.contributes.agents).toEqual([]);
                    return [];
                },
            });
            await expect(scheduler.reconcile()).resolves.toEqual([]);
        } finally { await runtime.dispose(); }
    });

    it('keeps a valid qualified descriptor reference admitted', () => {
        const bundled = loadBundledPluginLocatorResult([consumer(), locator(missingAccount.pluginId, {
            connectedAccountDescriptors: [{ id: missingAccount.localId, title: 'Account', authentication: {
                defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }] }],
            } }],
        })]);
        expect(bundled.pluginFailures).toEqual([]);
        const inputs = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: bundled.loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party',
        });
        expect(inputs.agents).toMatchObject([{ pluginId: 'happier.fixture.consumer' }]);
        expect(inputs.connectedAccountDescriptors).toMatchObject([{ pluginId: missingAccount.pluginId }]);
    });

    it.each(['missing', 'invalid'] as const)('keeps startup usable when a bundled Agent manifest is %s', async (kind) => {
        const bad = locator('happier.agent.fixture', {});
        const bundled = loadBundledPluginLocatorResult([
            locator('happier.fixture.healthy', {}),
            ...(kind === 'invalid' ? [{ ...bad, manifest: { schemaVersion: 99 } }] : []),
        ], [], [{ identity: { pluginId: bad.pluginId, localId: 'fixture' },
            implementationOwnerId: 'fixture', registrationFamily: 'agents' }]);
        const projected = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: bundled.loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party',
        });
        expect(projectBuiltInAgents({ manifestAgents: projected.agents ?? [], registrationBindings: [{
            identity: { pluginId: bad.pluginId, localId: 'fixture' }, implementationOwnerId: 'fixture', registrationFamily: 'agents',
        }] })).toEqual([]);
        expect(projectBundledPluginCatalogEntries(bundled)).toEqual(expect.arrayContaining([
            expect.objectContaining({ pluginId: bad.pluginId, enabled: false,
                compatibility: expect.objectContaining({ status: 'load_error' }),
                diagnostics: [expect.objectContaining({ code: kind === 'missing' ? 'plugin_manifest_missing' : 'plugin_manifest_invalid' })] }),
            expect.objectContaining({ pluginId: 'happier.fixture.healthy', enabled: true }),
        ]));
        const runtime = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { contributes: createResolvedContributionRegistry(projected), pluginIds: [] },
        });
        try { expect(runtime.registry.contributes.agents).toEqual([]); }
        finally { await runtime.dispose(); }
    });
});
