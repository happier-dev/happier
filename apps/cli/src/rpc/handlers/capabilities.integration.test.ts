import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilitiesDescribeResponse } from '@/capabilities/types';
import { reloadConfiguration } from '@/configuration';
import { SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { publishAccountRegistrySourcesFixture } from '@/plugins/testkit/accountRegistrySources';
import {resetActiveAccountSettingsSnapshotForTests} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PluginCatalogEntry, projectBundledPluginCatalogEntries } from '@/plugins/projection/catalog/installed';
import { loadBundledPluginLocators } from '@/plugins/projection/registry/builtIn/locators';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCliCapabilitiesService } from './capabilities';
import { resolveBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/enablement';
import { InstalledPluginCapabilityEntryV1Schema } from '@happier-dev/protocol/capabilities';

const decideDaemonPluginChangeMock = vi.hoisted(() => vi.fn());

const requestDaemonPluginChangeMock = vi.hoisted(() => vi.fn());

const controlDaemonPluginDevelopmentMock = vi.hoisted(() => vi.fn());

const listDaemonPluginChangesMock = vi.hoisted(() => vi.fn<
    typeof import('@/daemon/controlClient').listDaemonPluginChanges
>(async () => ({ kind: 'available', changes: [] })));

const readDaemonPluginChangeStatusMock = vi.hoisted(() => vi.fn());

const ensureDaemonRunningMock = vi.hoisted(() => vi.fn(async () => undefined));

const promptConfirmYesNoMock = vi.hoisted(() => vi.fn());

const runPluginAuthorToolchainMock = vi.hoisted(() => vi.fn());


vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
    decideDaemonPluginChange: (...args: unknown[]) => decideDaemonPluginChangeMock(...args),
    requestDaemonPluginChange: (...args: unknown[]) => requestDaemonPluginChangeMock(...args),
    controlDaemonPluginDevelopment: (...args: unknown[]) => controlDaemonPluginDevelopmentMock(...args),
    listDaemonPluginChanges: listDaemonPluginChangesMock,
    readDaemonPluginChangeStatus: (...args: unknown[]) => readDaemonPluginChangeStatusMock(...args),
}));

vi.mock('@/plugins/authoring/toolchain', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/plugins/authoring/toolchain')>();
    runPluginAuthorToolchainMock.mockImplementation(original.runPluginAuthorToolchain);
    return {
        ...original,
        runPluginAuthorToolchain: (...args: Parameters<typeof original.runPluginAuthorToolchain>) => (
            runPluginAuthorToolchainMock(...args)
        ),
    };
});

vi.mock('@/daemon/ensureDaemon', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/ensureDaemon')>()),
    ensureDaemonRunningForSessionCommand: () => ensureDaemonRunningMock(),
}));

vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
    promptConfirmYesNo: (...args: unknown[]) => promptConfirmYesNoMock(...args),
}));


function createDevelopmentCatalogEntry(pluginRoot: string): PluginCatalogEntry {
    return {
        pluginId: 'acme.development-actions',
        desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1',
        admittedIntegrity: null,
        title: 'Development Actions',
        description: null,
        version: '0.1.0',
        enabled: true,
        source: {
            kind: 'path',
            locator: pluginRoot,
            resolvedPath: pluginRoot,
            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            trustPolicy: 'prompt',
            installPolicy: 'link',
            devWatch: true,
        },
        install: { mode: 'link', manifestVersion: '0.1.0' },
        compatibility: { status: 'compatible', diagnostics: [] },
        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
        manifest: null,
        contributionIntrospection: {
            version: 1,
            generation: 1,
            contributions: [],
            diagnostics: [],
        },
        diagnostics: [],
    };
}


// Boundary fixtures only: remote marketplace retrieval and daemon/process/user interaction.
// The in-process exact-install and user-change owners remain real in this suite.


vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
    decideDaemonPluginChange: (...args: unknown[]) => decideDaemonPluginChangeMock(...args),
    requestDaemonPluginChange: (...args: unknown[]) => requestDaemonPluginChangeMock(...args),
    controlDaemonPluginDevelopment: (...args: unknown[]) => controlDaemonPluginDevelopmentMock(...args),
    listDaemonPluginChanges: listDaemonPluginChangesMock,
    readDaemonPluginChangeStatus: (...args: unknown[]) => readDaemonPluginChangeStatusMock(...args),
}));

vi.mock('@/plugins/authoring/toolchain', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/plugins/authoring/toolchain')>();
    runPluginAuthorToolchainMock.mockImplementation(original.runPluginAuthorToolchain);
    return {
        ...original,
        runPluginAuthorToolchain: (...args: Parameters<typeof original.runPluginAuthorToolchain>) => (
            runPluginAuthorToolchainMock(...args)
        ),
    };
});

vi.mock('@/daemon/ensureDaemon', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/ensureDaemon')>()),
    ensureDaemonRunningForSessionCommand: () => ensureDaemonRunningMock(),
}));

vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
    promptConfirmYesNo: (...args: unknown[]) => promptConfirmYesNoMock(...args),
}));

describe('createCliCapabilitiesService installable dependencies', () => {
    afterEach(() => {
        vi.doUnmock('@/agent/catalog/registry');
        vi.doUnmock('@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter');
        vi.doUnmock('@/plugins/projection/registry/createResolvedContributionRegistry');
        vi.resetModules();
    });

    it('describes external Agent CLI capabilities from the resolved contribution registry without reading the global AGENTS facade', async () => {
        vi.resetModules();
        vi.doMock('@/agent/catalog/registry', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/agent/catalog/registry')>();
            return {
                ...actual,
                AGENTS: new Proxy({}, {
                    ownKeys() {
                        throw new Error('global AGENTS facade must not be enumerated');
                    },
                    get() {
                        throw new Error('global AGENTS facade must not be read');
                    },
                }),
            };
        });
        vi.doMock('@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter', () => ({
            resolvePreflightSessionControlsProbeAdapter: async () => null,
        }));
        vi.doMock('@/plugins/projection/registry/createResolvedContributionRegistry', () => {
            const agent = Object.freeze({
                id: 'acmeExternal',
                provenance: 'external',
                source: Object.freeze({ kind: 'path' }),
                definition: Object.freeze({}),
            });
            const registry = Object.freeze({
                agents: Object.freeze([agent]),
                agentDefinitionsById: new Map([['acmeExternal', agent]]),
                actions: Object.freeze([]),
                resources: Object.freeze([]),
            });
            return {
                getResolvedContributionRegistry: () => registry,
                resolveMergedContributionRegistry: async () => registry,
            };
        });

        const { createCliCapabilitiesService: createService } = await import('./capabilities');
        const service = await createService({ readPluginCatalog: async () => [] });
        const described = service.describe() as CapabilitiesDescribeResponse;

        expect(described.capabilities.find((capability) => capability.id === 'cli.acmeExternal'))
            .toMatchObject({ id: 'cli.acmeExternal', kind: 'cli' });
    });

    it('keeps the request-only Codex ACP vendorRecipe dependency out of executable installable capabilities', async () => {
        vi.resetModules();

        const home = await createTempDir('happier-cli-capabilities-installables-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const { createCliCapabilitiesService: createService } = await import('./capabilities');
            const service = await createService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            // dep.gh proves the described set includes executable installables,
            // so the codex-acp absence below is discriminating rather than
            // vacuous: its vendorRecipe contribution stays request-only at the
            // canonical executable-managed-dependency owner and must never be
            // coerced into an install/upgrade capability.
            expect(described.capabilities.find((capability) => capability.id === 'dep.gh')).toMatchObject({
                id: 'dep.gh',
                kind: 'dep',
            });
            expect(described.capabilities.find((capability) => capability.id === 'dep.codex-acp')).toBeUndefined();
        } finally {
            await removeTempDir(home);
            envScope.restore();
            reloadConfiguration();
        }
    });
});

describe('createCliCapabilitiesService dep.gh', () => {
    it('describes gh as a generic installable dependency capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-gh-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            expect(described.capabilities.find((capability) => capability.id === 'dep.gh')).toMatchObject({
                id: 'dep.gh',
                kind: 'dep',
                methods: expect.objectContaining({
                    install: expect.any(Object),
                    upgrade: expect.any(Object),
                }),
            });
        } finally {
            await removeTempDir(home);
            envScope.restore();
            reloadConfiguration();
        }
    });
});

describe('createCliCapabilitiesService dep.az', () => {
    it('describes Azure CLI as a detect-only generic installable dependency capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-az-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            const azCapability = described.capabilities.find((capability) => capability.id === 'dep.az');
            expect(azCapability).toMatchObject({
                id: 'dep.az',
                kind: 'dep',
            });
            expect(azCapability).not.toHaveProperty('methods');
        } finally {
            await removeTempDir(home);
            envScope.restore();
            reloadConfiguration();
        }
    });
});

describe('createCliCapabilitiesService tool.plugins', () => {
    beforeEach(() => {
        publishAccountRegistrySourcesFixture();
        controlDaemonPluginDevelopmentMock.mockResolvedValue({
            kind: 'status',
            status: { roots: [], plugins: [] },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();resetActiveAccountSettingsSnapshotForTests();
        decideDaemonPluginChangeMock.mockReset();
        requestDaemonPluginChangeMock.mockReset();
        controlDaemonPluginDevelopmentMock.mockReset();
        listDaemonPluginChangesMock.mockReset();
        listDaemonPluginChangesMock.mockResolvedValue({ kind: 'available', changes: [] });
        readDaemonPluginChangeStatusMock.mockReset();
        readDaemonPluginChangeStatusMock.mockResolvedValue({ kind: 'expired' });
        ensureDaemonRunningMock.mockClear();
        promptConfirmYesNoMock.mockReset();
        runPluginAuthorToolchainMock.mockClear();
    });

    it('returns desired and applied generation from the canonical daemon catalog in capability detect', async () => {
        const currentEntry = {
            pluginId: 'acme.current',
            desiredGeneration: 'generation-2',
            appliedGeneration: 'generation-2',
            admittedIntegrity: null,
            title: 'Current',
            description: null,
            version: '2.0.0',
            enabled: true,
            source: {
                kind: 'path',
                locator: '/plugins/acme.current',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
                resolvedPath: '/plugins/acme.current',
                manifestPath: '/plugins/acme.current/.happier-plugin/plugin.json',
            },
            install: { mode: 'link', manifestVersion: '2.0.0' },
            compatibility: { status: 'compatible', diagnostics: [] },
            manifestPath: '/plugins/acme.current/.happier-plugin/plugin.json',
            manifest: readCanonicalPluginManifest(createPluginManifestV2Fixture({ id: 'acme.current' })),
            contributionIntrospection: {
                version: 1,
                generation: 2,
                contributions: [],
                diagnostics: [],
            },
            diagnostics: [],
        } satisfies PluginCatalogEntry;
        const service = await createCliCapabilitiesService({
            readPluginCatalog: async () => Object.freeze([currentEntry]),
        });

        const response = await service.detect({
            requests: [{ id: 'tool.plugins' }],
        });
        expect(response).toMatchObject({
            results: {
                'tool.plugins': {
                    ok: true,
                    data: {
                        installedPlugins: [{
                            pluginId: 'acme.current',
                            desiredGeneration: 'generation-2',
                            appliedGeneration: 'generation-2',
                        }],
                    },
                },
            },
        });
        const installed = (response.results['tool.plugins'] as { data?: { installedPlugins?: unknown[] } })
            .data?.installedPlugins?.[0];
        expect(Object.hasOwn(installed as object, 'manifest')).toBe(false);
        expect(Object.hasOwn(installed as object, 'manifestPath')).toBe(false);
        expect(Object.hasOwn(installed as object, 'contributionIntrospection')).toBe(false);
    });

    it.each([[false, true], [true, false], [true, true]] as const)(
        'projects canonical Account=%s Machine=%s bundled enablement through the capability schema',
        async (accountEnabled, machineEnabled) => {
            const pluginId = 'happier.app-context';
            const pluginEnablementById = resolveBundledPluginEnablement({
                pluginIds: [pluginId],
                accountEnabledById: new Map([[pluginId, accountEnabled]]),
                machineEnabledById: { [pluginId]: machineEnabled },
            });
            const catalog = projectBundledPluginCatalogEntries({
                loadedPlugins: loadBundledPluginLocators(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter(locator => locator.pluginId === pluginId)),
                pluginEnablementById,
            });
            const service = await createCliCapabilitiesService({ readPluginCatalog: async () => catalog });
            const response = await service.detect({ requests: [{ id: 'tool.plugins' }] });
            const entries = (response.results['tool.plugins'] as { data?: { installedPlugins?: unknown[] } })
                .data?.installedPlugins ?? [];
            expect(entries).toHaveLength(1);
            expect(InstalledPluginCapabilityEntryV1Schema.parse(entries[0])).toMatchObject({
                pluginId,
                ...pluginEnablementById[pluginId],
            });
        },
    );

    it('keeps bundled manifest detail out of the marketplace capability response', async () => {
        const catalog = projectBundledPluginCatalogEntries({
            loadedPlugins: loadBundledPluginLocators(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS),
        });
        const service = await createCliCapabilitiesService({ readPluginCatalog: async () => catalog });
        const response = await service.detect({ requests: [{ id: 'tool.plugins' }] });
        const entries = (response.results['tool.plugins'] as { data?: { installedPlugins?: unknown[] } })
            .data?.installedPlugins ?? [];
        const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
        expect(entries).toHaveLength(catalog.length);
        expect(entries.every((entry) => !Object.hasOwn(entry as object, 'manifest'))).toBe(true);
        expect(bytes(response)).toBeLessThan(bytes(catalog));
    });

    it('passes the current CLI invoker into capability-created scaffold scripts and generated skill guidance', async () => {
        const home = await createTempDir('happier-cli-capabilities-plugin-create-');
        const targetDir = join(home, 'generated-plugin');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_CLI_INVOKER_NAME']);
        envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_CLI_INVOKER_NAME: 'hdev' });
        reloadConfiguration();

        try {
            const service = await createCliCapabilitiesService({
                readPluginCatalog: async () => Object.freeze([]),
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'create',
                params: {
                    targetDir,
                    pluginId: 'acme.capability-created',
                    displayName: 'Capability Created',
                },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'create',
                    pluginId: 'acme.capability-created',
                    sourceRootPath: targetDir,
                },
            });

            const packageJson = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as Readonly<{
                scripts: Readonly<Record<string, string>>;
            }>;
            const skill = await readFile(join(
                targetDir,
                '.agents',
                'skills',
                'happier-plugin-authoring',
                'SKILL.md',
            ), 'utf8');

            expect(packageJson.scripts.build).toBe('hdev plugins dev build .');
            expect(packageJson.scripts.typecheck).toBe('hdev plugins dev typecheck .');
            expect(packageJson.scripts.test).toBe('hdev plugins test .');
            expect(packageJson.scripts['pack:plugin']).toBe('hdev plugins pack .');
            expect(skill).toContain('hdev plugins dev');
            expect(skill).toContain('hdev plugins doctor .');
            expect(skill).not.toContain('happier plugins dev');
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
        }
    });

    it('projects the daemon\'s outstanding decisions and rejoins one by its issued id', async () => {
        // A change an Agent prepared has no caller left holding the issued id.
        // The capability that already carries plugin truth to the app carries
        // the outstanding decisions too, and the by-id rejoin is what the app
        // re-reads before asking a user to approve anything.
        const sourceRootReview = {
            kind: 'reviewRequired', reviewKind: 'projectTrust',
            pendingChangeId: 'pending-agent-1',
            review: { source: { kind: 'path', locator: '/workspace/plugins/agent-authored' } },
        } as const;
        listDaemonPluginChangesMock.mockResolvedValue({ kind: 'available', changes: [sourceRootReview] });
        readDaemonPluginChangeStatusMock.mockResolvedValue({ kind: 'applying', pendingChangeId: 'pending-agent-1' });
        const service = await createCliCapabilitiesService({
            readPluginCatalog: async () => Object.freeze([]),
        });

        await expect(service.detect({
            requests: [{ id: 'tool.plugins' }],
        })).resolves.toMatchObject({
            results: {
                'tool.plugins': { ok: true, data: { pendingChanges: [sourceRootReview] } },
            },
        });

        await expect(service.invoke({
            id: 'tool.plugins',
            method: 'changeStatus',
            params: { pendingChangeId: 'pending-agent-1' },
        })).resolves.toEqual({
            ok: true,
            result: {
                action: 'changeStatus',
                pendingChangeId: 'pending-agent-1',
                status: { kind: 'applying', pendingChangeId: 'pending-agent-1' },
            },
        });
        expect(readDaemonPluginChangeStatusMock).toHaveBeenCalledWith({ pendingChangeId: 'pending-agent-1' });

        // Rejoining is a read: it never creates a candidate and never decides.
        expect(requestDaemonPluginChangeMock).not.toHaveBeenCalled();
        expect(decideDaemonPluginChangeMock).not.toHaveBeenCalled();

        await expect(service.invoke({
            id: 'tool.plugins',
            method: 'changeStatus',
            params: {},
        })).resolves.toEqual({
            ok: false,
            error: { message: 'pendingChangeId is required', code: 'plugin_change_missing' },
        });
    });


    it('rejects the hidden install decision method without contacting the daemon decision command', async () => {
        decideDaemonPluginChangeMock.mockResolvedValue({
            kind: 'committed',
            pluginId: SAMPLE_PLUGIN_ID,
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
            pendingSurfaces: [],
        });
        const service = await createCliCapabilitiesService();

        await expect(service.invoke({
            id: 'tool.plugins',
            method: 'decideInstall',
            params: {
                pendingChangeId: 'pending-community',
                decision: 'installAndTrust',
                optionalSelections: [{ accessId: 'sessions', selected: false }],
            },
        })).resolves.toEqual({
            ok: false,
            error: {
                message: 'Unsupported method: decideInstall',
                code: 'unsupported-method',
            },
        });
        expect(decideDaemonPluginChangeMock).not.toHaveBeenCalled();
    });


    it('resolves the current folder or single-file Edit target and rejects stale development state', async () => {
        const home = await createTempDir('happier-cli-capabilities-plugin-edit-');
        const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-edit-source-'));
        const folderSource = join(parent, 'folder-plugin');
        const singleFileSource = join(parent, 'file-plugin.ts');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        envScope.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();

        const writeDevelopmentSource = async (input: Readonly<{
            locator: string;
            resolvedPath: string;
            devWatch: boolean;
        }>) => {
            await createPluginStateStore({ happyHomeDir: home }).write({
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {
                    'acme.edit-target': {
                        source: {
                            kind: 'path',
                            locator: input.locator,
                            resolvedPath: input.resolvedPath,
                            manifestPath: input.locator,
                            trustPolicy: 'prompt',
                            installPolicy: 'link',
                            devWatch: input.devWatch,
                        },
                        compatibility: { status: 'compatible', diagnostics: [] },
                        install: { mode: 'link', manifestVersion: '0.1.0' },
                        state: { enabled: true },
                    },
                },
            });
        };

        try {
            await mkdir(folderSource, { recursive: true });
            await writeFile(singleFileSource, 'export function activate() {}\n', 'utf8');
            const service = await createCliCapabilitiesService();
            expect((service.describe() as CapabilitiesDescribeResponse).capabilities
                .find((capability) => capability.id === 'tool.plugins')).toMatchObject({
                methods: expect.objectContaining({ edit: expect.any(Object) }),
            });

            await writeDevelopmentSource({
                locator: folderSource,
                resolvedPath: folderSource,
                devWatch: true,
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'edit',
                params: { pluginId: 'acme.edit-target', sourceRootPath: '/client/stale-source' },
            })).resolves.toEqual({
                ok: true,
                result: {
                    action: 'edit',
                    pluginId: 'acme.edit-target',
                    sourceRootPath: folderSource,
                    sessionDirectory: folderSource,
                },
            });

            await writeDevelopmentSource({
                locator: singleFileSource,
                resolvedPath: parent,
                devWatch: true,
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'edit',
                params: { pluginId: 'acme.edit-target' },
            })).resolves.toEqual({
                ok: true,
                result: {
                    action: 'edit',
                    pluginId: 'acme.edit-target',
                    sourceRootPath: singleFileSource,
                    sessionDirectory: parent,
                },
            });

            await writeDevelopmentSource({
                locator: singleFileSource,
                resolvedPath: parent,
                devWatch: false,
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'edit',
                params: { pluginId: 'acme.edit-target' },
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'plugin-development-source-unavailable' },
            });

            await createPluginStateStore({ happyHomeDir: home }).write({
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {},
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'edit',
                params: { pluginId: 'acme.edit-target' },
            })).resolves.toMatchObject({ ok: false, error: { code: 'plugin-not-found' } });
        } finally {
            envScope.restore();
            reloadConfiguration();
            await rm(parent, { recursive: true, force: true });
            await removeTempDir(home);
        }
    });
    it('forwards the canonical scaffold UI mode through the daemon create capability', async () => {
        // `PluginScaffoldUiModeSchema` is the single vocabulary owner the CLI
        // `--ui` flag and the `plugins.scaffold` action input both resolve
        // through. The daemon capability is the third caller of the same
        // scaffold; dropping the mode here makes every plugin created from the
        // app a non-UI plugin, and no in-app step can repair that afterwards.
        const home = await createTempDir('happier-cli-capabilities-scaffold-ui-');
        const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-ui-'));
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();
        try {
            const service = await createCliCapabilitiesService();
            const createdUiRoot = join(parent, 'created-ui-plugin');
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'create',
                params: {
                    targetDir: createdUiRoot,
                    pluginId: 'acme.created-ui-from-settings',
                    displayName: 'Created UI from Settings',
                    ui: 'reactNative',
                },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'create',
                    pluginId: 'acme.created-ui-from-settings',
                    sourceRootPath: createdUiRoot,
                    uiEntryPath: join(createdUiRoot, 'src', 'ui', 'renderSurface.tsx'),
                },
            });
            await expect(readFile(join(createdUiRoot, 'src', 'ui', 'renderSurface.tsx'), 'utf8'))
                .resolves.toContain('renderSurface');
            await expect(readFile(join(createdUiRoot, 'src', 'ui', 'surfaces.ts'), 'utf8'))
                .resolves.toContain("kind: 'reactNative'");

            // An unrecognised mode is rejected rather than silently scaffolding
            // a plugin without the UI the caller asked for.
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'create',
                params: {
                    targetDir: join(parent, 'created-bogus-ui-plugin'),
                    pluginId: 'acme.created-bogus-ui',
                    displayName: 'Created bogus UI',
                    ui: 'not-a-renderer',
                },
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'plugin_scaffold_invalid_input' },
            });
        } finally {
            envScope.restore();
            reloadConfiguration();
            await rm(parent, { recursive: true, force: true });
            await removeTempDir(home);
        }
    });

    it('forwards the Session Agent template through the daemon create capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-scaffold-session-agent-');
        const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-session-agent-rpc-'));
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();
        try {
            const service = await createCliCapabilitiesService();
            const targetDir = join(parent, 'created-session-agent');
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'create',
                params: {
                    targetDir,
                    pluginId: 'acme.rpc-session-agent',
                    displayName: 'RPC Session Agent',
                    template: 'session-agent',
                },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'create',
                    pluginId: 'acme.rpc-session-agent',
                    sourceRootPath: targetDir,
                },
            });

            await expect(readFile(join(targetDir, 'src', 'agent', 'sessionAgent.ts'), 'utf8'))
                .resolves.toContain('export const createSessionAgentRuntime');
        } finally {
            envScope.restore();
            reloadConfiguration();
            await rm(parent, { recursive: true, force: true });
            await removeTempDir(home);
        }
    });

    it.each(['develop', 'unregisterDevelopment', 'test', 'pack', 'install', 'update', 'setUpdatePolicy',
        'enable', 'disable', 'rollback', 'uninstall', 'forgetTrust'])('rejects retired plugin mutation capability %s', async (method) => {
        const service = await createCliCapabilitiesService();
        const described = service.describe() as CapabilitiesDescribeResponse;
        expect(described.capabilities.find((capability) => capability.id === 'tool.plugins')?.methods)
            .not.toHaveProperty(method);
        await expect(service.invoke({
            id: 'tool.plugins', method, params: { sourceRootPath: '/workspace/plugin' },
        })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported-method' } });
    });
});

describe('createCliCapabilitiesService tool.plugins', () => {
    beforeEach(() => {
        publishAccountRegistrySourcesFixture();
        controlDaemonPluginDevelopmentMock.mockResolvedValue({
            kind: 'status',
            status: { roots: [], plugins: [] },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();resetActiveAccountSettingsSnapshotForTests();
        decideDaemonPluginChangeMock.mockReset();
        requestDaemonPluginChangeMock.mockReset();
        controlDaemonPluginDevelopmentMock.mockReset();
        listDaemonPluginChangesMock.mockReset();
        listDaemonPluginChangesMock.mockResolvedValue({ kind: 'available', changes: [] });
        readDaemonPluginChangeStatusMock.mockReset();
        readDaemonPluginChangeStatusMock.mockResolvedValue({ kind: 'expired' });
        ensureDaemonRunningMock.mockClear();
        promptConfirmYesNoMock.mockReset();
        runPluginAuthorToolchainMock.mockClear();
    });

    it('projects development status and scaffolds through the remaining creation capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-plugin-development-');
        const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-development-source-'));
        const pluginRoot = join(parent, 'plugin');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();
        try {
            const scaffold = await scaffoldLocalPlugin({
                targetDir: pluginRoot,
                pluginId: 'acme.development-actions',
                displayName: 'Development Actions',
            });
            expect(scaffold.ok).toBe(true);
            if (!scaffold.ok) return;
            const service = await createCliCapabilitiesService({
                readPluginCatalog: async () => Object.freeze([
                    createDevelopmentCatalogEntry(pluginRoot),
                ]),
            });
            controlDaemonPluginDevelopmentMock.mockResolvedValueOnce({
                kind: 'status',
                status: {
                    roots: [{ kind: 'explicit', rootPath: pluginRoot, trusted: true, persisted: true }],
                    plugins: [{
                        pluginId: 'acme.development-actions',
                        sourceRootPath: pluginRoot,
                        phase: 'active',
                        occurrenceId: 'occurrence-development-actions',
                        uiArtifactDigest: 'sha256:development-actions',
                    }],
                },
            });
            const described = service.describe() as CapabilitiesDescribeResponse;
            expect(described.capabilities.find((capability) => capability.id === 'tool.plugins')).toMatchObject({
                methods: expect.objectContaining({
                    create: expect.any(Object),
                }),
            });
            await expect(service.detect({
                requests: [{ id: 'tool.plugins' }],
            })).resolves.toMatchObject({
                results: {
                    'tool.plugins': {
                        ok: true,
                        data: {
                            developmentActions: { create: true },
                            developmentStatus: {
                                roots: [{ kind: 'explicit', rootPath: pluginRoot, trusted: true, persisted: true }],
                                plugins: [{
                                    pluginId: 'acme.development-actions',
                                    sourceRootPath: pluginRoot,
                                    phase: 'active',
                                    occurrenceId: 'occurrence-development-actions',
                                    uiArtifactDigest: 'sha256:development-actions',
                                }],
                            },
                        },
                    },
                },
            });
            expect(controlDaemonPluginDevelopmentMock).toHaveBeenCalledWith({ kind: 'status' });

            const createdRoot = join(parent, 'created-plugin');
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'create',
                params: {
                    targetDir: createdRoot,
                    pluginId: 'acme.created-from-settings',
                    displayName: 'Created from Settings',
                },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'create',
                    pluginId: 'acme.created-from-settings',
                    sourceRootPath: createdRoot,
                    sourceEntryPath: join(createdRoot, 'src', 'index.ts'),
                },
            });
            await expect(readFile(join(createdRoot, '.happier-plugin', 'plugin.json'), 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(join(createdRoot, 'src', 'index.ts'), 'utf8'))
                .resolves.toContain("id: \"acme.created-from-settings\"");


        } finally {
            envScope.restore();
            reloadConfiguration();
            await rm(parent, { recursive: true, force: true });
            await removeTempDir(home);
        }
    }, 60_000);
});
