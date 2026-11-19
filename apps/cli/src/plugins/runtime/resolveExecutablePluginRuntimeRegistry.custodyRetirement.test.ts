import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createImmutablePluginGenerationRecordFromSource,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';

const boundaries = vi.hoisted(() => ({
    listSessionMarkers: vi.fn(),
    readStoredCredentials: vi.fn(),
    retireSessionSubagentCustodySource: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: (...args: unknown[]) => boundaries.readStoredCredentials(...args),
}));

vi.mock('@/daemon/sessionRegistry', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/sessionRegistry')>(),
    listSessionMarkers: (...args: unknown[]) => boundaries.listSessionMarkers(...args),
}));

vi.mock('@/session/transport/http/sessionSubagentCustodyHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionSubagentCustodyHttp')>(),
    retireSessionSubagentCustodySource: (...args: unknown[]) =>
        boundaries.retireSessionSubagentCustodySource(...args),
}));

import {
    createMergedContributionRegistry,
} from '../projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const temporaryDirectories: string[] = [];

async function createTrustedLocalLinkInstall(params: Readonly<{
    pluginId: string;
    sourceRootPath: string;
    manifestVersion: string;
}>) {
    const distribution = await createLocalPathPluginDistributionIdentity(params.sourceRootPath);
    return {
        mode: 'link' as const,
        manifestVersion: params.manifestVersion,
        installedPath: null,
        trust: createPluginTrustRecord({
            pluginId: params.pluginId,
            distribution,
            approvedAtMs: 1,
        }),
    };
}

async function prepareResolverWithObsoleteGeneration(): Promise<Readonly<{
    happyHomeDir: string;
    pluginId: string;
    obsoleteGenerationId: string;
}>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-retirement-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-runtime-retirement-plugin-'));
    const obsoleteSourceRoot = await mkdtemp(join(tmpdir(), 'happier-runtime-retirement-obsolete-'));
    temporaryDirectories.push(happyHomeDir, pluginRoot, obsoleteSourceRoot);

    const pluginId = 'acme.runtime.retirement';
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Runtime retirement fixture',
        engines: { happier: '^0.3.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {},
    }), 'utf8');
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
    await writeCommittedLocalPathPluginFixture({
        happyHomeDir,
        pluginId,
        sourceRootPath: pluginRoot,
        plugin: {
            source: {
                kind: 'path',
                locator: pluginRoot,
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
                resolvedPath: pluginRoot,
                manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: { status: 'unknown', diagnostics: [] },
            install: await createTrustedLocalLinkInstall({
                pluginId,
                sourceRootPath: pluginRoot,
                manifestVersion: '1.0.0',
            }),
            state: { enabled: true },
        },
    });

    const obsoleteGenerationId = 'generation-obsolete-retirement';
    await writeFile(join(obsoleteSourceRoot, 'marker'), 'obsolete', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const obsoleteRecord = await createImmutablePluginGenerationRecordFromSource({
        pluginId,
        sourceRootPath: obsoleteSourceRoot,
        manifestRelativePath: 'marker',
        distribution: { kind: 'localPath', canonicalPath: obsoleteSourceRoot },
        updatePolicy: 'allowed',
        createdAtMs: 1,
        immutableGenerationId: obsoleteGenerationId,
    });
    await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath: obsoleteSourceRoot,
        record: obsoleteRecord,
    });

    return { happyHomeDir, pluginId, obsoleteGenerationId };
}

async function resolveAndDisposeRuntime(happyHomeDir: string): Promise<void> {
    const registry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        contributes: createMergedContributionRegistry({}, {}),
        pluginIds: [],
    });
    await registry.dispose();
}

describe('resolveExecutablePluginRuntimeRegistry generation custody retirement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        boundaries.listSessionMarkers.mockResolvedValue([]);
        boundaries.readStoredCredentials.mockResolvedValue({
            token: 'fixture-token',
            encryption: null,
        });
        boundaries.retireSessionSubagentCustodySource.mockResolvedValue(undefined);
    });

    afterEach(async () => {
        await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
        }));
    });

    it('leaves retirement to the registry lifecycle owner, which retires with the stored principal', async () => {
        const { happyHomeDir, pluginId, obsoleteGenerationId } = await prepareResolverWithObsoleteGeneration();

        // A finite runner resolves without a daemon-owned generation authority.
        await resolveAndDisposeRuntime(happyHomeDir);
        expect(boundaries.retireSessionSubagentCustodySource).toHaveBeenCalledTimes(0);

        await createPluginRegistryStateStore({ happyHomeDir }).initialize();
        expect(boundaries.retireSessionSubagentCustodySource).toHaveBeenCalledTimes(1);
        expect(boundaries.retireSessionSubagentCustodySource).toHaveBeenCalledWith({
            token: 'fixture-token',
            pluginId,
            sourceCustody: expect.objectContaining({
                kind: 'managed',
                immutableGenerationId: obsoleteGenerationId,
            }),
        });
    });

    it('attempts a pending retirement once per daemon startup and retries on the next one', async () => {
        const { happyHomeDir } = await prepareResolverWithObsoleteGeneration();
        boundaries.retireSessionSubagentCustodySource.mockRejectedValueOnce(new Error('server unavailable'));

        await createPluginRegistryStateStore({ happyHomeDir }).initialize();
        await resolveAndDisposeRuntime(happyHomeDir);
        expect(boundaries.retireSessionSubagentCustodySource).toHaveBeenCalledTimes(1);

        await createPluginRegistryStateStore({ happyHomeDir }).initialize();
        expect(boundaries.retireSessionSubagentCustodySource).toHaveBeenCalledTimes(2);
    });
});
