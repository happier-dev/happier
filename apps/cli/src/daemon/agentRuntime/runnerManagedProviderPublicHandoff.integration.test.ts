import { PassThrough } from 'node:stream';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import type {
    AgentRuntime,
    AgentSessionOpenRequest,
    AgentSessionRuntime,
    AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    PluginProcessHandle,
    PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type {
    PluginServices,
} from '@happier-dev/plugin-sdk';
import {
    accountSettingsParse,
    applySessionProviderBindingMetadataV1,
    buildBackendTargetKeyV2,
    DEFAULT_PROVIDER_SETTINGS_V1,
    ProviderConnectionIdSchema,
    ProviderSettingsV1Schema,
    setProviderExperimentalConfirmationV1,
    type ProviderModelDescriptorV1,
} from '@happier-dev/protocol';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
    createNativeAgentRuntimeSessionPlan,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import {
    projectEngineRuntimeContributionFromAgent,
} from '@/agent/runtime/registry/engineRegistry/contributions';
import type {
    NativeAgentSessionHostServiceOwners,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import {
    createRunnerAgentSessionRuntimeSource,
} from '@/agent/runtime/session/process/runnerAgentSessionRuntimeSource';
import {
    RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
    RunnerManagedServicesCustodyRequestV1Schema,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import {
    AGENT_RUNTIME_DAEMON_SERVICES_PATH,
    AgentRuntimeDaemonServiceRequestV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
    createAgentRuntimeDaemonServiceAuthorityPath,
} from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import {
    refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority,
} from '@/daemon/agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import { startDaemonControlServer } from '@/daemon/controlServer';
import {
    startDaemonSessionControlRuntime,
} from '@/daemon/startup/startDaemonSessionControlRuntime';
import {
    hashProcessCommand,
    listSessionMarkers,
    updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath,
    writeSessionMarker,
} from '@/daemon/sessionRegistry';
import type { TrackedSession } from '@/daemon/types';
import {
    createDaemonPluginRegistryRuntimeLifecycle,
} from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import {
    readLeasedAgentProviderBindingAdapter,
} from '@/plugins/runtime/providerBindings/adapter';
import {
    buildPluginSessionBindingInput,
} from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import {
    readCurrentCommittedPluginGenerations,
    readPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    resolveProviderConnectionForMachine,
} from '@/providers/registry';
import {
    createPublicManagedProviderRuntimeStartOperation,
} from '@/providers/connections/publicManagedRuntimeStart';
import {
    resolveProviderModelCompatibility,
} from '@/providers/catalog/compatibility';
import {
    createRuntimeProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    createMutableApiSessionClientFixture,
} from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
    spawnSupervisedPluginProcess,
} from '@/plugins/runtime/exec/processSupervisor';
import {
    commitPackedPublicHandoffFixture,
    createPublicHandoffArchiveChangeService,
    packPublicHandoffFixture,
    writePublicHandoffAgentPluginFixture as writeExternalPublicHandoffAgentPluginFixture,
    writePublicHandoffProviderPluginFixture as writeExternalPublicHandoffProviderPluginFixture,
} from './runnerManagedProviderPublicHandoff.fixture';

const FIXTURE_AGENT_PLUGIN_ID = 'acme.public-handoff-agent';
const FIXTURE_PROVIDER_PLUGIN_ID = 'acme.public-provider-handoff';
const FIXTURE_AGENT_ID = 'public-handoff-agent';
const FIXTURE_AGENT_ROUTING_ID =
    `${FIXTURE_AGENT_PLUGIN_ID}/${FIXTURE_AGENT_ID}`;
const FIXTURE_PROVIDER_ID = 'gateway';
const FIXTURE_PROVIDER_CONTRIBUTION_KEY =
    `${FIXTURE_PROVIDER_PLUGIN_ID}/${FIXTURE_PROVIDER_ID}`;
const FIXTURE_AGENT_SYSTEM_TOOL_ID = 'public-handoff-agent-cli';
const FIXTURE_AGENT_PROVIDER_ENV_KEY = 'PUBLIC_PROVIDER_TOKEN';
const FIXTURE_PROVIDER_BEARER_ENV_KEY =
    'PUBLIC_PROVIDER_DOWNSTREAM_BEARER';
const FIXTURE_PROVIDER_SERVICE_ID = 'public-provider-managed';
const FIXTURE_PROVIDER_BINARY_NAME = 'happier-public-provider-fixture';
const FIXTURE_PROVIDER_ENDPOINT_ID = 'responses';

const testState = vi.hoisted(() => ({
    happyHomeDir: '/tmp/happier-public-p-composed-unconfigured',
    packagedRuntimeRoot: '/tmp/happier-public-p-composed-unconfigured',
    controlInputs: new Map<
        number,
        Parameters<typeof startDaemonControlServer>[0]
    >(),
    nextControlPort: 43_219,
    startDaemonControlServer: vi.fn(async (
        input: Parameters<typeof startDaemonControlServer>[0],
    ) => {
        const port = testState.nextControlPort;
        testState.nextControlPort += 1;
        testState.controlInputs.set(port, input);
        return {
            port,
            stop: vi.fn(async () => {
                testState.controlInputs.delete(port);
            }),
        };
    }),
    callSessionRpc: vi.fn(),
    fetchAccountEncryptionCurrentness: vi.fn(async () => ({
        mode: 'plain' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
    })),
    readProcessIdentityByPid: vi.fn(),
    acquireRuntimeLease: vi.fn(),
    hostProcessIds: new WeakMap<object, number | null>(),
    spawnSupervisedPluginProcess: vi.fn(),
    resolveFirstPartyVersionInstallPath: vi.fn(() =>
        testState.packagedRuntimeRoot
    ),
    resolveCliRuntimeAssetPath: vi.fn((...segments: string[]) =>
        segments[0] === 'tools'
            ? join(testState.packagedRuntimeRoot, ...segments)
            : join(testState.happyHomeDir, 'runtime-assets', ...segments)
    ),
}));

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return testState.happyHomeDir;
        },
        get activeServerDir() {
            return join(testState.happyHomeDir, 'servers', 'default');
        },
        get daemonStateFile() {
            return join(testState.happyHomeDir, 'servers', 'default', 'daemon.state.json');
        },
        daemonSpawnExistingSessionWaitForExitMs: 0,
        daemonSpawnExistingSessionWaitForExitPollIntervalMs: 5,
        daemonStopSessionWaitForExitMs: 0,
        daemonStopSessionWaitForExitPollIntervalMs: 5,
        apiServerUrl: 'http://127.0.0.1:41001',
        currentCliVersion: '0.2.0',
    },
}));

vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: testState.startDaemonControlServer,
}));

vi.mock('@/daemon/processIdentity', () => ({
    readProcessIdentityByPid: testState.readProcessIdentityByPid,
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
    callSessionRpc: testState.callSessionRpc,
}));

vi.mock(
    '@/api/client/connectedServiceCredentialApi',
    async (importOriginal) => ({
        ...await importOriginal<
            typeof import('@/api/client/connectedServiceCredentialApi')
        >(),
        fetchAccountEncryptionCurrentness:
            testState.fetchAccountEncryptionCurrentness,
    }),
);

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/session/transport/http/sessionsHttp')
    >();
    return {
        ...actual,
        fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
            id: sessionId,
            encryptionMode: 'plain',
        })),
        fetchSessionByIdCompat: vi.fn(async () => null),
        fetchSessionsPage: vi.fn(async () => ({
            sessions: [],
            nextCursor: null,
            hasNext: false,
        })),
    };
});

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease:
        testState.acquireRuntimeLease,
}));

vi.mock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
    resolveCliRuntimeAssetPath: testState.resolveCliRuntimeAssetPath,
}));

vi.mock(
    '@happier-dev/cli-common/firstPartyRuntime',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@happier-dev/cli-common/firstPartyRuntime')
        >();
        return {
            ...actual,
            resolveManagedCliReleaseChannel: vi.fn(async () => ({
                ringId: 'stable' as const,
            })),
            resolveFirstPartyVersionInstallPath:
                testState.resolveFirstPartyVersionInstallPath,
        };
    },
);

vi.mock('@/plugins/runtime/exec/processSupervisor', () => ({
    associateSupervisedPluginProcessHandleForHost: (
        handle: object,
        child: Readonly<{ pid?: number }>,
    ) => testState.hostProcessIds.set(handle, child.pid ?? null),
    readSupervisedPluginProcessIdForHost: (handle: object) =>
        testState.hostProcessIds.get(handle) ?? null,
    spawnSupervisedPluginProcess:
        testState.spawnSupervisedPluginProcess,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

function createSessionHostServiceOwners(): NativeAgentSessionHostServiceOwners {
    const toolExecution: NativeAgentSessionHostServiceOwners['toolExecution'] =
        Object.freeze({
            before: async (request) => ({
                status: 'continue' as const,
                input: request.input,
            }),
            observeAfter: async () => undefined,
        });
    return Object.freeze({
        features: Object.freeze({ isEnabled: () => false }),
        sessionHooks: Object.freeze({
            startServer: async () => Object.freeze({
                port: 4312,
                stop: () => undefined,
                dispose: async () => undefined,
            }),
            resolveForwarderAssets: async () => Object.freeze({
                nodeExecutable: '/runtime/node',
                sessionForwarderScript: '/runtime/session-forwarder.cjs',
                permissionForwarderScript: '/runtime/permission-forwarder.cjs',
            }),
            createPluginDir: async () => '/tmp/plugin-dir',
            disposePluginDir: async () => undefined,
            publishProviderTranscript: async () => undefined,
        }),
        transcripts: Object.freeze({
            fileFollow: Object.freeze({
                follow: async () => Object.freeze({
                    id: 'follow-1',
                    drainNow: async () => undefined,
                    close: async () => undefined,
                }),
            }),
        }),
        accountUsage: Object.freeze({
            resolveSourceContext: async () => null,
            recordSnapshot: async () => ({
                status: 'unavailable' as const,
                reason: 'daemon_unavailable' as const,
            }),
            adoptProvisionalRecord: async () => ({
                status: 'unavailable' as const,
                reason: 'daemon_unavailable' as const,
            }),
        }),
        auth: Object.freeze({
            services: Object.freeze({
                refreshRuntimeAuth: async () => ({
                    status: 'unavailable' as const,
                    reason: 'test',
                }),
            }),
        }),
        mcp: Object.freeze({
            resolveForSession: async () => Object.freeze([]),
        }),
        toolExecution,
        dispose: async () => undefined,
    });
}

function createPendingProcess(
    onDispose: () => void,
): ReturnType<typeof spawnSupervisedPluginProcess> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveWait!: (result: PluginProcessResult) => void;
    const wait = new Promise<PluginProcessResult>((resolve) => {
        resolveWait = resolve;
    });
    let disposed = false;
    const dispose = vi.fn(async () => {
        if (disposed) return;
        disposed = true;
        onDispose();
        resolveWait(Object.freeze({
            termination: Object.freeze({
                observed: Object.freeze({ kind: 'exit' as const, exitCode: 0 }),
                requestedBy: Object.freeze({ kind: 'dispose' as const, reason: 'caller' as const }),
            }),
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            stdoutTruncated: false,
            stderrTruncated: false,
        }));
    });
    const handle = Object.freeze({
        write: vi.fn(async () => undefined),
        closeStdin: vi.fn(async () => undefined),
        wait: () => wait,
        onOutput: vi.fn(() => Object.freeze({ dispose() {} })),
        dispose,
    }) satisfies PluginProcessHandle;
    testState.hostProcessIds.set(handle, process.pid);
    return Object.freeze({
        child: {
            pid: process.pid,
            stdout,
            stderr,
            stdin: new PassThrough(),
        } as never,
        handle,
        readBufferedStderr: () => new Uint8Array(),
        requestTermination: async () => await dispose(),
        dispose,
    });
}

function expectDesiredCurrentProviderRuntimeResolutionCount(
    expected: number,
): void {
    expect(testState.resolveCliRuntimeAssetPath.mock.calls.filter(
        (segments) => segments.some((segment) =>
            segment.includes(FIXTURE_PROVIDER_BINARY_NAME)
        ),
    )).toHaveLength(expected);
}

describe('representative public Provider-to-SVC09 handoff', () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    let composedPhase = 'not started';
    let composedStartedAt = 0;

    afterEach(async () => {
        if (composedPhase !== 'complete') {
            console.info(
                `[public-handoff] incomplete phase=${composedPhase} elapsedMs=${Date.now() - composedStartedAt}`,
            );
        }
        while (cleanups.length > 0) {
            await cleanups.pop()?.();
        }
        resetActiveAccountSettingsSnapshotForTests();
        testState.controlInputs.clear();
        testState.nextControlPort = 43_219;
        testState.startDaemonControlServer.mockClear();
        testState.callSessionRpc.mockReset();
        testState.fetchAccountEncryptionCurrentness.mockReset();
        testState.readProcessIdentityByPid.mockReset();
        testState.acquireRuntimeLease.mockReset();
        testState.spawnSupervisedPluginProcess.mockReset();
        testState.resolveFirstPartyVersionInstallPath.mockClear();
        testState.resolveCliRuntimeAssetPath.mockClear();
        vi.restoreAllMocks();
        composedPhase = 'not started';
        composedStartedAt = 0;
    });

    it('keeps one direct-retained G/P across H/Q adoption and A/B/C authority rotation, then fences exact P on live-policy or hard revocation', async () => {
        composedStartedAt = Date.now();
        composedPhase = 'P/G fixture package and generation admission';
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-public-p-composed-'),
        );
        const packagedRuntimeRoot = await mkdtemp(
            join(tmpdir(), 'happier-public-p-runtime-'),
        );
        const agentPluginRoot = await mkdtemp(
            join(tmpdir(), 'happier-public-p-agent-plugin-'),
        );
        const providerPluginRoot = await mkdtemp(
            join(tmpdir(), 'happier-public-p-provider-plugin-'),
        );
        const agentHPluginRoot = await mkdtemp(
            join(tmpdir(), 'happier-public-h-agent-plugin-'),
        );
        const providerQPluginRoot = await mkdtemp(
            join(tmpdir(), 'happier-public-q-provider-plugin-'),
        );
        cleanups.push(async () => {
            const options = {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 25,
            } as const;
            await rm(happyHomeDir, options);
            await rm(packagedRuntimeRoot, options);
            await rm(agentPluginRoot, options);
            await rm(providerPluginRoot, options);
            await rm(agentHPluginRoot, options);
            await rm(providerQPluginRoot, options);
        });
        testState.happyHomeDir = happyHomeDir;
        testState.packagedRuntimeRoot = packagedRuntimeRoot;
        testState.fetchAccountEncryptionCurrentness.mockResolvedValue({
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        });

        const packagedBinary = join(
            packagedRuntimeRoot,
            'tools',
            'unpacked',
            process.platform === 'win32'
                ? `${FIXTURE_PROVIDER_BINARY_NAME}.exe`
                : FIXTURE_PROVIDER_BINARY_NAME,
        );
        const packagedEntrypoint = join(
            packagedRuntimeRoot,
            'package-dist',
            'index.mjs',
        );
        await mkdir(join(packagedRuntimeRoot, 'tools', 'unpacked'), {
            recursive: true,
        });
        await mkdir(dirname(packagedEntrypoint), { recursive: true });
        await writeFile(packagedEntrypoint, 'export default true;\n', 'utf8');
        await writeFile(packagedBinary, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(packagedBinary, 0o755);
        cliDistBuildManifest.writeCliDistBuildManifest(packagedEntrypoint);
        cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
            runtimeRoot: packagedRuntimeRoot,
            entrypoint: packagedEntrypoint,
            relativePath: [
                'tools',
                'unpacked',
                basename(packagedBinary),
            ].join('/'),
        });
        const canonicalCliPackagedBinary = await realpath(packagedBinary);
        const isFixtureProviderChild = (entry: Readonly<{ command: string }>) =>
            basename(entry.command) === basename(canonicalCliPackagedBinary);

        const previousPath = process.env.PATH;
        process.env.PATH = [
            dirname(process.execPath),
            previousPath,
        ].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
        cleanups.push(() => {
            if (previousPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = previousPath;
            }
        });

        const fixtureChangeService =
            createPublicHandoffArchiveChangeService(
                happyHomeDir,
                createDaemonPluginRegistryRuntimeLifecycle({
                    happyHomeDir,
                    reloadController: pluginReloadController,
                }),
            );
        cleanups.push(async () => {
            await pluginReloadController.shutdown({ timeoutMs: 5_000 });
        });
        composedPhase = 'P/G author fixture creation';
        await writeExternalPublicHandoffAgentPluginFixture({
            pluginRoot: agentPluginRoot,
            version: '1.0.0',
            generation: 'G',
        });
        await writeExternalPublicHandoffProviderPluginFixture({
            pluginRoot: providerPluginRoot,
            version: '1.0.0',
            generation: 'P',
        });
        composedPhase = 'P/G parallel archive pack';
        const [agentGPacked, providerPPacked] = await Promise.all([
            packPublicHandoffFixture({
                archivePath: join(happyHomeDir, 'agent-g.tgz'),
                pluginId: FIXTURE_AGENT_PLUGIN_ID,
                pluginRoot: agentPluginRoot,
            }),
            packPublicHandoffFixture({
                archivePath: join(happyHomeDir, 'provider-p.tgz'),
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                pluginRoot: providerPluginRoot,
            }),
        ]);
        composedPhase = 'P/G Agent archive admission';
        await commitPackedPublicHandoffFixture({
            changeService: fixtureChangeService,
            packed: agentGPacked,
        });
        composedPhase = 'P/G Provider archive admission';
        await commitPackedPublicHandoffFixture({
            changeService: fixtureChangeService,
            packed: providerPPacked,
        });
        composedPhase = 'P/G generation admission and initial registry';
        const generationAuthority = await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({ happyHomeDir }),
            { bundledArtifacts: [] },
        );
        if (!generationAuthority) {
            throw new Error(
                'Expected the committed external fixture generation',
            );
        }
        const agentGeneration = generationAuthority.generations.get(
            FIXTURE_AGENT_PLUGIN_ID,
        );
        const providerGeneration = generationAuthority.generations.get(
            FIXTURE_PROVIDER_PLUGIN_ID,
        );
        if (!agentGeneration || !providerGeneration) {
            throw new Error(
                'Expected separate committed Agent and Provider generations',
            );
        }
        if (!agentGeneration.installation || !providerGeneration.installation) {
            throw new Error(
                'Expected archive installation records for Agent and Provider',
            );
        }
        expect(agentGeneration.installation.source.distribution)
            .toMatchObject({ kind: 'archive' });
        expect(providerGeneration.installation.source.distribution)
            .toMatchObject({ kind: 'archive' });
        expect(agentGeneration.record).toMatchObject({
            t: 'happier_plugin_generation_v1',
            schemaVersion: 1,
            pluginId: FIXTURE_AGENT_PLUGIN_ID,
            immutableGenerationId:
                agentGeneration.immutableGenerationId,
            manifestRelativePath: '.happier-plugin/plugin.json',
        });
        expect(providerGeneration.record).toMatchObject({
            t: 'happier_plugin_generation_v1',
            schemaVersion: 1,
            pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
            immutableGenerationId:
                providerGeneration.immutableGenerationId,
            manifestRelativePath: '.happier-plugin/plugin.json',
        });
        expect(providerGeneration.immutableGenerationId).not.toBe(
            agentGeneration.immutableGenerationId,
        );
        expect(providerGeneration.rootPath).not.toBe(
            agentGeneration.rootPath,
        );
        const fixtureProviderRuntimeBinaryName = process.platform === 'win32'
            ? `${FIXTURE_PROVIDER_BINARY_NAME}.exe`
            : FIXTURE_PROVIDER_BINARY_NAME;
        const fixtureProviderRuntimeRelativePath = [
            'tools',
            'unpacked',
            fixtureProviderRuntimeBinaryName,
        ].join('/');
        expect(providerGeneration.record.files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                relativePath: fixtureProviderRuntimeRelativePath,
            }),
        ]));
        const canonicalProviderPBinary = await realpath(join(
            providerGeneration.rootPath,
            ...fixtureProviderRuntimeRelativePath.split('/'),
        ));
        expect(canonicalProviderPBinary).not.toBe(canonicalCliPackagedBinary);
        const agentManifest = JSON.parse(await readFile(join(
            agentGeneration.rootPath,
            '.happier-plugin',
            'plugin.json',
        ), 'utf8')) as Readonly<{
            contributes?: Readonly<Record<string, unknown>>;
        }>;
        const providerManifest = JSON.parse(await readFile(join(
            providerGeneration.rootPath,
            '.happier-plugin',
            'plugin.json',
        ), 'utf8')) as Readonly<{
            contributes?: Readonly<Record<string, unknown>>;
        }>;
        expect(agentManifest.contributes).toHaveProperty('agents');
        expect(agentManifest.contributes).toHaveProperty('providers', []);
        expect(providerManifest.contributes).toHaveProperty('providers');
        expect(providerManifest.contributes).toHaveProperty('agents', []);

        const initialRegistryLease =
            await pluginReloadController.acquireRuntimeRegistry();
        let initialRegistryLeaseReleased = false;
        cleanups.push(async () => {
            if (initialRegistryLeaseReleased) return;
            initialRegistryLeaseReleased = true;
            await initialRegistryLease.release();
        });
        const registry = initialRegistryLease.registry;
        if (!registry.agentRuntimesByAgentId.has(FIXTURE_AGENT_ROUTING_ID)) {
            throw new Error(
                `External Agent fixture did not publish its runtime: ${JSON.stringify({ facts: registry.targetActivationFacts })}`,
            );
        }
        const retainedAgent = registry.agentRuntimesByAgentId.get(
            FIXTURE_AGENT_ROUTING_ID,
        )?.sessionRunnerFactoryBinding;
        if (!retainedAgent) {
            throw new Error(
                'Expected the external fixture Agent direct runner binding',
            );
        }
        expect(registry.agentRuntimesByAgentId.get(FIXTURE_AGENT_ROUTING_ID)).toMatchObject({
            pluginId: FIXTURE_AGENT_PLUGIN_ID,
            sessionRunnerFactoryBinding: expect.any(Object),
        });
        expect(registry.agentRuntimesByAgentId.get(FIXTURE_AGENT_ROUTING_ID))
            .not.toHaveProperty('issueRunnerExecutionGrant');
        expect(retainedAgent).toMatchObject({
            v: 1,
            pluginId: FIXTURE_AGENT_PLUGIN_ID,
            agentId: FIXTURE_AGENT_ROUTING_ID,
            localAgentId: FIXTURE_AGENT_ID,
            immutableGenerationId: agentGeneration.immutableGenerationId,
            locator: {
                module: './agentRuntime.js',
                export: 'publicHandoffAgentRuntimeFactory',
                runtimeApiVersion: 1,
            },
        });
        expect(registry.targetActivationFacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                pluginId: FIXTURE_AGENT_PLUGIN_ID,
                status: 'active',
                required: [{
                    family: 'agents',
                    localId: FIXTURE_AGENT_ID,
                }],
                bound: [{
                    family: 'agents',
                    localId: FIXTURE_AGENT_ID,
                }],
            }),
            expect.objectContaining({
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                status: 'active',
                required: [{
                    family: 'providers',
                    localId: FIXTURE_PROVIDER_ID,
                }],
                bound: [{
                    family: 'providers',
                    localId: FIXTURE_PROVIDER_ID,
                }],
            }),
        ]));
        expect([...registry.agentRuntimesByAgentId.values()].some(
            (runtime) => runtime.pluginId === FIXTURE_PROVIDER_PLUGIN_ID,
        )).toBe(false);

        const leaseReleases: ReturnType<typeof vi.fn>[] = [];
        testState.acquireRuntimeLease.mockImplementation(async () => {
            const acquired =
                await pluginReloadController.acquireRuntimeRegistry();
            const release = vi.fn(async () => undefined);
            leaseReleases.push(release);
            return {
                registry: acquired.registry,
                source: 'active' as const,
                release: vi.fn(async () => {
                    release();
                    await acquired.release();
                }),
            };
        });
        const lease = initialRegistryLease;

        const sessionId = 'session-public-p-composed';
        const machineId = 'machine-public-p-composed';
        const connectionId = ProviderConnectionIdSchema.parse(
            'pc_public_handoff_gateway',
        );
        const contributionKey = FIXTURE_PROVIDER_CONTRIBUTION_KEY;
        const agentTargetKey = buildBackendTargetKeyV2({
            kind: 'backend',
            backendId: FIXTURE_AGENT_ROUTING_ID,
        });
        const model: ProviderModelDescriptorV1 = Object.freeze({
            id: 'gpt-public-p-composed',
            name: 'GPT public P composed',
            capabilities: Object.freeze({
                toolRoundTrips: 'supported',
                reasoningControls: 'supported',
            }),
        });
        const providerRegistry = {
            providersByContributionKey:
                registry.contributes.providersByContributionKey ?? new Map(),
        };
        const initialSettings = ProviderSettingsV1Schema.parse({
            ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{
                v: 1,
                id: connectionId,
                source: { kind: 'contribution', contributionKey },
                deployment: { kind: 'managedLocal' },
                role: 'default',
                displayName: 'Public handoff gateway',
                displayNameMode: 'custom',
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
            }],
        });
        const resolution = resolveProviderConnectionForMachine({
            connectionId,
            machineId,
            accountSettings: { providerSettingsV1: initialSettings },
            registry: providerRegistry,
            dnsEvidenceByEndpointUrl: new Map(),
        });
        if (resolution.status !== 'resolved') {
            throw new Error(
                `Expected managed external Provider connection, received ${resolution.status}`,
            );
        }
        let providerSettings = ProviderSettingsV1Schema.parse({
            ...initialSettings,
            machineGrants: [{
                v: 1,
                machineId,
                connectionId,
                endpointSetFingerprint:
                    resolution.record.endpointSetFingerprint,
                connectionSecurityFingerprint:
                    resolution.record.connectionSecurityFingerprint,
                confirmedAt: 2,
            }],
        });
        const providerAdapter = readLeasedAgentProviderBindingAdapter({
            lease,
            agentId: FIXTURE_AGENT_ROUTING_ID,
        });
        if (!providerAdapter) {
            throw new Error(
                'Expected the external fixture Provider adapter',
            );
        }
        const compatibility = resolveProviderModelCompatibility({
            record: resolution.record,
            providerSettings,
            agentTargetKey,
            support: providerAdapter.support,
            adapterVersion: providerAdapter.adapter.adapterVersion,
            model,
        });
        if (compatibility.result.status === 'experimental') {
            providerSettings = setProviderExperimentalConfirmationV1(
                providerSettings,
                {
                    connectionId,
                    agentTargetKey,
                    modelId:
                        compatibility.result.confirmationScope.kind === 'model'
                            ? model.id
                            : null,
                    compatibilityFingerprint:
                        compatibility.compatibilityFingerprint,
                    confirmedAt: 3,
                },
            );
        }
        const accountSettings = accountSettingsParse({ providerSettingsV1: providerSettings });
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettings,
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-public-p-composed',
        });

        const selection = Object.freeze({
            agentTargetKey,
            providerConnectionId: connectionId,
            modelId: model.id,
        });
        const initialAuthorization =
            await createRuntimeProviderSpawnAuthorizationAttempt({
                selection: { v: 1, updatedAt: 2, ref: selection },
                runtimeModelDescriptor: model,
                machineId,
                agentTargetKey,
                agentId: FIXTURE_AGENT_ROUTING_ID,
                lease,
                getAccountSettingsSnapshot: () => ({
                    source: 'network',
                    settings: accountSettings,
                    settingsVersion: 1,
                    loadedAtMs: 1,
                    settingsSecretsReadKeys: [],
                    scopeKey: 'account-public-p-composed',
                }),
                materializationBaseDir: join(
                    happyHomeDir,
                    'providers',
                    'materialized',
                ),
                managedPurposeBindingSnapshot: { v: 1, bindings: [] },
                sessionId,
            });
        if (!initialAuthorization.ok) {
            throw new Error(initialAuthorization.error.code);
        }
        const sessionBindingMetadata =
            initialAuthorization.attempt.authorization
                .sessionBindingMetadata;
        initialAuthorization.attempt.cleanupOnFailure();

        const retainedVersionId = 'public-p-composed';
        const runnerProcessStartTimeMs = 1_717_171_717_000;
        const runnerProcessCommand = [
            process.execPath,
            `/opt/happier/versions/${retainedVersionId}/package-dist/index.mjs`,
            FIXTURE_AGENT_ROUTING_ID,
        ].map((value) => JSON.stringify(value)).join(' ');
        testState.readProcessIdentityByPid.mockImplementation(
            async (pid: number) => pid === process.pid
                ? {
                    pid,
                    processStartTimeMs: runnerProcessStartTimeMs,
                    command: runnerProcessCommand,
                }
                : null,
        );
        const runner = Object.freeze({
            pid: process.pid,
            processStartTimeMs: runnerProcessStartTimeMs,
            processCommandHash: hashProcessCommand(runnerProcessCommand),
        });
        const tracked: TrackedSession = {
            pid: process.pid,
            sessionRunnerPid: process.pid,
            startedBy: 'daemon',
            happySessionId: sessionId,
            processStartTimeMs: runner.processStartTimeMs,
            processCommandHash: runner.processCommandHash,
            spawnOptions: {
                directory: happyHomeDir,
                backendTarget: {
                    kind: 'backend',
                    backendId: FIXTURE_AGENT_ROUTING_ID,
                },
                modelSelection: {
                    v: 1,
                    updatedAt: 2,
                    ref: selection,
                },
                providerBindingMetadataV1: sessionBindingMetadata,
            },
            runnerAgentInvocationContext: {
                cwd: happyHomeDir,
                environment: {},
                providerBindingActive: true,
            },
            runnerAgentBootstrapIdentity: {
                agentId: FIXTURE_AGENT_ROUTING_ID,
                backendId: FIXTURE_AGENT_ROUTING_ID,
            },
        };
        await writeSessionMarker({
            pid: runner.pid,
            happySessionId: sessionId,
            startedBy: 'daemon',
            processStartTimeMs: runner.processStartTimeMs,
            processCommandHash: runner.processCommandHash,
        });
        const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
        const daemonRuntimes: Array<
            Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>
        > = [];
        const stoppedDaemonRuntimes = new Set<
            Awaited<ReturnType<typeof startDaemonSessionControlRuntime>>
        >();
        const startDaemonAuthorityHost = async () => {
            const runtime = await startDaemonSessionControlRuntime({
                machineId,
                serverBaseUrl: 'https://account.example.test',
                credentials: {
                    token: 'token-public-p-composed',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                daemonSessionMutationCustody: {
                    stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
                },
                api: {} as never,
                loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
                connectedServicesMaterializationBaseDir: join(
                    happyHomeDir,
                    'connected-services',
                ),
                getConnectedServiceRefreshCoordinator: () => null,
                getConnectedServiceQuotasCoordinator: () => null,
                pidToTrackedSession,
                pidToAwaiter: new Map(),
                pidToSpawnResultResolver: new Map(),
                pidToSpawnWebhookTimeout: new Map(),
                getApiMachineForSessions: () => null,
                spawnResourceCleanupByPid: new Map(),
                sessionAttachCleanupByPid: new Map(),
                connectedServicesRestartRequestedPids: new Set(),
                beforeShutdown: vi.fn(),
                onHappySessionWebhook: vi.fn(),
                requestShutdown: vi.fn(),
                processEnv: {},
            });
            daemonRuntimes.push(runtime);
            return runtime;
        };
        const stopDaemonRuntime = async (
            runtime: Awaited<
                ReturnType<typeof startDaemonSessionControlRuntime>
            >,
        ) => {
            if (stoppedDaemonRuntimes.has(runtime)) return;
            stoppedDaemonRuntimes.add(runtime);
            await runtime.stopControlServer();
        };
        cleanups.push(async () => {
            for (const runtime of [...daemonRuntimes].reverse()) {
                await stopDaemonRuntime(runtime);
            }
        });

        composedPhase = 'A authority setup';
        const daemonRuntimeA = await startDaemonAuthorityHost();
        const controlInputA = testState.controlInputs.get(
            daemonRuntimeA.controlPort,
        );
        if (!controlInputA?.agentRuntimeDaemonServices) {
            throw new Error('Expected daemon Agent-runtime service authority');
        }

        const authorityFilePath =
            await createAgentRuntimeDaemonServiceAuthorityPath({
                happyHomeDir,
                publicReleaseRing: 'stable',
            });
        tracked.agentRuntimeDaemonServiceAuthorityFilePath =
            authorityFilePath;
        await expect(
            updateSessionMarkerAgentRuntimeDaemonServiceAuthorityPath({
                pid: runner.pid,
                sessionId,
                processCommandHash: runner.processCommandHash,
                processStartTimeMs: runner.processStartTimeMs,
                authorityFilePath,
            }),
        ).resolves.toBe(true);
        const rotateDaemonAuthority = async (httpPort: number) =>
            await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
                happyHomeDir,
                publicReleaseRing: 'stable',
                httpPort,
                sessionId,
                tracked,
                resolveCurrentRetainedAgent: ({ agentId }) => {
                    if (agentId !== FIXTURE_AGENT_ROUTING_ID) {
                        throw new Error(
                            `Unexpected retained Agent id: ${agentId}`,
                        );
                    }
                    return retainedAgent;
                },
                readProcessIdentityByPidFn:
                    testState.readProcessIdentityByPid,
            });
        const authorityA = await rotateDaemonAuthority(
            daemonRuntimeA.controlPort,
        );
        const authorityAMarker = (await listSessionMarkers()).find(
            (marker) => marker.pid === runner.pid,
        );
        expect(authorityAMarker).toMatchObject({
            agentRuntimeDaemonServiceAuthorityFilePath:
                authorityA.path,
            runnerAgentImmutableGenerationId:
                agentGeneration.immutableGenerationId,
            runnerManagedDependencyRetentionV1: {
                sourceGenerationIds: [],
                qualifiedDependencyIds: [],
            },
        });
        expect(authorityA.document).toMatchObject({
            v: 2,
            sessionId,
            runner: {
                pid: runner.pid,
                processStartTimeMs: runner.processStartTimeMs,
                processCommandHash: runner.processCommandHash,
                snapshotIdentity: `version:${retainedVersionId}`,
            },
            retainedAgent,
            httpPort: daemonRuntimeA.controlPort,
            capability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });
        expect(authorityA.document).not.toHaveProperty('agentExecutionGrant');
        expect(tracked).toMatchObject({
            agentRuntimeDaemonServiceCapabilityHash:
                authorityA.capabilityDigest,
            runnerAgentImmutableGenerationId:
                agentGeneration.immutableGenerationId,
        });
        expect(tracked.runnerAgentBootstrapIdentity).toBeUndefined();
        expect(JSON.stringify(authorityAMarker))
            .not.toContain(authorityA.document.capability);
        let currentDaemonAuthority = authorityA;

        const initialSessionMetadata: Metadata =
            applySessionProviderBindingMetadataV1(
                createTestMetadata({ path: happyHomeDir }),
                sessionBindingMetadata,
            );
        const updateMetadataAsCurrentPublisher = vi.fn(async (
            updater: (metadata: Metadata) => Metadata,
        ) => {
            session.updateMetadata((current) =>
                updater(current ?? initialSessionMetadata)
            );
        });
        const session = createMutableApiSessionClientFixture<Metadata>({
            sessionId,
            metadata: initialSessionMetadata,
            overrides: { updateMetadataAsCurrentPublisher },
        });
        const custodyRequests: Array<
            ReturnType<
                typeof RunnerManagedServicesCustodyRequestV1Schema.parse
            >
        > = [];
        testState.callSessionRpc.mockImplementation(async (request: {
            method: string;
            request: unknown;
        }) => {
            expect(request.method).toBe(
                `${sessionId}:${RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD}`,
            );
            const custodyRequest =
                RunnerManagedServicesCustodyRequestV1Schema.parse(
                    request.request,
            );
            custodyRequests.push(custodyRequest);
            return await session.rpcHandlerManager.invokeLocal(
                RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
                custodyRequest,
            );
        });

        const daemonRequests: Array<
            ReturnType<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>
        > = [];
        const originalFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (
            input: string | URL | Request,
            init?: RequestInit,
        ) => {
            const url = input instanceof Request
                ? input.url
                : input.toString();
            if (url.endsWith(AGENT_RUNTIME_DAEMON_SERVICES_PATH)) {
                const daemonServiceUrl = new URL(url);
                expect(daemonServiceUrl.hostname).toBe('127.0.0.1');
                const controlInput = testState.controlInputs.get(
                    Number(daemonServiceUrl.port),
                );
                if (!controlInput?.agentRuntimeDaemonServices) {
                    return new Response(JSON.stringify({
                        ok: false,
                        error: {
                            code: 'agent_runtime_daemon_service_authority_unavailable',
                            message:
                                'The addressed daemon control runtime is unavailable',
                        },
                    }), {
                        status: 409,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                const body = typeof init?.body === 'string'
                    ? JSON.parse(init.body) as unknown
                    : null;
                const request =
                    AgentRuntimeDaemonServiceRequestV1Schema.parse(body);
                const suppliedCapability = new Headers(
                    init?.headers ?? (
                        input instanceof Request ? input.headers : undefined
                    ),
                ).get('x-happier-daemon-token');
                if (
                    suppliedCapability !== request.context.token
                    || request.context.token
                        !== currentDaemonAuthority.document.capability
                    || Number(daemonServiceUrl.port)
                        !== currentDaemonAuthority.document.httpPort
                ) {
                    return new Response(JSON.stringify({
                        ok: false,
                        error: {
                            code: 'agent_runtime_daemon_service_forbidden',
                            message:
                                'The private daemon-service capability is stale or invalid',
                        },
                    }), {
                        status: 403,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                daemonRequests.push(request);
                const invocationContext =
                    tracked.runnerAgentInvocationContext;
                if (!invocationContext) {
                    throw new Error(
                        'Expected retained runner invocation context',
                    );
                }
                const directDispatchContext = {
                    sessionId,
                    runner: currentDaemonAuthority.document.runner,
                    retainedAgent:
                        currentDaemonAuthority.document.retainedAgent,
                    invocationContext,
                    trackedSession: tracked,
                    signal: init?.signal ?? undefined,
                };
                if (
                    request.operation.kind
                        === 'managed_server.supervision.authorize'
                    && request.operation.contributionId.includes(
                        '/providers/',
                    )
                ) {
                    await expect(
                        controlInput.agentRuntimeDaemonServices!.dispatch(
                            AgentRuntimeDaemonServiceRequestV1Schema.parse({
                                ...request,
                                operation: {
                                    ...request.operation,
                                    requestId:
                                        'tampered-provider-executable',
                                    executable: {
                                        kind:
                                            'packaged-runtime-binary',
                                        directorySegments: [
                                            'tools',
                                            'unpacked',
                                        ],
                                        executableBaseName:
                                            'another-safe-runtime',
                                    },
                                },
                            }),
                            directDispatchContext,
                        ),
                    ).rejects.toMatchObject({
                        code: 'plugin_managed_server_launch_denied',
                    });
                    await expect(
                        controlInput.agentRuntimeDaemonServices!.dispatch(
                            AgentRuntimeDaemonServiceRequestV1Schema.parse({
                                ...request,
                                operation: {
                                    ...request.operation,
                                    requestId:
                                        'tampered-provider-environment',
                                    environmentKeys: [
                                        ...request.operation.environmentKeys,
                                        'ARBITRARY_RUNNER_KEY',
                                    ],
                                },
                            }),
                            directDispatchContext,
                        ),
                    ).rejects.toMatchObject({
                        code: 'plugin_managed_server_launch_denied',
                    });
                }
                try {
                    const response =
                        await controlInput.agentRuntimeDaemonServices.dispatch(
                            request,
                            directDispatchContext,
                        );
                    if (
                        request.operation.kind
                            === 'turn.admission.authorize'
                        && response.ok
                        && response.result.kind === 'turn.admission'
                        && response.result.status === 'admitted'
                    ) {
                        tracked.activeTurnId = request.operation.witness.turnId;
                        tracked.agentRuntimeDaemonServiceAdmittedTurnId =
                            request.operation.witness.turnId;
                        tracked.agentRuntimeDaemonServiceAdmittedInputId =
                            request.operation.witness.inputId;
                        tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq =
                            request.operation.witness.userMessageSeq;
                        tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs = [
                            ...request.operation.witness.userMessageSeqs,
                        ];
                    }
                    return new Response(JSON.stringify(response), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                } catch (error) {
                    const code = error && typeof error === 'object'
                        && typeof Reflect.get(error, 'code') === 'string'
                        ? Reflect.get(error, 'code') as string
                        : 'agent_runtime_daemon_service_authority_unavailable';
                    const message = error instanceof Error
                        ? error.message
                        : 'Daemon Agent-runtime service dispatch failed';
                    return new Response(JSON.stringify({
                        ok: false,
                        error: { code, message },
                    }), {
                        status: 409,
                        headers: { 'content-type': 'application/json' },
                    });
                }
            }
            if (new URL(url).pathname === '/healthz') {
                expect(new URL(url).hostname).toBe('127.0.0.1');
                return new Response('{}', {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response('{}', {
                status: 404,
                headers: { 'content-type': 'application/json' },
            });
        }));
        cleanups.push(() => {
            vi.stubGlobal('fetch', originalFetch);
        });

        const spawned: Array<Readonly<{
            command: string;
            env: Readonly<Record<string, string>>;
            disposed: ReturnType<typeof vi.fn>;
        }>> = [];
        testState.spawnSupervisedPluginProcess.mockImplementation((input: {
            command: string;
            env?: Readonly<Record<string, string>>;
        }) => {
            const disposed = vi.fn();
            spawned.push(Object.freeze({
                command: input.command,
                env: Object.freeze({ ...(input.env ?? {}) }),
                disposed,
            }));
            return createPendingProcess(disposed);
        });

        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir,
            publicReleaseRing: 'stable',
            authorityFilePath,
            expectedSessionId: sessionId,
        });
        if (!source) {
            throw new Error('Expected the current Runner Agent runtime source');
        }
        expect(source.identity).toMatchObject({
            pluginId: FIXTURE_AGENT_PLUGIN_ID,
            agentId: FIXTURE_AGENT_ROUTING_ID,
            immutableGenerationId:
                agentGeneration.immutableGenerationId,
        });
        const managedServicesCustodyPort =
            source.managedServicesCustodyPort;
        if (!managedServicesCustodyPort) {
            throw new Error(
                'Expected the Runner managed-services custody port',
            );
        }
        expect(testState.readProcessIdentityByPid)
            .toHaveBeenCalledWith(process.pid);
        cleanups.push(async () => await source.retire?.());

        const observedOpenRequest: {
            current: AgentSessionOpenRequest | null;
        } = { current: null };
        const observedPluginServices: {
            current: PluginServices | null;
        } = { current: null };
        let childHandle: PluginProcessHandle | null = null;
        const runtimeSend = vi.fn();
        const createObservedRuntime = async (input: {
            signal: AbortSignal;
        }): Promise<AgentRuntime> => {
            const loaded = await source.createRuntime(input);
            const sessionsFactory: NonNullable<AgentRuntime['sessions']> = {
                async open(request, context) {
                    observedOpenRequest.current = request;
                    observedPluginServices.current = context.services;
                    const listeners = new Set<
                        (event: AgentSessionRuntimeEvent) => void
                    >();
                    const runtime: AgentSessionRuntime = {
                        async send() {
                            runtimeSend();
                            childHandle ??=
                                await context.services.exec.spawn({
                                    executable: {
                                        kind: 'systemTool',
                                        id: FIXTURE_AGENT_SYSTEM_TOOL_ID,
                                    },
                                    env: {
                                        ...(request.launchEnvironment
                                            ?.values ?? {}),
                                    },
                                });
                            return { status: 'admitted' as const };
                        },
                        async cancel() {},
                        watch(listener) {
                            listeners.add(listener);
                            return Object.freeze({
                                dispose() {
                                    listeners.delete(listener);
                                },
                            });
                        },
                        async dispose() {
                            await childHandle?.dispose();
                        },
                    };
                    return Object.freeze(runtime);
                },
            };
            const sessions = Object.freeze(sessionsFactory);
            return Object.freeze({
                ...loaded,
                sessions,
            });
        };

        const agent =
            registry.contributes.agentDefinitionsById.get(FIXTURE_AGENT_ROUTING_ID);
        if (!agent) {
            throw new Error(
                'Expected the external fixture Agent contribution projection',
            );
        }
        const backend = projectEngineRuntimeContributionFromAgent(
            agent,
            FIXTURE_AGENT_ROUTING_ID,
        );
        const plan = await createNativeAgentRuntimeSessionPlan({
            createRuntime: createObservedRuntime,
            identity: source.identity,
            backend,
            agent,
            createSessionHostServiceOwners: () =>
                createSessionHostServiceOwners(),
            prepareManagedProviderBinding:
                source.prepareManagedProviderBinding,
            createInvocationServices: (input) =>
                source.createInvocationServices({
                    pluginId: source.identity.pluginId,
                    pluginVersion: source.identity.pluginVersion,
                    agentId: source.identity.agentId,
                    generation: source.identity.generation,
                    ...input,
                    isGenerationCurrent: source.identity.isCurrent,
                }),
            authorizeNewTurn: source.authorizeNewTurn,
            attestSessionOpen: source.attestSessionOpen,
            retireRuntimeSource: source.retire,
            managedServiceEndpointReadPort:
                source.managedServiceEndpointReadPort,
            managedServicesCustodyPort:
                managedServicesCustodyPort,
            sessionInput: buildPluginSessionBindingInput({
                credentials: {
                    token: 'token-public-p-composed',
                    encryption: {
                        type: 'legacy',
                        secret: new Uint8Array(32).fill(1),
                    },
                },
                directory: happyHomeDir,
                backendTarget: {
                    kind: 'backend',
                    backendId: FIXTURE_AGENT_ROUTING_ID,
                },
                modelSelection: {
                    v: 1,
                    updatedAt: 2,
                    ref: selection,
                },
                resolveLateEnvironment: async () => ({
                    environmentVariables: {},
                    unsetEnvironmentVariables: [],
                    sensitiveEnvironmentVariableNames: [],
                }),
            }),
        });
        if (!plan.config.createSessionRuntime) {
            throw new Error('Expected Native Session runtime factory');
        }
        const metadata = initialSessionMetadata;
        composedPhase = 'A/P composed launch';
        const composed = await plan.config.createSessionRuntime({
            directory: happyHomeDir,
            metadata,
            machineId,
            session,
            transcriptSession: session,
            messageBuffer: {},
            messageQueue: new MessageQueue2<
                { permissionMode: string },
                { text: string }
            >((mode) => mode.permissionMode),
            mcpServers: {},
            permissionHandler: {
                cancelByPlugin: vi.fn(async () => undefined),
            },
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as never);
        cleanups.push(async () => {
            await composed.operations.resetOrDisposeRuntime();
        });
        expect(updateMetadataAsCurrentPublisher).not.toHaveBeenCalled();
        expect((composed as Readonly<{
            admittedProviderBindingHandoff?: Readonly<{
                sessionBindingMetadata: unknown;
            }>;
        }>).admittedProviderBindingHandoff?.sessionBindingMetadata).toEqual(
            sessionBindingMetadata,
        );

        const nativeOpenRequest = observedOpenRequest.current;
        if (!nativeOpenRequest) {
            throw new Error('Expected the observed Agent Session to open');
        }
        const openJson = JSON.stringify(nativeOpenRequest);
        const providerChild = spawned.find(isFixtureProviderChild);
        expect(providerChild).toBeDefined();
        expect(await realpath(providerChild!.command)).toBe(
            canonicalProviderPBinary,
        );
        expect(providerChild?.env.FIXTURE_PROVIDER_GENERATION).toBe('P');
        const rawBearer =
            providerChild?.env[FIXTURE_PROVIDER_BEARER_ENV_KEY];
        expect(rawBearer).toEqual(expect.any(String));
        expect(openJson).not.toContain(rawBearer!);
        expect(openJson).toContain(FIXTURE_AGENT_PROVIDER_ENV_KEY);
        const placeholder = nativeOpenRequest.launchEnvironment?.values
            [FIXTURE_AGENT_PROVIDER_ENV_KEY];
        expect(placeholder).toEqual(expect.any(String));
        expect(placeholder).not.toBe(rawBearer);
        expect(JSON.stringify(daemonRequests)).not.toContain(rawBearer!);
        expect(JSON.stringify(custodyRequests)).not.toContain(rawBearer!);
        expect(testState.fetchAccountEncryptionCurrentness)
            .toHaveBeenCalled();
        expect(JSON.stringify(testState.callSessionRpc.mock.calls))
            .not.toContain(rawBearer!);
        expect(JSON.stringify(tracked)).not.toContain(rawBearer!);
        expect(testState.resolveFirstPartyVersionInstallPath)
            .not.toHaveBeenCalled();
        expectDesiredCurrentProviderRuntimeResolutionCount(0);
        const daemonOperationKinds = daemonRequests.map(
            (request) => request.operation.kind,
        );
        const providerStartRequest = daemonRequests.find((request) =>
            request.operation.kind
                === 'plugin_services.managed_provider.start_v1'
        );
        if (
            !providerStartRequest
            || providerStartRequest.operation.kind
                !== 'plugin_services.managed_provider.start_v1'
        ) {
            throw new Error('Expected exact initial public P start request');
        }
        expect(providerStartRequest?.operation).toMatchObject({
            retained: {
                scope: {
                    pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                    providerLocalId: FIXTURE_PROVIDER_ID,
                    manifestAuthority: 'external',
                },
            },
        });
        expect(daemonOperationKinds.filter((kind) =>
            kind === 'plugin_services.managed_provider.start_v1'
        )).toHaveLength(1);
        expect(daemonOperationKinds.filter((kind) =>
            kind
                === 'plugin_services.managed_provider.materialize_agent_binding_v1'
        )).toHaveLength(1);
        const providerMaterializationRequest = daemonRequests.find(
            (request) => request.operation.kind
                === 'plugin_services.managed_provider.materialize_agent_binding_v1',
        );
        if (
            !providerMaterializationRequest
            || providerMaterializationRequest.operation.kind
                !== 'plugin_services.managed_provider.materialize_agent_binding_v1'
        ) {
            throw new Error(
                'Expected exact initial public P Agent materialization',
            );
        }
        expect(providerMaterializationRequest?.operation).toMatchObject({
            credentialPlaceholder: placeholder,
            endpointUrl: expect.stringMatching(
                /^http:\/\/127\.0\.0\.1:\d+\/v1$/u,
            ),
        });
        const custodyOperationKinds = custodyRequests.map(
            (request) => request.kind,
        );
        const runnerSuperviseRequest = custodyRequests.find(
            (request) => request.kind === 'supervise',
        );
        expect(runnerSuperviseRequest).toMatchObject({
            scope: {
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                providerLocalId: FIXTURE_PROVIDER_ID,
            },
            spec: {
                id: FIXTURE_PROVIDER_SERVICE_ID,
                mode: {
                    kind: 'spawn',
                    endpoint: {
                        kind: 'assignAndInject',
                        host: '127.0.0.1',
                    },
                },
                clientAccess: {
                    kind: 'hostBearer',
                    injectEnvironmentKey:
                        FIXTURE_PROVIDER_BEARER_ENV_KEY,
                },
            },
        });
        expect(custodyOperationKinds.filter((kind) =>
            kind === 'supervise'
        )).toHaveLength(1);
        expect(custodyOperationKinds.filter((kind) =>
            kind === 'projectEndpointAccess'
        )).toHaveLength(1);
        expect(custodyOperationKinds.filter((kind) =>
            kind === 'commitAdoption'
        )).toHaveLength(1);
        const commitAdoptionRequest = custodyRequests.find(
            (request) => request.kind === 'commitAdoption',
        );
        if (
            !commitAdoptionRequest
            || commitAdoptionRequest.kind !== 'commitAdoption'
        ) {
            throw new Error('Expected exact initial public P adoption');
        }
        if (
            !runnerSuperviseRequest
            || runnerSuperviseRequest.kind !== 'supervise'
        ) {
            throw new Error('Expected exact initial public P supervision');
        }
        expect(commitAdoptionRequest.claim).toEqual(
            providerStartRequest.operation.retained.scope,
        );
        expect(commitAdoptionRequest.claim).toMatchObject({
            pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
            providerLocalId: FIXTURE_PROVIDER_ID,
            immutableGenerationId:
                providerGeneration.immutableGenerationId,
        });
        expect(runnerSuperviseRequest.scope).toEqual(
            commitAdoptionRequest.claim,
        );
        const retainedMarker = (await listSessionMarkers()).find(
            (marker) => marker.pid === runner.pid,
        );
        expect(retainedMarker?.runnerManagedDependencyRetentionV1)
            .toMatchObject({
                adoptedManagedProviderAuthority: {
                    pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                    immutableGenerationId:
                        commitAdoptionRequest.claim.immutableGenerationId,
                    manifestAuthority: 'external',
                    hardRevocationRevisionAtAdmission:
                        expect.any(Number),
                },
            });
        if (!retainedMarker?.runnerManagedDependencyRetentionV1) {
            throw new Error(
                'Expected canonical marker to retain exact public P authority',
            );
        }
        const turnId = 'turn-public-p-composed';
        const inputId = 'input-public-p-composed';
        await expect(composed.operations.sendTurnPrompt('prove public P', {
            turnId,
            localId: inputId,
            userMessageSeq: 17,
        })).resolves.toBeUndefined();
        const initialTurnAdmission = daemonRequests.find((request) =>
            request.operation.kind === 'turn.admission.authorize'
            && request.operation.witness.turnId === turnId
        );
        expect(initialTurnAdmission).toMatchObject({
            context: {
                sessionId,
                token: authorityA.document.capability,
            },
            operation: {
                kind: 'turn.admission.authorize',
                witness: {
                    turnId,
                    inputId,
                    userMessageSeq: 17,
                    userMessageSeqs: [],
                },
            },
        });
        expect(tracked).toMatchObject({
            agentRuntimeDaemonServiceAdmittedTurnId: turnId,
            agentRuntimeDaemonServiceAdmittedInputId: inputId,
            agentRuntimeDaemonServiceAdmittedUserMessageSeq: 17,
            agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [],
        });

        composedPhase = 'A/P retained continuity';
        initialRegistryLeaseReleased = true;
        await initialRegistryLease.release();

        composedPhase = 'G/H and P/Q replacement package and admission';
        await writeExternalPublicHandoffAgentPluginFixture({
            pluginRoot: agentHPluginRoot,
            version: '2.0.0',
            generation: 'H',
        });
        await writeExternalPublicHandoffProviderPluginFixture({
            pluginRoot: providerQPluginRoot,
            version: '2.0.0',
            generation: 'Q',
        });
        const [agentHPacked, providerQPacked] = await Promise.all([
            packPublicHandoffFixture({
                archivePath: join(happyHomeDir, 'agent-h.tgz'),
                pluginId: FIXTURE_AGENT_PLUGIN_ID,
                pluginRoot: agentHPluginRoot,
            }),
            packPublicHandoffFixture({
                archivePath: join(happyHomeDir, 'provider-q.tgz'),
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                pluginRoot: providerQPluginRoot,
            }),
        ]);
        await commitPackedPublicHandoffFixture({
            changeService: fixtureChangeService,
            packed: agentHPacked,
        });
        await commitPackedPublicHandoffFixture({
            changeService: fixtureChangeService,
            packed: providerQPacked,
        });
        const currentGenerationAuthority =
            await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                { bundledArtifacts: [] },
            );
        const agentHGeneration = currentGenerationAuthority?.generations.get(
            FIXTURE_AGENT_PLUGIN_ID,
        );
        const providerQGeneration =
            currentGenerationAuthority?.generations.get(
                FIXTURE_PROVIDER_PLUGIN_ID,
            );
        if (
            !currentGenerationAuthority?.commit
            || !agentHGeneration
            || !providerQGeneration
        ) {
            throw new Error('Expected current committed H/Q generations');
        }
        composedPhase = 'G/H and P/Q current-generation continuity';
        expect(agentHGeneration.immutableGenerationId).not.toBe(
            agentGeneration.immutableGenerationId,
        );
        expect(providerQGeneration.immutableGenerationId).not.toBe(
            providerGeneration.immutableGenerationId,
        );
        expect(agentHGeneration.record).toMatchObject({
            pluginId: FIXTURE_AGENT_PLUGIN_ID,
            immutableGenerationId: agentHGeneration.immutableGenerationId,
            manifestRelativePath: '.happier-plugin/plugin.json',
        });
        expect(providerQGeneration.record).toMatchObject({
            pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
            immutableGenerationId: providerQGeneration.immutableGenerationId,
            manifestRelativePath: '.happier-plugin/plugin.json',
        });
        expect(providerQGeneration.record.files).toEqual(expect.arrayContaining([
            expect.objectContaining({
                relativePath: fixtureProviderRuntimeRelativePath,
            }),
        ]));
        const canonicalProviderQBinary = await realpath(join(
            providerQGeneration.rootPath,
            ...fixtureProviderRuntimeRelativePath.split('/'),
        ));
        expect(canonicalProviderQBinary).not.toBe(canonicalProviderPBinary);

        const currentRegistryLease =
            await pluginReloadController.acquireRuntimeRegistry();
        const currentRegistry = currentRegistryLease.registry;
        expect(currentRegistry.agentRuntimesByAgentId.get(FIXTURE_AGENT_ROUTING_ID))
            .toMatchObject({
                pluginId: FIXTURE_AGENT_PLUGIN_ID,
                immutableGenerationId:
                    agentHGeneration.immutableGenerationId,
                sessionRunnerFactoryBinding: {
                    pluginId: FIXTURE_AGENT_PLUGIN_ID,
                    immutableGenerationId:
                        agentHGeneration.immutableGenerationId,
                    agentId: FIXTURE_AGENT_ROUTING_ID,
                    localAgentId: FIXTURE_AGENT_ID,
                    locator: {
                        module: './agentRuntime.js',
                        export: 'publicHandoffAgentRuntimeFactory',
                        runtimeApiVersion: 1,
                    },
                },
            });
        const currentProviderRuntime =
            await currentRegistry.acquireManagedProviderRuntime?.({
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                localId: FIXTURE_PROVIDER_ID,
            });
        expect(currentProviderRuntime).toMatchObject({
            immutableGenerationId:
                providerQGeneration.immutableGenerationId,
        });
        await currentRegistryLease.release();

        await expect(composed.operations.sendTurnPrompt(
            'prove retained G after H/Q',
            {
                turnId: 'turn-public-g-retained-after-hq',
                localId: 'input-public-g-retained-after-hq',
                userMessageSeq: 18,
            },
        )).resolves.toBeUndefined();
        expect(daemonRequests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                operation: expect.objectContaining({
                    kind: 'turn.admission.authorize',
                    witness: {
                        turnId: 'turn-public-g-retained-after-hq',
                        inputId: 'input-public-g-retained-after-hq',
                        userMessageSeq: 18,
                        userMessageSeqs: [],
                    },
                }),
            }),
        ]));

        const agentChild = spawned.find((entry) =>
            entry.command === process.execPath,
        );
        expect(agentChild?.env[FIXTURE_AGENT_PROVIDER_ENV_KEY])
            .toBe(rawBearer);
        expect(agentChild?.env[FIXTURE_AGENT_PROVIDER_ENV_KEY])
            .not.toBe(placeholder);
        expect(spawned.filter(isFixtureProviderChild))
            .toHaveLength(1);
        expect(spawned.filter((entry) => entry.command === process.execPath))
            .toHaveLength(1);
        expect(spawned.flatMap((entry) =>
            Object.entries(entry.env)
                .filter(([, value]) => value === rawBearer)
                .map(([key]) => ({ command: entry.command, key })),
        )).toEqual([
            {
                command: canonicalProviderPBinary,
                key: FIXTURE_PROVIDER_BEARER_ENV_KEY,
            },
            {
                command: process.execPath,
                key: FIXTURE_AGENT_PROVIDER_ENV_KEY,
            },
        ]);
        composedPhase = 'P/Q stale-artifact fence and current-Q launch';
        const startCurrentProvider =
            createPublicManagedProviderRuntimeStartOperation({
                machineId,
                happyHomeDir,
                controller: pluginReloadController,
            });
        const providerQBinaryBytes = await readFile(canonicalProviderQBinary);
        await rm(canonicalProviderQBinary);
        const spawnCountBeforeStaleArtifactProbe = spawned.length;
        await expect(startCurrentProvider({
            contributionKey,
            identity: {
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                localId: FIXTURE_PROVIDER_ID,
            },
            request: {
                reason: 'explicitStartLocal',
                endpointTemplateIds: [FIXTURE_PROVIDER_ENDPOINT_ID],
            },
            purposeBindings: { v: 1, bindings: [] },
            isAuthorizationCurrent: () => true,
            revalidateAuthorization: async () => true,
        })).rejects.toMatchObject({
            code: 'provider_endpoint_unavailable',
        });
        expect(spawned).toHaveLength(spawnCountBeforeStaleArtifactProbe);
        await writeFile(canonicalProviderQBinary, providerQBinaryBytes, {
            mode: 0o755,
        });
        if (process.platform !== 'win32') {
            await chmod(canonicalProviderQBinary, 0o755);
        }
        const spawnCountBeforeCurrentProviderStart = spawned.length;
        await expect(startCurrentProvider({
            contributionKey,
            identity: {
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                localId: FIXTURE_PROVIDER_ID,
            },
            request: {
                reason: 'explicitStartLocal',
                endpointTemplateIds: [FIXTURE_PROVIDER_ENDPOINT_ID],
            },
            purposeBindings: { v: 1, bindings: [] },
            isAuthorizationCurrent: () => true,
            revalidateAuthorization: async () => true,
        })).resolves.toEqual({ status: 'running' });
        expect(spawned).toHaveLength(
            spawnCountBeforeCurrentProviderStart + 1,
        );
        const currentProviderChild =
            spawned[spawnCountBeforeCurrentProviderStart];
        if (!currentProviderChild) {
            throw new Error('Expected current Q managed Provider child');
        }
        expect(await realpath(currentProviderChild.command))
            .toBe(canonicalProviderQBinary);
        expect(currentProviderChild).not.toBe(providerChild);
        expect(currentProviderChild.env.FIXTURE_PROVIDER_GENERATION).toBe('Q');
        expect(providerChild?.disposed).not.toHaveBeenCalled();
        expect(spawned.filter(isFixtureProviderChild)).toHaveLength(2);
        composedPhase = 'P/Q continuity assertions';
        const hardRevocationRevision =
            currentGenerationAuthority.commit.revision + 1;
        const postHardRevocationRetainRevision =
            hardRevocationRevision + 1;
        expect(providerChild?.disposed).not.toHaveBeenCalled();
        expectDesiredCurrentProviderRuntimeResolutionCount(0);
        expect(spawned.filter(isFixtureProviderChild))
            .toHaveLength(2);
        await expect(readPreparedImmutablePluginGeneration({
            paths: resolvePluginStorePaths({ happyHomeDir }),
            immutableGenerationId:
                agentGeneration.immutableGenerationId,
        })).resolves.toMatchObject({
            record: {
                pluginId: FIXTURE_AGENT_PLUGIN_ID,
            },
        });

        composedPhase = 'B authority rotation continuity';
        const daemonRuntimeB = await startDaemonAuthorityHost();
        const controlInputB = testState.controlInputs.get(
            daemonRuntimeB.controlPort,
        );
        const daemonServicesB =
            controlInputB?.agentRuntimeDaemonServices;
        if (!daemonServicesB) {
            throw new Error(
                'Expected rotated daemon B Agent-runtime service authority',
            );
        }
        const authorityB = await rotateDaemonAuthority(
            daemonRuntimeB.controlPort,
        );
        expect(authorityB.capabilityDigest).not.toBe(
            authorityA.capabilityDigest,
        );
        expect(authorityB.document.capability).not.toBe(
            authorityA.document.capability,
        );
        expect(authorityB.document.capability).not.toBe(rawBearer);
        expect(authorityB.document.httpPort).toBe(
            daemonRuntimeB.controlPort,
        );
        expect(authorityB.document.runner).toEqual(
            authorityA.document.runner,
        );
        expect(authorityB.document.retainedAgent).toEqual(
            authorityA.document.retainedAgent,
        );
        currentDaemonAuthority = authorityB;
        const staleAuthorityAResponse = await fetch(
            `http://127.0.0.1:${daemonRuntimeB.controlPort}${AGENT_RUNTIME_DAEMON_SERVICES_PATH}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-happier-daemon-token': authorityA.document.capability,
                },
                body: JSON.stringify({
                    ...providerStartRequest,
                    context: {
                        sessionId,
                        token: authorityA.document.capability,
                    },
                }),
            },
        );
        expect(staleAuthorityAResponse.status).toBe(403);
        const invocationServices = observedPluginServices.current;
        if (!invocationServices) {
            throw new Error(
                'Expected the runner invocation PluginServices',
            );
        }
        await expect(
            invocationServices.storage.daemonSession.get(
                'daemon-b-retained-public-p-probe',
            ),
        ).resolves.toBeNull();

        const adoptedPublicP =
            await managedServicesCustodyPort.dispatch({
                v: 1,
                kind: 'readAdoptedPublicOutcome',
                claim: commitAdoptionRequest.claim,
            });
        expect(adoptedPublicP).toMatchObject({
            kind: 'adoptedPublicOutcome',
            outcome: {
                operationClaimId:
                    commitAdoptionRequest.claim.operationClaimId,
                endpoints: [{
                    endpointUrl:
                        providerMaterializationRequest.operation.endpointUrl,
                }],
            },
        });
        expect(daemonRequests.filter((request) =>
            request.operation.kind
                === 'plugin_services.managed_provider.start_v1'
        )).toHaveLength(2);
        expect(custodyRequests.filter((request) =>
            request.kind === 'supervise'
        )).toHaveLength(1);
        expect(custodyRequests.filter((request) =>
            request.kind === 'commitAdoption'
        )).toHaveLength(1);
        const physicalPublicPStarts = custodyRequests.filter((request) =>
            request.kind === 'supervise'
            && request.scope.operationClaimId
                === commitAdoptionRequest.claim.operationClaimId
        );
        const physicalNonPStarts = custodyRequests.filter((request) =>
            request.kind === 'supervise'
            && request.scope.operationClaimId
                !== commitAdoptionRequest.claim.operationClaimId
        );
        expect(physicalPublicPStarts).toHaveLength(1);
        expect(physicalNonPStarts).toHaveLength(0);
        expect(spawned.filter(isFixtureProviderChild))
            .toHaveLength(2);
        expectDesiredCurrentProviderRuntimeResolutionCount(0);
        await stopDaemonRuntime(daemonRuntimeA);
        expect(providerChild?.disposed).not.toHaveBeenCalled();

        composedPhase = 'B provider-policy fence';
        const revokedProviderSettings = ProviderSettingsV1Schema.parse({
            ...providerSettings,
            machineGrants: [],
        });
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({
                providerSettingsV1: revokedProviderSettings,
            }),
            settingsVersion: 2,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-public-p-composed',
        });
        await expect(
            invocationServices.storage.daemonSession.get(
                'stable-g-service-after-provider-policy-change',
            ),
        ).resolves.toBeNull();
        const dispatchExactRetainedPublicPStart = async (
            daemonServices: NonNullable<
                Parameters<typeof startDaemonControlServer>[0][
                    'agentRuntimeDaemonServices'
                ]
            >,
            authority: typeof authorityA,
            requestId: string,
        ) => {
            const invocationContext = tracked.runnerAgentInvocationContext;
            if (!invocationContext) {
                throw new Error(
                    'Expected retained runner invocation context',
                );
            }
            return await daemonServices.dispatch(
                AgentRuntimeDaemonServiceRequestV1Schema.parse({
                    ...providerStartRequest,
                    operation: {
                        ...providerStartRequest.operation,
                        requestId,
                    },
                }),
                {
                    sessionId,
                    runner: authority.document.runner,
                    retainedAgent: authority.document.retainedAgent,
                    invocationContext,
                    trackedSession: tracked,
                },
            );
        };
        await expect(dispatchExactRetainedPublicPStart(
            daemonServicesB,
            authorityB,
            'live-provider-policy-fence-probe',
        )).resolves.toMatchObject({
            ok: false,
            error: {
                code:
                    'plugin_services_managed_provider_authority_unavailable',
            },
        });
        expect(spawned.filter(isFixtureProviderChild))
            .toHaveLength(2);
        expect(custodyRequests.filter((request) =>
            request.kind === 'supervise'
        )).toHaveLength(1);
        expectDesiredCurrentProviderRuntimeResolutionCount(0);
        await vi.waitFor(() => {
            expect(providerChild?.disposed).toHaveBeenCalledOnce();
        });
        expect(custodyRequests.filter((request) =>
            request.kind === 'fenceRetainedProviderPolicy'
        )).toHaveLength(1);
        await expect(
            managedServicesCustodyPort.dispatch({
                v: 1,
                kind: 'readAdoptedPublicOutcome',
                claim: commitAdoptionRequest.claim,
            }),
        ).resolves.toMatchObject({
            kind: 'adoptedPublicOutcome',
            outcome: null,
        });
        const markerAfterPolicyFence = (await listSessionMarkers()).find(
            (marker) => marker.pid === runner.pid,
        );
        expect(markerAfterPolicyFence
            ?.runnerManagedDependencyRetentionV1
            ?.adoptedManagedProviderAuthority)
            .toBeUndefined();
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettings,
            settingsVersion: 3,
            loadedAtMs: 3,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-public-p-composed',
        });
        composedPhase = 'C authority rotation continuity';
        const daemonRuntimeC = await startDaemonAuthorityHost();
        const controlInputC = testState.controlInputs.get(
            daemonRuntimeC.controlPort,
        );
        const daemonServicesC =
            controlInputC?.agentRuntimeDaemonServices;
        if (!daemonServicesC) {
            throw new Error(
                'Expected policy-restored daemon Agent-runtime authority',
            );
        }
        const authorityC = await rotateDaemonAuthority(
            daemonRuntimeC.controlPort,
        );
        expect(authorityC.capabilityDigest).not.toBe(
            authorityB.capabilityDigest,
        );
        expect(authorityC.document.capability).not.toBe(
            authorityB.document.capability,
        );
        expect(authorityC.document.capability).not.toBe(rawBearer);
        expect(authorityC.document.runner).toEqual(
            authorityA.document.runner,
        );
        expect(authorityC.document.retainedAgent).toEqual(
            authorityA.document.retainedAgent,
        );
        currentDaemonAuthority = authorityC;
        const staleAuthorityBResponse = await fetch(
            `http://127.0.0.1:${daemonRuntimeC.controlPort}${AGENT_RUNTIME_DAEMON_SERVICES_PATH}`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-happier-daemon-token': authorityB.document.capability,
                },
                body: JSON.stringify({
                    ...providerStartRequest,
                    context: {
                        sessionId,
                        token: authorityB.document.capability,
                    },
                }),
            },
        );
        expect(staleAuthorityBResponse.status).toBe(403);
        await expect(
            invocationServices.storage.daemonSession.get(
                'policy-recovered-retained-p-rebind',
            ),
        ).resolves.toBeNull();
        await expect(dispatchExactRetainedPublicPStart(
            daemonServicesC,
            authorityC,
            'policy-recovered-public-p-currentness-probe',
        )).resolves.toMatchObject({
            ok: false,
            error: {
                code:
                    'plugin_services_managed_provider_authority_unavailable',
            },
        });
        expect(providerChild?.disposed).toHaveBeenCalledOnce();
        expect(custodyRequests.filter((request) =>
            request.kind === 'supervise'
        )).toHaveLength(1);

        await stopDaemonRuntime(daemonRuntimeB);

        composedPhase = 'C hard-revocation continuity';
        pluginReloadController.publishDurableRunningSessionDisposition({
            durableRevision: hardRevocationRevision,
            changedPluginIds: [FIXTURE_PROVIDER_PLUGIN_ID],
            runningSessionDisposition: 'revokeRunningSessions',
            runningSessionRevocationScope: {
                kind: 'immutableGeneration',
                pluginId: FIXTURE_PROVIDER_PLUGIN_ID,
                immutableGenerationId:
                    commitAdoptionRequest.claim.immutableGenerationId,
            },
        });
        await vi.waitFor(() => {
            expect(providerChild?.disposed).toHaveBeenCalledOnce();
            expect(tracked.agentRuntimeRunnerRestartDisposition)
                .toBeUndefined();
            expect(tracked.runnerAgentImmutableGenerationId)
                .toBe(authorityC.document.retainedAgent.immutableGenerationId);
            expect(tracked.agentRuntimeDaemonServiceCapabilityHash)
                .toBe(authorityC.capabilityDigest);
        });
        expect(tracked).not.toHaveProperty(
            'agentRuntimeDaemonServiceExecutionGrant',
        );
        await vi.waitFor(() => {
            expect(custodyRequests.filter((request) =>
                request.kind === 'fenceHardRevocation'
            )).toHaveLength(1);
        });
        expect(currentProviderChild?.disposed).not.toHaveBeenCalled();
        await vi.waitFor(async () => {
            const markerAfterHardRevocation =
                (await listSessionMarkers()).find(
                    (marker) => marker.pid === runner.pid,
                );
            expect(markerAfterHardRevocation).toBeDefined();
            expect(markerAfterHardRevocation
                ?.runnerManagedDependencyRetentionV1)
                .toBeDefined();
            expect(markerAfterHardRevocation
                ?.runnerManagedDependencyRetentionV1
                ?.adoptedManagedProviderAuthority)
                .toBeUndefined();
        });
        await expect(
            managedServicesCustodyPort.dispatch({
                v: 1,
                kind: 'readAdoptedPublicOutcome',
                claim: commitAdoptionRequest.claim,
            }),
        ).resolves.toMatchObject({
            kind: 'adoptedPublicOutcome',
            outcome: null,
        });
        await vi.waitFor(async () => {
            expect(JSON.parse(await readFile(authorityFilePath, 'utf8')))
                .toEqual(authorityC.document);
            const authorityLockPrefix =
                `${basename(authorityFilePath)}.lock`;
            const remainingAuthorityLockArtifacts = (
                await readdir(dirname(authorityFilePath))
            ).filter((entry) => entry.startsWith(authorityLockPrefix));
            expect(remainingAuthorityLockArtifacts).toEqual([]);
        });
        pluginReloadController.publishDurableRunningSessionDisposition({
            durableRevision: postHardRevocationRetainRevision,
            changedPluginIds: [FIXTURE_PROVIDER_PLUGIN_ID],
            runningSessionDisposition: 'retainRunningSessions',
        });
        expect(tracked.runnerAgentImmutableGenerationId)
            .toBe(authorityC.document.retainedAgent.immutableGenerationId);
        expect(tracked.agentRuntimeDaemonServiceCapabilityHash)
            .toBe(authorityC.capabilityDigest);
        await expect(dispatchExactRetainedPublicPStart(
            daemonServicesC,
            authorityC,
            'post-hard-revoke-resurrection-probe',
        )).resolves.toMatchObject({
            ok: false,
            error: {
                code:
                    'plugin_services_managed_provider_authority_unavailable',
            },
        });
        expect(spawned.filter(isFixtureProviderChild))
            .toHaveLength(2);
        expect(spawned.filter((entry) => entry.command === process.execPath))
            .toHaveLength(1);
        expect(custodyRequests.filter((request) =>
            request.kind === 'supervise'
        )).toHaveLength(1);
        expect(custodyRequests.filter((request) =>
            request.kind === 'commitAdoption'
        )).toHaveLength(1);
        expect(custodyRequests.filter((request) =>
            request.kind === 'supervise'
            && request.scope.operationClaimId
                !== commitAdoptionRequest.claim.operationClaimId
        )).toHaveLength(0);
        expectDesiredCurrentProviderRuntimeResolutionCount(0);
        await stopDaemonRuntime(daemonRuntimeC);

        await composed.operations.resetOrDisposeRuntime();
        expect(providerChild?.disposed).toHaveBeenCalledOnce();
        expect(agentChild?.disposed).toHaveBeenCalledOnce();
        expect(currentProviderChild?.disposed).not.toHaveBeenCalled();
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
        expect(currentProviderChild?.disposed).toHaveBeenCalledOnce();
        expect(leaseReleases.length).toBeGreaterThan(0);
        expect(leaseReleases.every((release) =>
            release.mock.calls.length === 1
        )).toBe(true);
        expect(runtimeSend).toHaveBeenCalledTimes(2);
        expect(callSessionRpc).toHaveBeenCalled();
        composedPhase = 'complete';
        // Four real archive builds and immutable admissions exceeded 60 seconds
        // (73.5s observed); keep a bounded allowance for CI variance.
    }, 180_000);
});
