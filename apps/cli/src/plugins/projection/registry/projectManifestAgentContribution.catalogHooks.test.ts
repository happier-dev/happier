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
    toolDelivery?: 'native_mcp' | 'native_extension' | 'shell_bridge',
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
            ...(toolDelivery ? { tools: { delivery: toolDelivery } } : {}),
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

function loadedExternalAgentPlugin(
    toolDelivery?: 'native_mcp' | 'native_extension' | 'shell_bridge',
): LoadedPlugin {
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
                        ...(toolDelivery ? { tools: { delivery: toolDelivery } } : {}),
                    },
                    catalog: { vendorResume: { support: 'experimental' } },
                }],
            },
        }),
    };
}

const EXTERNAL_AGENT_CLI_METADATA = {
    displayName: 'Acme CLI',
    executable: {
        binaryName: 'acme',
        sourcePreference: 'system-first',
    },
    install: {
        managed: null,
        manual: { kind: 'none' },
    },
    auth: {
        support: 'unsupported',
        loginLaunches: [],
    },
} as const;

function loadedExternalAgentPluginWithCliSystemTool(
    catalog: Readonly<Record<string, unknown>>,
    systemTools: readonly Readonly<Record<string, unknown>>[] = [{
        id: 'acme-cli',
        title: 'Acme CLI',
        executableNames: ['acme'],
    }],
): LoadedPlugin {
    const base = loadedExternalAgentPlugin();
    return {
        ...base,
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
                systemTools,
                agents: [{
                    id: 'acme',
                    title: 'Acme',
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    cli: EXTERNAL_AGENT_CLI_METADATA,
                    capabilities: {
                        sessions: {
                            open: ['create', 'resume'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                    catalog,
                }],
            },
        }),
    };
}

function loadedExternalAgentPluginWithRuntimeActivity(
    runtimeActivitySnapshots: true | undefined,
): LoadedPlugin {
    const base = loadedExternalAgentPlugin();
    return {
        ...base,
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
                            ...(runtimeActivitySnapshots ? { runtimeActivitySnapshots } : {}),
                        },
                    },
                }],
            },
        }),
    };
}

function projectExternalAgentRuntimeActivity(
    runtimeActivitySnapshots: true | undefined,
) {
    const projected = projectLoadedPluginContributes({
        loadResult: {
            loadedPlugins: [loadedExternalAgentPluginWithRuntimeActivity(runtimeActivitySnapshots)],
            diagnosticsByPluginId: {},
        },
        provenance: 'external',
    });
    return (projected.agents ?? []).find((candidate) => candidate.id === `${PLUGIN_ID}/acme`);
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

        const agent = (projected.agents ?? []).find((candidate) => candidate.id === `${PLUGIN_ID}/acme`);
        expect(agent?.catalogEntry?.vendorResumeSupport).toBe('experimental');
    });

    it('projects declared external Agent tool delivery through manifest normalization', () => {
        const projected = projectLoadedPluginContributes({
            loadResult: {
                loadedPlugins: [loadedExternalAgentPlugin('native_mcp')],
                diagnosticsByPluginId: {},
            },
            provenance: 'external',
        });

        const agent = (projected.agents ?? []).find((candidate) => candidate.id === `${PLUGIN_ID}/acme`);
        expect(agent?.catalogEntry?.toolDelivery).toBe('native_mcp');
    });

    // An external Agent's own CLI must be bindable to a system tool it declares,
    // the same fact a bundled Agent supplies through its private runtime
    // contribution. Without it the already-agent-neutral runtime-registry binding
    // in resolveExecutablePluginRuntimeRegistry can never be reached by an
    // external plugin, so `exec.systemTools.resolve` degrades from the canonical
    // Agent CLI launch resolution to a bare executable-name lookup.
    it('projects a declared Agent CLI system-tool binding for an external Agent', () => {
        const projected = projectLoadedPluginContributes({
            loadResult: {
                loadedPlugins: [loadedExternalAgentPluginWithCliSystemTool({
                    agentCliSystemTool: { toolId: 'acme-cli' },
                })],
                diagnosticsByPluginId: {},
            },
            provenance: 'external',
        });

        const agent = (projected.agents ?? []).find((candidate) => candidate.id === `${PLUGIN_ID}/acme`);
        expect(agent?.catalogEntry?.agentCliSystemTool).toEqual({ toolId: 'acme-cli' });
        // The binding is only usable with the Agent's own CLI runtime descriptor,
        // which the runtime registry reads from the same projected contribution.
        expect(agent?.runtimeSpec?.binaryName).toBe('acme');
    });

    it('rejects a manifest whose Agent CLI system-tool binding names no declared system tool', async () => {
        const { validatePluginManifest } = await import('@/plugins/manifest/validate');
        const manifest = loadedExternalAgentPluginWithCliSystemTool(
            { agentCliSystemTool: { toolId: 'missing-cli' } },
        ).manifest;

        const result = validatePluginManifest(manifest, {
            sourceProvenance: 'localSource',
            parsedManifest: manifest as never,
        });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.diagnostics.map((entry) => entry.message)).toEqual([
            expect.stringContaining('missing-cli'),
        ]);
    });

    // Runtime Activity was the widest bundled-only Agent capability left: the host
    // binds a Session's agent-runtime Activity slot only when the catalog entry
    // says `supported`, and the sole declaration seam was the private bundled
    // `AgentRuntimeContribution.runtimeActivityApplicability` key. The public
    // `capabilities.sessions.runtimeActivitySnapshots` declaration an external
    // author can already type had no reader anywhere, so an external Agent that
    // emits the public SDK's `runtime-activity-snapshot` runtime event could never
    // have the host subscribe to it.
    it('projects the declared Runtime Activity capability for an external Agent', () => {
        expect(projectExternalAgentRuntimeActivity(true)?.catalogEntry?.runtimeActivityApplicability)
            .toBe('supported');
    });

    it('leaves an Agent that declares no Runtime Activity capability outside the Activity slot', () => {
        expect(projectExternalAgentRuntimeActivity(undefined)?.catalogEntry)
            .not.toHaveProperty('runtimeActivityApplicability');
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
