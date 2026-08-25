import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapabilitiesDescribeResponse } from '@/capabilities/types';
import { reloadConfiguration } from '@/configuration';
import { SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { bundlePluginDaemonRuntime } from '@/plugins/authoring/bundleDaemonRuntime';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import {
    createNpmPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { DaemonPluginChangePreparationError } from '@/plugins/daemon/changeService';
import { resolveInstalledPluginUpdate } from '@/plugins/daemon/resolveInstalledUpdate';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';

import { createCliCapabilitiesService } from './capabilities';

const loadMarketplaceIndexSourceMock = vi.hoisted(() => vi.fn());
const decideDaemonPluginChangeMock = vi.hoisted(() => vi.fn());
const requestDaemonPluginChangeMock = vi.hoisted(() => vi.fn());
const requestDaemonPluginDevelopmentPreflightMock = vi.hoisted(() => vi.fn());
const listDaemonPluginChangesMock = vi.hoisted(() => vi.fn());
const readDaemonPluginChangeStatusMock = vi.hoisted(() => vi.fn());
const ensureDaemonRunningMock = vi.hoisted(() => vi.fn(async () => undefined));
const promptConfirmYesNoMock = vi.hoisted(() => vi.fn());
const runPluginAuthorToolchainMock = vi.hoisted(() => vi.fn());
const runPluginUiArtifactBuildMock = vi.hoisted(() => vi.fn());

function createMarketplaceSnapshot(params: Readonly<{
    source: Readonly<{
        id: string;
        title: string;
        sourceUrl: string;
        kind: 'curated' | 'community-npm';
    }>;
}>) {
    return {
        source: params.source,
        freshness: { state: 'fresh' as const, fetchedAtMs: Date.now() },
        entries: [{
            pluginId: SAMPLE_PLUGIN_ID,
            publisher: { id: 'acme', displayName: 'Acme' },
            display: { title: 'Acme Sample', description: 'Reviewed sample plugin' },
            distribution: {
                kind: 'npm' as const,
                registryOrigin: 'https://registry.npmjs.org',
                packageName: '@acme/sample',
                version: '1.0.0',
                integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
            },
            manifestDigest: `sha256:${'a'.repeat(64)}`,
            compatibility: { happier: '>=1.0.0', platforms: ['darwin' as const] },
            summary: {
                contributions: ['actions'],
                requiredHostAccess: [],
                optionalHostAccess: [],
                executableRealms: ['daemon' as const],
            },
            review: params.source.kind === 'curated'
                ? { status: 'approved' as const, reviewedAt: '2026-07-22T00:00:00.000Z' }
                : { status: 'unreviewed' as const, reviewedAt: null },
            categories: ['actions'],
            media: [],
            updatePolicy: params.source.kind === 'curated' ? 'curated-auto' as const : 'manual' as const,
            links: {},
        }],
        diagnostics: [],
    };
}

async function writeManagedRuntimeFixture(homeDir: string): Promise<void> {
    const binDir = join(homeDir, 'tools', 'js-runtime', 'current', 'bin');
    const runtimeDir = join(homeDir, 'tools', 'js-runtime', 'current', 'runtime');
    const wrapperPath = join(binDir, process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
    const runtimePath = process.platform === 'win32'
        ? join(runtimeDir, 'node.exe')
        : join(runtimeDir, 'bin', 'node');
    await mkdir(binDir, { recursive: true });
    await mkdir(join(runtimePath, '..'), { recursive: true });
    if (process.platform === 'win32') {
        await copyFile(process.execPath, runtimePath);
        await writeFile(wrapperPath, '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n', 'utf8');
    } else {
        await symlink(process.execPath, runtimePath);
        await writeFile(wrapperPath, '#!/bin/sh\nexec "${0%/*}/../runtime/bin/node" "$@"\n', 'utf8');
        await chmod(wrapperPath, 0o755);
    }
}

async function linkPluginAuthorDependency(
    projectRoot: string,
    packageName: string,
    source: string,
): Promise<void> {
    const destination = join(projectRoot, 'node_modules', ...packageName.split('/'));
    await mkdir(join(destination, '..'), { recursive: true });
    await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

async function copyNativeTypeScriptAuthorDependency(projectRoot: string): Promise<void> {
    const sourceScope = fileURLToPath(new URL('../../../../../node_modules/@typescript', import.meta.url));
    const destinationScope = join(projectRoot, 'node_modules', '@typescript');
    await mkdir(destinationScope, { recursive: true });
    const installedPackages = (await readdir(sourceScope))
        .filter((name) => name === 'native' || name.startsWith('typescript-'));
    for (const name of installedPackages) {
        await cp(join(sourceScope, name), join(destinationScope, name), { recursive: true });
    }
}

// Boundary fixtures only: remote marketplace retrieval and daemon/process/user interaction.
// The in-process exact-install and user-change owners remain real in this suite.
vi.mock('@/plugins/store/marketplace/indexSourceLoader', () => ({
    loadMarketplaceIndexSource: (...args: unknown[]) => loadMarketplaceIndexSourceMock(...args),
}));
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
    decideDaemonPluginChange: (...args: unknown[]) => decideDaemonPluginChangeMock(...args),
    requestDaemonPluginChange: (...args: unknown[]) => requestDaemonPluginChangeMock(...args),
    requestDaemonPluginDevelopmentPreflight: (...args: unknown[]) => (
        requestDaemonPluginDevelopmentPreflightMock(...args)
    ),
    listDaemonPluginChanges: (...args: unknown[]) => listDaemonPluginChangesMock(...args),
    readDaemonPluginChangeStatus: (...args: unknown[]) => readDaemonPluginChangeStatusMock(...args),
}));
vi.mock('@/plugins/authoring/toolchain', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/plugins/authoring/toolchain')>();
    runPluginAuthorToolchainMock.mockImplementation(original.runPluginAuthorToolchain);
    runPluginUiArtifactBuildMock.mockImplementation(original.runPluginUiArtifactBuild);
    return {
        ...original,
        runPluginAuthorToolchain: (...args: Parameters<typeof original.runPluginAuthorToolchain>) => (
            runPluginAuthorToolchainMock(...args)
        ),
        runPluginUiArtifactBuild: (...args: Parameters<typeof original.runPluginUiArtifactBuild>) => (
            runPluginUiArtifactBuildMock(...args)
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
        vi.resetModules();
    });

    it('describes Codex ACP from installable contributions when the backend has no local capability hook', async () => {
        vi.resetModules();
        vi.doMock('@/agent/catalog/registry', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/agent/catalog/registry')>();
            return {
                ...actual,
                AGENTS: {
                    ...actual.AGENTS,
                    codex: {
                        ...actual.AGENTS.codex,
                        getCapabilities: undefined,
                    },
                },
            };
        });

        const home = await createTempDir('happier-cli-capabilities-installables-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const { createCliCapabilitiesService: createService } = await import('./capabilities');
            const service = await createService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            expect(described.capabilities.find((capability) => capability.id === 'dep.codex-acp')).toMatchObject({
                id: 'dep.codex-acp',
                kind: 'dep',
                title: 'Codex ACP',
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
    afterEach(() => {
        loadMarketplaceIndexSourceMock.mockReset();
        decideDaemonPluginChangeMock.mockReset();
        requestDaemonPluginChangeMock.mockReset();
        requestDaemonPluginDevelopmentPreflightMock.mockReset();
        listDaemonPluginChangesMock.mockReset();
        listDaemonPluginChangesMock.mockResolvedValue({ changes: [] });
        readDaemonPluginChangeStatusMock.mockReset();
        readDaemonPluginChangeStatusMock.mockResolvedValue({ kind: 'expired' });
        ensureDaemonRunningMock.mockClear();
        promptConfirmYesNoMock.mockReset();
        runPluginAuthorToolchainMock.mockClear();
        runPluginUiArtifactBuildMock.mockClear();
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
            manifest: null,
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

        await expect(service.detect({
            requests: [{ id: 'tool.plugins' }],
        })).resolves.toMatchObject({
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
    });

    it('projects the daemon\'s outstanding decisions and rejoins one by its issued id', async () => {
        // A change an Agent prepared has no caller left holding the issued id.
        // The capability that already carries plugin truth to the app carries
        // the outstanding decisions too, and the by-id rejoin is what the app
        // re-reads before asking a user to approve anything.
        const sourceRootReview = {
            kind: 'sourceRootReviewRequired',
            pendingChangeId: 'pending-agent-1',
            review: { source: { kind: 'path', locator: '/workspace/plugins/agent-authored' } },
        } as const;
        listDaemonPluginChangesMock.mockResolvedValue({ changes: [sourceRootReview] });
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

    it('keeps a generic curated install prepare-only even if a downstream adapter reports a commit', async () => {
        const home = await createTempDir('happier-cli-capabilities-curated-install-');
        const sourceUrl = 'https://marketplace.example.test/catalog.json';
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
        envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl,
        });
        reloadConfiguration();
        loadMarketplaceIndexSourceMock.mockImplementation(async ({ source }) => createMarketplaceSnapshot({ source }));
        requestDaemonPluginChangeMock.mockResolvedValue({
            kind: 'committed',
            pluginId: SAMPLE_PLUGIN_ID,
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
            pendingSurfaces: [],
        });

        try {
            const sourceId = (await createMarketplaceSourceRegistryStore({ happyHomeDir: home }).read()).sources[0]!.id;
            const service = await createCliCapabilitiesService();
            const installResponse = await service.invoke({
                id: 'tool.plugins',
                method: 'install',
                params: {
                    sourceId,
                    pluginId: SAMPLE_PLUGIN_ID,
                    approval: 'approved-by-client',
                    version: '9.9.9',
                    integrity: 'sha512-client-supplied',
                },
            });
            expect(installResponse).toMatchObject({
                ok: false,
                error: {
                    code: 'plugin_install_human_decision_required',
                },
            });

            expect(requestDaemonPluginChangeMock).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'installNpm',
                expectedMarketplaceListing: expect.objectContaining({
                    source: { id: sourceId, kind: 'curated', sourceUrl },
                    pluginId: SAMPLE_PLUGIN_ID,
                    version: '1.0.0',
                }),
            }));
            expect(requestDaemonPluginChangeMock.mock.calls[0]?.[0]).not.toMatchObject({
                selector: '9.9.9',
                integrity: 'sha512-client-supplied',
            });
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
        }
    });

    it('returns the staged community package review for an explicit UI decision', async () => {
        const review = {
            pluginId: SAMPLE_PLUGIN_ID,
            displayName: 'Community sample',
            version: '1.0.0',
            source: {
                kind: 'npm' as const,
                locator: 'https://registry.npmjs.org/@acme/sample/-/sample-1.0.0.tgz',
                integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
            },
            executableRealms: ['daemon' as const],
            requiredHostAccess: [],
            optionalHostAccess: [],
        };
        const home = await createTempDir('happier-cli-capabilities-community-install-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        envScope.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();
        loadMarketplaceIndexSourceMock.mockImplementation(async ({ source }) => createMarketplaceSnapshot({ source }));
        requestDaemonPluginChangeMock.mockResolvedValue({
            kind: 'reviewRequired',
            pendingChangeId: 'pending-community',
            review,
        });

        try {
            const service = await createCliCapabilitiesService();
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'install',
                params: { sourceId: 'marketplace:community-npm', pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'install',
                    pluginId: SAMPLE_PLUGIN_ID,
                    change: { kind: 'reviewRequired', pendingChangeId: 'pending-community', review },
                },
            });
            expect(promptConfirmYesNoMock).not.toHaveBeenCalled();
            expect(decideDaemonPluginChangeMock).not.toHaveBeenCalled();
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
        }
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

    it('exposes private lifecycle methods through the canonical daemon change owner without restoring reload or source-url mutation', async () => {
        const home = await createTempDir('happier-cli-capabilities-plugin-lifecycle-');
        const sourceUrl = 'https://marketplace.example.test/catalog.json';
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
        envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl,
        });
        reloadConfiguration();
        const review = {
            pluginId: SAMPLE_PLUGIN_ID,
            displayName: 'Sample plugin',
            version: '1.0.0',
            source: { kind: 'npm' as const, locator: '@acme/sample@1.0.0' },
            executableRealms: ['daemon' as const],
            requiredHostAccess: [],
            optionalHostAccess: [],
        };
        loadMarketplaceIndexSourceMock.mockImplementation(async ({ source }) => createMarketplaceSnapshot({ source }));
        requestDaemonPluginChangeMock.mockImplementation(async (request: Readonly<{ kind: string; pluginId?: string }>) => (
            request.kind === 'update'
                ? { kind: 'reviewRequired', pendingChangeId: 'pending-update', review }
                : {
                    kind: 'committed',
                    pluginId: request.pluginId ?? SAMPLE_PLUGIN_ID,
                    desiredGeneration: request.kind === 'uninstall' || request.kind === 'forgetTrust'
                        ? null
                        : 'generation-1',
                    appliedGeneration: request.kind === 'uninstall' || request.kind === 'forgetTrust'
                        ? null
                        : 'generation-1',
                    pendingSurfaces: [],
                }
        ));

        try {
            const sourceId = (await createMarketplaceSourceRegistryStore({ happyHomeDir: home }).read()).sources[0]!.id;
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;
            const plugins = described.capabilities.find((capability) => capability.id === 'tool.plugins');

            expect(plugins?.methods).not.toHaveProperty('reload');
            expect(plugins?.methods).toEqual(expect.objectContaining({
                update: expect.any(Object),
                rollback: expect.any(Object),
                uninstall: expect.any(Object),
                forgetTrust: expect.any(Object),
            }));
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'reload',
                params: { pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'unsupported-method' },
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'update',
                params: {
                    pluginId: SAMPLE_PLUGIN_ID,
                    sourceId,
                    sourceUrl: 'https://untrusted.invalid/catalog.json',
                },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'update',
                    pluginId: SAMPLE_PLUGIN_ID,
                    change: {
                        kind: 'reviewRequired',
                        pendingChangeId: 'pending-update',
                        review,
                    },
                },
            });
            // The installed record — not the marketplace listing the caller named —
            // is the update authority, so nothing about the catalog travels with it.
            expect(requestDaemonPluginChangeMock).toHaveBeenNthCalledWith(1, {
                kind: 'update',
                pluginId: SAMPLE_PLUGIN_ID,
            });
            expect(JSON.stringify(requestDaemonPluginChangeMock.mock.calls[0]?.[0])).not.toContain('untrusted.invalid');

            for (const method of ['rollback', 'uninstall', 'forgetTrust'] as const) {
                await expect(service.invoke({
                    id: 'tool.plugins',
                    method,
                    params: { pluginId: SAMPLE_PLUGIN_ID },
                })).resolves.toMatchObject({
                    ok: true,
                    result: {
                        action: method,
                        pluginId: SAMPLE_PLUGIN_ID,
                        change: { kind: 'committed', pluginId: SAMPLE_PLUGIN_ID },
                    },
                });
            }
            expect(requestDaemonPluginChangeMock.mock.calls.slice(1, 4).map(([request]) => request)).toEqual([
                { kind: 'rollback', pluginId: SAMPLE_PLUGIN_ID },
                { kind: 'uninstall', pluginId: SAMPLE_PLUGIN_ID },
                { kind: 'forgetTrust', pluginId: SAMPLE_PLUGIN_ID },
            ]);

            requestDaemonPluginChangeMock.mockResolvedValueOnce({
                kind: 'unavailable',
                code: 'daemon_unavailable',
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'update',
                params: { sourceId, pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'outcomeUnknown' },
            });

            requestDaemonPluginChangeMock.mockResolvedValueOnce({
                kind: 'committed',
                pluginId: SAMPLE_PLUGIN_ID,
                desiredGeneration: 'generation-2',
                appliedGeneration: 'generation-2',
                pendingSurfaces: [],
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'update',
                params: { sourceId, pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'update',
                    pluginId: SAMPLE_PLUGIN_ID,
                    change: {
                        kind: 'committed',
                        desiredGeneration: 'generation-2',
                        appliedGeneration: 'generation-2',
                    },
                },
            });

            requestDaemonPluginChangeMock.mockResolvedValueOnce({
                kind: 'reviewRequired',
                pendingChangeId: 'pending-unexpected',
                review,
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'uninstall',
                params: { pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'reviewRequired' },
            });

            requestDaemonPluginChangeMock.mockResolvedValueOnce({
                kind: 'unavailable',
                code: 'daemon_unavailable',
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'forgetTrust',
                params: { pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'outcomeUnknown' },
            });

            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'update',
                params: { sourceId, pluginId: '   ' },
            })).resolves.toMatchObject({ ok: false, error: { code: 'plugin-not-found' } });
            // An exact catalog install still requires the source it installs from;
            // an update never did, because it does not read the catalog.
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'install',
                params: { sourceId: '   ', pluginId: SAMPLE_PLUGIN_ID },
            })).resolves.toMatchObject({ ok: false, error: { code: 'plugin_source_missing' } });

            expect(promptConfirmYesNoMock).not.toHaveBeenCalled();
            expect(decideDaemonPluginChangeMock).not.toHaveBeenCalled();
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
        }
    });

    it('routes update through the canonical installed-update owner so a pinned installation is refused with its own reason', async () => {
        const home = await createTempDir('happier-cli-capabilities-plugin-pinned-update-');
        const sourceUrl = 'https://marketplace.example.test/catalog.json';
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
        envScope.patch({
            HAPPIER_HOME_DIR: home,
            HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: sourceUrl,
        });
        reloadConfiguration();
        // A newer version is genuinely offered by the catalog: an update arm that
        // installs the catalog version would advance this pinned installation.
        loadMarketplaceIndexSourceMock.mockImplementation(async ({ source }) => {
            const snapshot = createMarketplaceSnapshot({ source });
            return {
                ...snapshot,
                entries: snapshot.entries.map((entry) => ({
                    ...entry,
                    distribution: { ...entry.distribution, version: '2.0.0' },
                })),
            };
        });

        try {
            await createPluginStateStore({ happyHomeDir: home }).write({
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {
                    [SAMPLE_PLUGIN_ID]: {
                        source: {
                            kind: 'marketplace',
                            locator: '@acme/sample@1.0.0',
                            resolvedPath: join(home, 'plugins', SAMPLE_PLUGIN_ID),
                            manifestPath: join(home, 'plugins', SAMPLE_PLUGIN_ID, '.happier-plugin', 'plugin.json'),
                            trustPolicy: 'prompt',
                            installPolicy: 'managed_install',
                        },
                        compatibility: { status: 'compatible', diagnostics: [] },
                        install: {
                            mode: 'managed_install',
                            manifestVersion: '1.0.0',
                            trust: createPluginTrustRecord({
                                pluginId: SAMPLE_PLUGIN_ID,
                                distribution: createNpmPluginDistributionIdentity({
                                    registryOrigin: 'https://registry.npmjs.org',
                                    packageName: '@acme/sample',
                                }),
                                approvedAtMs: 0,
                            }),
                            updatePolicy: 'pinned',
                        },
                        state: { enabled: true },
                    },
                },
            });

            // The daemon process is the mocked boundary; the decision it reports
            // is the real canonical installed-update owner's decision.
            requestDaemonPluginChangeMock.mockImplementation(async (request: Readonly<{ kind: string; pluginId?: string }>) => {
                if (request.kind !== 'update') {
                    return { kind: 'reviewRequired', pendingChangeId: 'pending-exact-install', review: {} };
                }
                const installed = (await createPluginRegistryStateStore({ happyHomeDir: home }).read())
                    .plugins[request.pluginId ?? ''];
                try {
                    resolveInstalledPluginUpdate(request.pluginId ?? '', installed);
                } catch (error) {
                    return error instanceof DaemonPluginChangePreparationError
                        ? { kind: 'failed', code: error.code, message: error.message }
                        : { kind: 'failed', code: 'plugin_change_preparation_failed' };
                }
                return {
                    kind: 'committed',
                    pluginId: request.pluginId,
                    desiredGeneration: 'generation-2',
                    appliedGeneration: 'generation-2',
                    pendingSurfaces: [],
                };
            });

            // Derive the expected refusal from the canonical owner itself, so this
            // test cannot pass against a fixture that is not actually pinned.
            const canonicalRefusal = await (async () => {
                const installed = (await createPluginRegistryStateStore({ happyHomeDir: home }).read())
                    .plugins[SAMPLE_PLUGIN_ID];
                try {
                    resolveInstalledPluginUpdate(SAMPLE_PLUGIN_ID, installed);
                } catch (error) {
                    if (error instanceof DaemonPluginChangePreparationError) return error;
                    throw error;
                }
                throw new Error('The pinned fixture must be refused by the canonical installed-update owner');
            })();
            expect(canonicalRefusal.code).toBe('plugin_update_pinned');

            const sourceId = (await createMarketplaceSourceRegistryStore({ happyHomeDir: home }).read()).sources[0]!.id;
            const service = await createCliCapabilitiesService();
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'update',
                params: { pluginId: SAMPLE_PLUGIN_ID, sourceId },
            })).resolves.toEqual({
                ok: false,
                error: {
                    code: canonicalRefusal.code,
                    message: canonicalRefusal.message,
                },
            });

            expect(requestDaemonPluginChangeMock).toHaveBeenCalledTimes(1);
            expect(requestDaemonPluginChangeMock).toHaveBeenCalledWith({
                kind: 'update',
                pluginId: SAMPLE_PLUGIN_ID,
            });
            expect(requestDaemonPluginChangeMock.mock.calls.map(([request]) => request.kind))
                .not.toContain('installNpm');
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
        }
    });

    it('projects only approved development sources and runs test and pack against the daemon-re-read source root', async () => {
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
            await copyNativeTypeScriptAuthorDependency(pluginRoot);
            await linkPluginAuthorDependency(
                pluginRoot,
                '@happier-dev/plugin-sdk',
                fileURLToPath(new URL('../../../../../packages/plugin-sdk', import.meta.url)),
            );
            await linkPluginAuthorDependency(
                pluginRoot,
                '@types/node',
                fileURLToPath(new URL('../../../../../node_modules/@types/node', import.meta.url)),
            );
            await bundlePluginDaemonRuntime(pluginRoot);
            await writeManagedRuntimeFixture(home);
            await createPluginStateStore({ happyHomeDir: home }).write({
                t: 'happier_plugin_state_v1',
                schemaVersion: 1,
                plugins: {
                    'acme.development-actions': {
                        source: {
                            kind: 'path',
                            locator: pluginRoot,
                            resolvedPath: pluginRoot,
                            manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                            trustPolicy: 'prompt',
                            installPolicy: 'link',
                            devWatch: true,
                        },
                        compatibility: { status: 'compatible', diagnostics: [] },
                        install: { mode: 'link', manifestVersion: '0.1.0' },
                        state: { enabled: true },
                    },
                },
            });

            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;
            expect(described.capabilities.find((capability) => capability.id === 'tool.plugins')).toMatchObject({
                methods: expect.objectContaining({
                    create: expect.any(Object),
                    test: expect.any(Object),
                    pack: expect.any(Object),
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
                            developmentSources: [{
                                pluginId: 'acme.development-actions',
                                sourceRootPath: pluginRoot,
                                watch: { state: 'configured' },
                                reload: { state: 'clear', diagnostics: [] },
                                actions: { test: true, pack: true },
                            }],
                        },
                    },
                },
            });

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

            const testResult = await service.invoke({
                id: 'tool.plugins',
                method: 'test',
                params: { pluginId: 'acme.development-actions', sourceRootPath: '/client/must-not-own-source' },
            });
            expect(
                testResult,
                testResult.ok ? undefined : testResult.error.message,
            ).toMatchObject({
                ok: true,
                result: { action: 'test', pluginId: 'acme.development-actions' },
            });
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'pack',
                params: { pluginId: 'acme.development-actions', sourceRootPath: '/client/must-not-own-source' },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'pack',
                    pluginId: 'acme.development-actions',
                    archivePath: expect.stringMatching(/\.tgz$/u),
                },
            });
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
            await expect(readFile(join(createdUiRoot, 'src', 'index.ts'), 'utf8'))
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

    it('returns the source-root review to the client instead of approving a local development source itself', async () => {
        const home = await createTempDir('happier-cli-capabilities-develop-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        envScope.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();
        const sourceRootPath = join(home, 'workspace', 'acme-plugin');
        requestDaemonPluginDevelopmentPreflightMock.mockResolvedValue({
            kind: 'sourceRootReviewRequired',
            pendingChangeId: 'pending-source-root',
            review: { source: { kind: 'path', locator: sourceRootPath } },
        });
        requestDaemonPluginChangeMock.mockResolvedValue({
            kind: 'sourceRootReviewRequired',
            pendingChangeId: 'pending-source-root',
            review: { source: { kind: 'path', locator: sourceRootPath } },
        });

        try {
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;
            expect(described.capabilities.find((capability) => capability.id === 'tool.plugins')?.methods)
                .toEqual(expect.objectContaining({ develop: expect.any(Object) }));

            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'develop',
                params: { sourceRootPath },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'develop',
                    sourceRootPath,
                    change: {
                        kind: 'sourceRootReviewRequired',
                        pendingChangeId: 'pending-source-root',
                        review: { source: { kind: 'path', locator: sourceRootPath } },
                    },
                },
            });
            // The daemon's preflight is the trust owner. An untrusted root is
            // handed back for a present-user decision before the CLI inspects,
            // installs dependencies for, or builds source bytes.
            expect(requestDaemonPluginDevelopmentPreflightMock).toHaveBeenCalledWith({
                sourceRootPath,
            });
            expect(requestDaemonPluginChangeMock).not.toHaveBeenCalled();
            expect(runPluginAuthorToolchainMock).not.toHaveBeenCalled();
            expect(runPluginUiArtifactBuildMock).not.toHaveBeenCalled();
            expect(promptConfirmYesNoMock).not.toHaveBeenCalled();
            expect(decideDaemonPluginChangeMock).not.toHaveBeenCalled();

            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'develop',
                params: {},
            })).resolves.toMatchObject({
                ok: false,
                error: { code: 'plugin_source_missing' },
            });
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
        }
    });

    it('runs a preflight-authorized remote development source through the one prepare-build-submit cycle', async () => {
        const home = await createTempDir('happier-cli-capabilities-develop-authorized-');
        const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-capabilities-develop-authorized-'));
        const pluginRoot = join(parent, 'plugin');
        const pluginId = 'acme.capabilities-develop';
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const scaffold = await scaffoldLocalPlugin({
                targetDir: pluginRoot,
                pluginId,
                displayName: 'Capabilities develop',
            });
            expect(scaffold.ok).toBe(true);
            if (!scaffold.ok) return;

            requestDaemonPluginDevelopmentPreflightMock.mockResolvedValue({ kind: 'authorized' });
            runPluginAuthorToolchainMock.mockResolvedValueOnce({
                ok: true,
                operation: 'install',
                projectRoot: pluginRoot,
            });
            runPluginUiArtifactBuildMock.mockResolvedValueOnce({
                ok: true,
                projectRoot: pluginRoot,
                built: true,
            });
            requestDaemonPluginChangeMock.mockResolvedValueOnce({
                kind: 'committed',
                pluginId,
                desiredGeneration: 'generation-1',
                appliedGeneration: 'generation-1',
                pendingSurfaces: [],
            });

            const service = await createCliCapabilitiesService();
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'develop',
                params: { sourceRootPath: pluginRoot, pluginId },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'develop',
                    sourceRootPath: pluginRoot,
                    change: { kind: 'committed', pluginId },
                },
            });

            expect(requestDaemonPluginDevelopmentPreflightMock).toHaveBeenCalledWith({
                sourceRootPath: pluginRoot,
                pluginId,
            });
            expect(runPluginAuthorToolchainMock).toHaveBeenCalledWith({
                operation: 'install',
                projectRoot: pluginRoot,
            });
            expect(runPluginUiArtifactBuildMock).toHaveBeenCalledWith({ projectRoot: pluginRoot });
            expect(requestDaemonPluginChangeMock).toHaveBeenCalledWith({
                kind: 'development',
                sourceRootPath: pluginRoot,
                pluginId,
            });
            expect(requestDaemonPluginDevelopmentPreflightMock.mock.invocationCallOrder[0]).toBeLessThan(
                runPluginAuthorToolchainMock.mock.invocationCallOrder[0]!,
            );
            expect(runPluginAuthorToolchainMock.mock.invocationCallOrder[0]).toBeLessThan(
                runPluginUiArtifactBuildMock.mock.invocationCallOrder[0]!,
            );
            expect(runPluginUiArtifactBuildMock.mock.invocationCallOrder[0]).toBeLessThan(
                requestDaemonPluginChangeMock.mock.invocationCallOrder[0]!,
            );
        } finally {
            envScope.restore();
            reloadConfiguration();
            await rm(parent, { recursive: true, force: true });
            await removeTempDir(home);
        }
    });

    it('fails closed when source trust is revoked after preflight and before final submission', async () => {
        const home = await createTempDir('happier-cli-capabilities-develop-revoked-');
        const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-capabilities-develop-revoked-'));
        const pluginRoot = join(parent, 'plugin');
        const pluginId = 'acme.capabilities-revoked';
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const scaffold = await scaffoldLocalPlugin({
                targetDir: pluginRoot,
                pluginId,
                displayName: 'Capabilities revoked',
            });
            expect(scaffold.ok).toBe(true);
            if (!scaffold.ok) return;

            requestDaemonPluginDevelopmentPreflightMock.mockResolvedValue({ kind: 'authorized' });
            runPluginAuthorToolchainMock.mockResolvedValueOnce({
                ok: true,
                operation: 'install',
                projectRoot: pluginRoot,
            });
            runPluginUiArtifactBuildMock.mockResolvedValueOnce({
                ok: true,
                projectRoot: pluginRoot,
                built: true,
            });
            requestDaemonPluginChangeMock.mockResolvedValueOnce({
                kind: 'sourceRootReviewRequired',
                pendingChangeId: 'pending-revoked-root',
                review: { source: { kind: 'path', locator: pluginRoot } },
            });

            const service = await createCliCapabilitiesService();
            await expect(service.invoke({
                id: 'tool.plugins',
                method: 'develop',
                params: { sourceRootPath: pluginRoot, pluginId },
            })).resolves.toMatchObject({
                ok: true,
                result: {
                    action: 'develop',
                    sourceRootPath: pluginRoot,
                    change: {
                        kind: 'sourceRootReviewRequired',
                        pendingChangeId: 'pending-revoked-root',
                    },
                },
            });

            expect(requestDaemonPluginDevelopmentPreflightMock).toHaveBeenCalledTimes(1);
            expect(runPluginAuthorToolchainMock).toHaveBeenCalledTimes(1);
            expect(runPluginUiArtifactBuildMock).toHaveBeenCalledTimes(1);
            expect(requestDaemonPluginChangeMock).toHaveBeenCalledWith({
                kind: 'development',
                sourceRootPath: pluginRoot,
                pluginId,
            });
            expect(promptConfirmYesNoMock).not.toHaveBeenCalled();
            expect(decideDaemonPluginChangeMock).not.toHaveBeenCalled();
        } finally {
            envScope.restore();
            reloadConfiguration();
            await rm(parent, { recursive: true, force: true });
            await removeTempDir(home);
        }
    });
});
