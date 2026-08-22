import { describe, expect, it, vi } from 'vitest';

import type { PluginAgentContributionV2 } from '@happier-dev/protocol';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

import { projectManifestAgentContribution } from './projectManifestAgentContribution';
import { projectLoadedPluginContributes } from './resolvePluginContributions';

const { readAgentCatalogSnapshot } = vi.hoisted(() => ({
    readAgentCatalogSnapshot: vi.fn(),
}));

vi.mock('@/agent/catalog/snapshot', () => ({
    readAgentCatalogSnapshot,
}));

const PLUGIN_ID = 'com.acme.agent';

function projectExternalAgent(
    catalog: Readonly<Record<string, unknown>> | undefined,
    sessionOpen: readonly ('create' | 'resume' | 'fork')[] = ['create', 'resume'],
) {
    const definition = {
        id: 'acme',
        title: 'Acme',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
            sessions: {
                open: [...sessionOpen],
                delivery: ['newTurn'],
                cancel: true,
            },
        },
        ...(catalog ? { catalog } : {}),
    } as unknown as PluginAgentContributionV2;

    return projectManifestAgentContribution({
        definition,
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: PLUGIN_ID,
    });
}

function loadedExternalAgentPlugin(): LoadedPlugin {
    return {
        pluginId: PLUGIN_ID,
        pluginRootPath: `/plugins/${PLUGIN_ID}`,
        manifestPath: `/plugins/${PLUGIN_ID}/.happier-plugin/plugin.json`,
        daemonEntryPath: `/plugins/${PLUGIN_ID}/daemon.mjs`,
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${PLUGIN_ID}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: normalizePluginManifestV2({
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: '1.0.0',
            displayName: 'Acme Agent',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [], optional: [] },
            contributes: {
                agents: [{
                    id: 'acme',
                    title: 'Acme',
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        sessions: {
                            open: ['create', 'resume'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                    catalog: { vendorResume: { support: 'experimental' } },
                }],
            },
        }),
    };
}

describe('external Agent catalog-entry hook routing', () => {
    it('honours a declared vendor-resume level instead of inferring it from the Session open capability', () => {
        const inferred = projectExternalAgent(undefined);
        expect(inferred.catalogEntry?.vendorResumeSupport).toBe('supported');

        const declaredExperimental = projectExternalAgent({
            vendorResume: { support: 'experimental' },
        });
        expect(declaredExperimental.catalogEntry?.vendorResumeSupport).toBe('experimental');

        const declaredUnsupported = projectExternalAgent({
            vendorResume: { support: 'unsupported' },
        });
        expect(declaredUnsupported.catalogEntry?.vendorResumeSupport).toBe('unsupported');
    });

    it('feeds the projected entry to the session runtime vendor-resume hook', async () => {
        const { getVendorResumeSupport } = await import('@/session/runtime/catalogHooks');

        readAgentCatalogSnapshot.mockReturnValue({
            agentDefinitionsById: new Map(),
            catalogEntriesById: {
                acme: projectExternalAgent({ vendorResume: { support: 'experimental' } }).catalogEntry,
            },
        });
        const experimental = await getVendorResumeSupport('acme');
        expect(experimental({})).toBe(false);

        readAgentCatalogSnapshot.mockReturnValue({
            agentDefinitionsById: new Map(),
            catalogEntriesById: {
                acme: projectExternalAgent({ vendorResume: { support: 'supported' } }).catalogEntry,
            },
        });
        const supported = await getVendorResumeSupport('acme');
        expect(supported({})).toBe(true);
    });

    it('carries the declared catalog block through manifest normalization', () => {
        const projected = projectLoadedPluginContributes({
            loadResult: {
                loadedPlugins: [loadedExternalAgentPlugin()],
                diagnosticsByPluginId: {},
            },
            provenance: 'external',
        });

        const agent = (projected.agents ?? []).find((candidate) => candidate.id === 'acme');
        expect(agent?.catalogEntry?.vendorResumeSupport).toBe('experimental');
    });

    it('exposes the declared level to the daemon spawn gate through the catalog registry', async () => {
        const { requireCatalogEntry } = await import('@/agent/catalog/registry');

        readAgentCatalogSnapshot.mockReturnValue({
            agentDefinitionsById: new Map(),
            catalogEntriesById: {
                acme: projectExternalAgent({ vendorResume: { support: 'experimental' } }).catalogEntry,
            },
        });

        // The spawn gate reads this exact field to qualify its
        // RESUME_NOT_SUPPORTED message as "(experimental and not enabled)".
        expect(requireCatalogEntry('acme').vendorResumeSupport).toBe('experimental');
    });
});
