import { existsSync, readFileSync } from 'node:fs';
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
import { readPluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { Logger, logger } from '@/ui/logger';

const boundaries = vi.hoisted(() => ({
    listSessionMarkers: vi.fn(),
    readStoredCredentials: vi.fn(),
    retireSessionSubagentCustodyGeneration: vi.fn(),
}));

const filesystemBoundary = vi.hoisted(() => ({
    installationStatePath: '',
    installationStateReads: 0,
    throwAtInstallationStateRead: null as number | null,
    failure: null as Error | null,
}));

const loggerConfiguration = vi.hoisted(() => ({
    happyHomeDir: '',
    logsDir: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        async readFile(...args: Parameters<typeof actual.readFile>) {
            const path = String(args[0]);
            if (path === filesystemBoundary.installationStatePath) {
                filesystemBoundary.installationStateReads += 1;
                if (
                    filesystemBoundary.throwAtInstallationStateRead
                    === filesystemBoundary.installationStateReads
                ) {
                    throw filesystemBoundary.failure ?? new Error('filesystem failure');
                }
            }
            return await actual.readFile(...args);
        },
    };
});

vi.mock('@/configuration', () => ({
    configuration: {
        isDaemonProcess: false,
        get happyHomeDir() {
            return loggerConfiguration.happyHomeDir;
        },
        get logsDir() {
            return loggerConfiguration.logsDir;
        },
    },
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
    retireSessionSubagentCustodyGeneration: (...args: unknown[]) =>
        boundaries.retireSessionSubagentCustodyGeneration(...args),
}));

vi.mock('../projection/registry/sources/generatedBundledPluginArtifacts', () => ({
    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS: [],
}));

vi.mock('../projection/registry/sources/generatedBundledPlugins', () => ({
    BUNDLED_FIRST_PARTY_IMPLEMENTATION_BINDINGS: [],
}));
vi.mock('../projection/registry/sources/generatedBundledPluginManifests', () => ({
    BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: [],
    BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: [],
}));

// The shared generated contribution catalog is being edited independently and
// currently has an invalid unrelated bundled Agent entry. Keep that projection
// out of this resolver fixture while retaining the real custody lifecycle and
// generic Logger file/remote egresses under test.
vi.mock('../projection/registry/createResolvedContributionRegistry', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../projection/registry/createResolvedContributionRegistry')
    >();
    return {
        ...actual,
        resolveMergedContributionRegistry: async () => actual.createMergedContributionRegistry({}, {}),
    };
});

// This unrelated session-runtime leaf is concurrently incomplete. It is never
// invoked by the empty activation scope used by this custody logging test.
vi.mock('@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority', () => ({
    resolveAgentSessionRealtimeVoiceAuthority: () => null,
}));

import {
    createMergedContributionRegistry,
} from '../projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const temporaryDirectories: string[] = [];

function createSecretFailure(): Error {
    const error = new Error('client_secret=leak');
    error.stack = 'BEGIN_STACK client_secret=stack-leak END_STACK';
    return error;
}

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
    obsoleteGenerationId: string;
}>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-redaction-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-runtime-redaction-plugin-'));
    const obsoleteSourceRoot = await mkdtemp(join(tmpdir(), 'happier-runtime-redaction-obsolete-'));
    temporaryDirectories.push(happyHomeDir, pluginRoot, obsoleteSourceRoot);

    const pluginId = 'acme.runtime.redaction';
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
        schemaVersion: 2,
        id: pluginId,
        version: '1.0.0',
        displayName: 'Runtime redaction fixture',
        engines: { happier: '^0.2.0' },
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

    const obsoleteGenerationId = 'generation-obsolete-redaction';
    await writeFile(join(obsoleteSourceRoot, 'marker'), 'obsolete', 'utf8');
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const obsoleteRecord = await createImmutablePluginGenerationRecordFromSource({
        pluginId,
        sourceRootPath: obsoleteSourceRoot,
        manifestRelativePath: 'marker',
        distribution: { kind: 'localPath', canonicalPath: obsoleteSourceRoot },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: obsoleteGenerationId,
    });
    await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath: obsoleteSourceRoot,
        record: obsoleteRecord,
    });

    return { happyHomeDir, obsoleteGenerationId };
}

function readPayload(message: string, marker: string): unknown {
    const markerIndex = message.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    return JSON.parse(message.slice(markerIndex + marker.length).trim());
}

function readRemoteLogMessage(body: unknown): string {
    if (typeof body !== 'string') throw new Error('Expected remote logger request body to be a string');
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Expected remote logger payload object');
    }
    if (!('message' in payload) || typeof payload.message !== 'string') {
        throw new Error('Expected remote logger payload message');
    }
    return payload.message;
}

describe('resolveExecutablePluginRuntimeRegistry custody logging', () => {
    const envKeys = [
        'DEBUG',
        'HAPPIER_HOME_DIR',
        'HAPPIER_LOG_LEVEL',
        'DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING',
        'HAPPIER_SERVER_URL',
    ] as const;
    let previousEnvironment: Record<string, string | undefined>;

    beforeEach(() => {
        vi.clearAllMocks();
        filesystemBoundary.installationStatePath = '';
        filesystemBoundary.installationStateReads = 0;
        filesystemBoundary.throwAtInstallationStateRead = null;
        filesystemBoundary.failure = null;
        boundaries.listSessionMarkers.mockResolvedValue([]);
        boundaries.readStoredCredentials.mockResolvedValue({
            token: 'fixture-token',
            encryption: null,
        });
        boundaries.retireSessionSubagentCustodyGeneration.mockRejectedValue(createSecretFailure());
        previousEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        delete process.env.DEBUG;
        process.env.HAPPIER_LOG_LEVEL = 'debug';
        process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
        process.env.HAPPIER_SERVER_URL = 'https://logs.example.test';
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
        }));
        loggerConfiguration.happyHomeDir = '';
        loggerConfiguration.logsDir = '';
        for (const key of envKeys) {
            const previous = previousEnvironment[key];
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        }
    });

    it('projects pending custody failures before generic Logger file and remote egress', async () => {
        const { happyHomeDir, obsoleteGenerationId } = await prepareResolverWithObsoleteGeneration();
        const logDirectory = await mkdtemp(join(tmpdir(), 'happier-runtime-redaction-logs-'));
        temporaryDirectories.push(logDirectory);
        process.env.HAPPIER_HOME_DIR = logDirectory;
        loggerConfiguration.happyHomeDir = logDirectory;
        loggerConfiguration.logsDir = join(logDirectory, 'logs');
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const isolatedLogger = new Logger(join(logDirectory, 'custody.log'));
        vi.spyOn(isolatedLogger, 'localTimezoneTimestamp').mockReturnValue('00:00:00.000');
        vi.spyOn(logger, 'warn').mockImplementation((message, ...args) => {
            isolatedLogger.warn(message, ...args);
        });

        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createMergedContributionRegistry({}, {}),
            pluginIds: [],
        });
        await registry.dispose();
        isolatedLogger.flushSync();

        const marker = '[PLUGIN RUNTIME] Obsolete generation custody retirement remains pending';
        expect(existsSync(isolatedLogger.getLogPath())).toBe(true);
        const fileLines = readFileSync(isolatedLogger.getLogPath(), 'utf8')
            .split('\n')
            .filter((line) => line.includes(marker));
        expect(fileLines).toHaveLength(1);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        const remoteMessages = fetchMock.mock.calls.map(([, init]) => readRemoteLogMessage(init?.body));
        const payloads = [
            ...fileLines.map((line) => readPayload(line, marker)),
            ...remoteMessages.map((message) => readPayload(message, marker)),
        ];
        expect(payloads).toEqual([
            {
                failures: [{
                    generationId: obsoleteGenerationId,
                    message: 'client_secret: [REDACTED]',
                }],
            },
            {
                failures: [{
                    generationId: obsoleteGenerationId,
                    message: 'client_secret: [REDACTED]',
                }],
            },
        ]);
        for (const payload of payloads) {
            const rendered = JSON.stringify(payload);
            expect(rendered).not.toContain('client_secret=leak');
            expect(rendered).not.toContain('stack-leak');
            expect(rendered).not.toContain('BEGIN_STACK');
            expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(2_048 + 256);
        }
    });

    it('projects reconciliation exceptions before generic Logger file and remote egress', async () => {
        const { happyHomeDir } = await prepareResolverWithObsoleteGeneration();
        const logDirectory = await mkdtemp(join(tmpdir(), 'happier-runtime-redaction-logs-'));
        temporaryDirectories.push(logDirectory);
        process.env.HAPPIER_HOME_DIR = logDirectory;
        loggerConfiguration.happyHomeDir = logDirectory;
        loggerConfiguration.logsDir = join(logDirectory, 'logs');
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const isolatedLogger = new Logger(join(logDirectory, 'custody.log'));
        vi.spyOn(isolatedLogger, 'localTimezoneTimestamp').mockReturnValue('00:00:00.000');
        vi.spyOn(logger, 'warn').mockImplementation((message, ...args) => {
            isolatedLogger.warn(message, ...args);
        });

        const paths = resolvePluginStorePaths({ happyHomeDir });
        const commit = await readPluginRegistryCommitRecord(paths);
        if (!commit) throw new Error('Expected fixture commit');
        filesystemBoundary.installationStatePath = join(
            paths.stateRevisionsDir,
            commit.installationState.revisionId,
            'plugin-installations.v1.json',
        );
        // The resolver first reads this state to establish its current
        // generation authority. The second read belongs to custody
        // reconciliation, which is the egress caught below.
        filesystemBoundary.throwAtInstallationStateRead = 2;
        filesystemBoundary.failure = createSecretFailure();

        const registry = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createMergedContributionRegistry({}, {}),
            pluginIds: [],
        });
        await registry.dispose();
        isolatedLogger.flushSync();

        const marker = '[PLUGIN RUNTIME] Obsolete generation custody reconciliation failed';
        expect(filesystemBoundary.installationStateReads).toBe(2);
        expect(existsSync(isolatedLogger.getLogPath())).toBe(true);
        const fileLines = readFileSync(isolatedLogger.getLogPath(), 'utf8')
            .split('\n')
            .filter((line) => line.includes(marker));
        expect(fileLines).toHaveLength(1);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        const remoteMessages = fetchMock.mock.calls.map(([, init]) => readRemoteLogMessage(init?.body));
        const payloads = [
            ...fileLines.map((line) => readPayload(line, marker)),
            ...remoteMessages.map((message) => readPayload(message, marker)),
        ];
        expect(payloads).toEqual([
            { error: 'client_secret: [REDACTED]' },
            { error: 'client_secret: [REDACTED]' },
        ]);
        for (const payload of payloads) {
            const rendered = JSON.stringify(payload);
            expect(rendered).not.toContain('client_secret=leak');
            expect(rendered).not.toContain('stack-leak');
            expect(rendered).not.toContain('BEGIN_STACK');
            expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(2_048 + 256);
        }
    });
});
