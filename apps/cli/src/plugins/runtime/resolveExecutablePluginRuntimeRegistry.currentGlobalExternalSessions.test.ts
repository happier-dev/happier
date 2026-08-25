import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
    accountSettingsParse,
    type AccountProfileResponse,
} from '@happier-dev/protocol';
import * as activeAccountSettingsSnapshot from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { readPluginManifest } from '@/plugins/manifest/read';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import type { ExternalSessionFollowHostOperation } from '@/session/external/followHostOperation';
import {
    resetActiveAccountSettingsSnapshotForTests,
    resolveActiveAccountSettingsSnapshotRevision,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { createPluginReloadController } from './reload/controller';

const PLUGIN_ID = 'acme.current-global-external-sessions';
const AGENT_ID = 'current-global-agent';
const BACKGROUND_SERVICE_ID = 'current-global-background';
/** Installed Agents are routed by their qualified `{pluginId, localId}` identity. */
const ROUTING_AGENT_ID = `${PLUGIN_ID}/${AGENT_ID}`;
const SESSION_ID = 'current-global-session';
const SOURCE_KIND = 'currentGlobalFixture';

const configuredExternalSessionSourceRevisions = activeAccountSettingsSnapshot as typeof activeAccountSettingsSnapshot & Readonly<{
    notifyActiveAccountConnectedServicesProjection(scopeKey: string): void;
}>;

function accountProfile(
    connectedServicesV2: AccountProfileResponse['connectedServicesV2'] = [],
): AccountProfileResponse {
    return {
        id: 'current-global-account',
        timestamp: 0,
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        linkedProviders: [],
        connectedServices: [],
        connectedServicesV2,
        connectedServiceCredentialRevisionsV1: [],
        connectedAccountsV4: [],
        connectedAccountGroupsV4: [],
    };
}

const boundaries = vi.hoisted(() => ({
    ensureExternalSessionLink: vi.fn(async () => ({
        sessionId: 'linked-current-global-session',
    })),
    fetchAccountProfile: vi.fn(async (): Promise<AccountProfileResponse> => accountProfile()),
    readStoredCredentials: vi.fn(async () => ({
        token: 'current-global-token',
        encryption: null,
    })),
}));

vi.mock('@/api/session/external/linking/ensureExternalSessionLink', () => ({
    ensureExternalSessionLink: boundaries.ensureExternalSessionLink,
}));

vi.mock('@/api/accountProfile', () => ({
    fetchAccountProfile: boundaries.fetchAccountProfile,
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: boundaries.readStoredCredentials,
}));

async function writeExternalSessionsPlugin(input: Readonly<{
    pluginRoot: string;
    version: 'H' | 'I';
    runtime?: 'custom' | 'declarativeAcp';
    activation?: 'startup' | 'onDemand';
    sessionsHostAccess?: 'required' | 'omitted';
    refuseConnectedServiceSources?: boolean;
    backgroundProbeOutputPath?: string;
}>): Promise<void> {
    const runtime = input.runtime ?? 'custom';
    const activation = input.activation ?? 'startup';
    const sessionsHostAccess = input.sessionsHostAccess ?? 'required';
    await mkdir(join(input.pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
        join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify({
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: input.version === 'H' ? '1.0.0' : '2.0.0',
            displayName: `Current global external sessions ${input.version}`,
            engines: { happier: '^0.2.0' },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: './daemon.mjs' },
            activation: {
                events: activation === 'startup' ? [{ kind: 'startup' }] : [],
            },
            hostAccess: {
                required: sessionsHostAccess === 'required'
                    ? [{
                        id: 'current-global-sessions',
                        capability: 'sessions',
                        reason: 'Use the public External Sessions projection.',
                        scope: { access: ['read', 'control'] },
                    }]
                    : [],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: AGENT_ID,
                    title: `Current global Agent ${input.version}`,
                    runtime: runtime === 'custom'
                        ? { kind: 'custom' }
                        : {
                            kind: 'acp',
                            transport: {
                                kind: 'tcp',
                                host: '127.0.0.1',
                                port: 4242,
                            },
                        },
                    primary: 'sessions',
                    capabilities: {
                        surfaces: ['externalSessions'],
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                    surfaces: {
                        externalSession: {
                            externalLinkedTakeover: {
                                writerSafety: 'unsupported',
                            },
                            sources: [{
                                sourceKind: SOURCE_KIND,
                                terminalFollow: {
                                    userRowClassification: 'explicitV1',
                                },
                                schema: {
                                    fields: [
                                        {
                                            kind: 'literal',
                                            name: 'kind',
                                            value: SOURCE_KIND,
                                        },
                                        {
                                            kind: 'enum',
                                            name: 'home',
                                            values: ['user', 'connectedService'],
                                        },
                                        {
                                            kind: 'string',
                                            name: 'connectedServiceId',
                                            optional: true,
                                        },
                                        {
                                            kind: 'string',
                                            name: 'connectedServiceProfileId',
                                            optional: true,
                                        },
                                        {
                                            kind: 'string',
                                            name: 'connectedServiceGroupId',
                                            optional: true,
                                        },
                                        {
                                            kind: 'string',
                                            name: 'homePath',
                                            optional: true,
                                        },
                                    ],
                                },
                                key: {
                                    segments: [
                                        {
                                            kind: 'literal',
                                            value: SOURCE_KIND,
                                        },
                                        {
                                            kind: 'homeMode',
                                            field: 'home',
                                        },
                                        {
                                            kind: 'conditionalField',
                                            field: 'connectedServiceId',
                                            when: {
                                                field: 'home',
                                                equals: 'connectedService',
                                            },
                                        },
                                        {
                                            kind: 'connectedServiceScope',
                                            groupField: 'connectedServiceGroupId',
                                            profileField: 'connectedServiceProfileId',
                                            when: {
                                                field: 'home',
                                                equals: 'connectedService',
                                            },
                                        },
                                        {
                                            kind: 'field',
                                            field: 'homePath',
                                        },
                                    ],
                                },
                                instances: [
                                    {
                                        kind: 'default',
                                        constants: { home: 'user' },
                                    },
                                    {
                                        kind: 'connectedServiceProfiles',
                                        serviceId: 'openai-codex',
                                        constants: { home: 'connectedService' },
                                        fields: {
                                            serviceId: 'connectedServiceId',
                                            profileId: 'connectedServiceProfileId',
                                        },
                                    },
                                ],
                            }],
                        },
                    },
                }],
                backgroundServices: input.backgroundProbeOutputPath
                    ? [{
                        id: BACKGROUND_SERVICE_ID,
                        title: 'Current global External Sessions probe',
                    }]
                    : [],
            },
        }),
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'agentRuntime.mjs'),
        `const version = ${JSON.stringify(input.version)};

export const runtimeFactory = () => ({
    sessions: {
        async open(request) {
            return {
                sessionId: request.sessionId,
                async send() { return { status: 'admitted' }; },
                watch() { return { dispose() {} }; },
                async dispose() {},
            };
        },
    },
    async dispose() {},
});

export const externalSessions = Object.freeze({
    async resolveSource(request) {
        if (
            ${input.refuseConnectedServiceSources === true}
            && request.source.home === 'connectedService'
        ) {
            return {
                ok: false,
                code: 'source_invalid',
                message: 'The configured connected-service source was refused.',
                retryable: false,
            };
        }
        return { ok: true, value: { source: request.source } };
    },
    async listCandidates(request) {
        return {
            ok: true,
            value: {
                candidates: [{
                    remoteSessionId: request.cursor
                        ? 'current-' + version + '-page-2'
                        : 'current-' + version,
                    title: request.cursor
                        ? 'Current ' + version + ' page 2'
                        : 'Current ' + version,
                    updatedAtMs: version === 'H' ? 2 : 3,
                    linkData: { ownerVersion: version },
                }],
                nextCursor: request.cursor
                    ? null
                    : 'native-' + version + '-page-2',
            },
        };
    },
    async resolveLinkIdentity(request) {
        return {
            ok: true,
            value: {
                source: request.source,
                remoteSessionId: request.remoteSessionId,
                linkData: { ...(request.linkData ?? {}), ownerVersion: version },
            },
        };
    },
    async resolveLinkedIdentity(request) {
        return {
            ok: true,
            value: {
                source: request.source,
                remoteSessionId: request.remoteSessionId,
                linkData: { ...request.linkData, ownerVersion: version },
            },
        };
    },
    async pageTranscript() {
        return {
            ok: true,
            value: {
                items: [],
                nextCursor: null,
                tailCursor: null,
                hasMore: false,
                truncated: false,
            },
        };
    },
    async readAfterTranscript() {
        return { ok: true, value: { outcome: 'already_current' } };
    },
});
`,
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'daemon.mjs'),
        `import { writeFile } from 'node:fs/promises';
import { externalSessions${runtime === 'custom' ? ', runtimeFactory' : ''} } from './agentRuntime.mjs';

export function activate(api) {
${runtime === 'custom' ? `    api.agents.register(${JSON.stringify(AGENT_ID)}, runtimeFactory, {
        sessionRunnerFactory: {
            module: './agentRuntime.mjs',
            export: 'runtimeFactory',
            externalSessionsExport: 'externalSessions',
            runtimeApiVersion: 1,
        },
    });
` : ''}    api.agents.registerExternalSessions(
        ${JSON.stringify(AGENT_ID)},
        externalSessions,
    );
${input.backgroundProbeOutputPath ? `    api.backgroundServices.register(
        ${JSON.stringify(BACKGROUND_SERVICE_ID)},
        async (context) => {
            let result;
            try {
                const page = await context.services.sessions.external.list({
                    agentId: ${JSON.stringify(ROUTING_AGENT_ID)},
                    limit: 1,
                });
                result = {
                    status: 'available',
                    remoteSessionId: page.items[0]?.ref.remoteSessionId ?? null,
                };
            } catch (error) {
                result = {
                    status: 'unavailable',
                    code: error && typeof error === 'object' && 'code' in error
                        ? error.code
                        : null,
                };
            }
            await writeFile(
                ${JSON.stringify(input.backgroundProbeOutputPath)},
                JSON.stringify(result),
                'utf8',
            );
        },
    );
` : ''}}
}
`,
        'utf8',
    );
}

async function resolveCurrentnessInputs(input: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
}>) {
    const generationAuthority = await readCurrentCommittedPluginGenerations(
        resolvePluginStorePaths({ happyHomeDir: input.happyHomeDir }),
        { bundledArtifacts: [], isolateInvalidInstalledGenerations: false },
    );
    const admitted = generationAuthority?.generations.get(PLUGIN_ID);
    if (!generationAuthority || !admitted) {
        throw new Error('Expected the current immutable External Sessions generation');
    }
    const manifestPath = join(
        admitted.rootPath,
        ...admitted.record.manifestRelativePath.split('/'),
    );
    const immutableManifest = await readPluginManifest({ sourceProvenance: 'registryCustodied',
        manifestPath,
        manifestAuthority: 'external',
        enforceEngineCompatibility: true,
    });
    if (!immutableManifest.ok) {
        throw new Error(immutableManifest.diagnostics.map(
            (diagnostic) => diagnostic.message,
        ).join('\n'));
    }
    const agentDefinition = immutableManifest.manifest.contributes.agents
        .find((candidate) => candidate.id === AGENT_ID);
    if (!agentDefinition) {
        throw new Error('Expected the immutable External Sessions Agent declaration');
    }
    const sourceSpec = {
        kind: 'path' as const,
        locator: input.pluginRoot,
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedVersion: immutableManifest.manifest.version,
    };
    const daemonEntryPath = join(admitted.rootPath, 'daemon.mjs');
    const agent = projectManifestAgentContribution({
        definition: agentDefinition,
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: PLUGIN_ID,
        sourceSpec,
        hostAccess: immutableManifest.manifest.hostAccess,
        manifestPath,
        daemonEntryPath,
    });
    return Object.freeze({
        generationAuthority,
        contributes: createResolvedContributionRegistry({
            agents: [agent],
            activationTargets: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: PLUGIN_ID,
                manifestPath,
                daemonEntryPath,
                sourceSpec,
                activationEvents: ['startup'],
                manifest: immutableManifest.manifest,
            }],
        }),
    });
}

describe('current global External Sessions publication', () => {
    it('retires current-H configured sources on a Connected Services projection while Settings revision stays constant', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const currentAccountSnapshot = {
            source: 'network' as const,
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'current-global-account',
        };
        setActiveAccountSettingsSnapshot(currentAccountSnapshot);
        const settingsRevisionBefore = resolveActiveAccountSettingsSnapshotRevision(
            currentAccountSnapshot,
        );
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-plugin-'));
        const iHappyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-i-home-'));
        const iPluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-i-plugin-'));
        const hostOperationOwner = createExternalSessionHostOperationOwner();
        const followSubscriptionDispose = vi.fn(async () => {});
        const followOperation: ExternalSessionFollowHostOperation = Object.freeze({
            async execute() {
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: 'current-global-follow-cursor',
                    subscription: Object.freeze({
                        async dispose() {
                            await followSubscriptionDispose();
                        },
                    }),
                });
            },
        });
        const followInstallation = await hostOperationOwner.install({
            followOperation,
        });
        let hRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let iRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        try {
            await writeExternalSessionsPlugin({ pluginRoot, version: 'H' });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });
            const hInputs = await resolveCurrentnessInputs({
                happyHomeDir,
                pluginRoot,
            });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => hRegistry!,
            });
            hRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: hInputs.contributes,
                generation: 1,
                generationAuthority: hInputs.generationAuthority,
                externalSessionHostOperationOwner: hostOperationOwner,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
                resolveExternalSessionCurrentMachineId: () => 'machine-current-global',
            });
            await hRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            const initialLease = await reloadController.acquireRuntimeRegistry();
            await initialLease.release();
            const createCurrent =
                hRegistry.createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
            if (!createCurrent) {
                throw new Error('Expected the public current External Sessions factory');
            }
            const binding = hRegistry.agentRuntimesByAgentId
                .get(ROUTING_AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!binding) {
                throw new Error('Expected the active External Sessions Agent binding');
            }
            const current = await createCurrent({
                binding,
                sessionId: SESSION_ID,
                correlationId: 'current-global-owner-preservation',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            const firstPage = await current.list({
                agentId: ROUTING_AGENT_ID,
                limit: 1,
            });
            const firstRef = firstPage.items[0]?.ref;
            if (!firstRef || !firstPage.nextCursor) {
                throw new Error('Expected the first current H page and opaque cursor');
            }
            expect(firstPage.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
            await expect(current.list({
                agentId: ROUTING_AGENT_ID,
                cursor: firstPage.nextCursor,
                limit: 1,
            })).resolves.toMatchObject({
                items: [expect.objectContaining({
                    ref: expect.objectContaining({
                        remoteSessionId: 'current-H-page-2',
                    }),
                })],
                nextCursor: null,
            });
            const accountAContinuationPage = await current.list({
                agentId: ROUTING_AGENT_ID,
                limit: 1,
            });
            if (!accountAContinuationPage.nextCursor) {
                throw new Error('Expected an Account A opaque continuation');
            }
            await expect(current.followTranscript(
                firstRef,
                {},
                async () => {},
            )).resolves.toMatchObject({
                status: 'following',
                startingCursor: 'current-global-follow-cursor',
            });
            await expect(current.capabilities()).resolves.toMatchObject({
                follow: { status: 'available' },
            });
            expect(followSubscriptionDispose).not.toHaveBeenCalled();

            boundaries.fetchAccountProfile.mockClear();
            configuredExternalSessionSourceRevisions
                .notifyActiveAccountConnectedServicesProjection('current-global-account');
            expect(resolveActiveAccountSettingsSnapshotRevision(
                currentAccountSnapshot,
            )).toBe(settingsRevisionBefore);
            await vi.waitFor(() => expect(
                followSubscriptionDispose,
            ).toHaveBeenCalledOnce());
            await vi.waitFor(async () => {
                await expect(current.capabilities()).resolves.toMatchObject({
                    follow: { status: 'available' },
                });
            });
            expect(boundaries.fetchAccountProfile).toHaveBeenCalledOnce();
            await expect(current.list({
                agentId: ROUTING_AGENT_ID,
                cursor: accountAContinuationPage.nextCursor,
                limit: 1,
            })).rejects.toMatchObject({
                code: 'plugin_external_list_query_invalid',
            });
            const accountBPage = await current.list({
                agentId: ROUTING_AGENT_ID,
                sourceId: firstRef.sourceId,
                limit: 1,
            });
            const accountBRef = accountBPage.items[0]?.ref;
            if (!accountBRef) {
                throw new Error('Expected the rebuilt Account B current ref');
            }
            expect(accountBPage.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
            expect(accountBPage.nextCursor).not.toBe(firstPage.nextCursor);
            await expect(current.followTranscript(
                accountBRef,
                {},
                async () => {},
            )).resolves.toMatchObject({
                status: 'following',
                startingCursor: 'current-global-follow-cursor',
            });

            await writeExternalSessionsPlugin({ pluginRoot: iPluginRoot, version: 'I' });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir: iHappyHomeDir,
                pluginRoot: iPluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '2.0.0',
            });
            const iInputs = await resolveCurrentnessInputs({
                happyHomeDir: iHappyHomeDir,
                pluginRoot: iPluginRoot,
            });
            iRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: iHappyHomeDir,
                contributes: iInputs.contributes,
                generation: 2,
                generationAuthority: iInputs.generationAuthority,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
            });
            await reloadController.adoptPreparedRuntimeRegistry({
                registry: iRegistry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 2,
                runningSessionDisposition: 'retainRunningSessions',
            });
            expect(hRegistry.retirementSignal?.aborted).toBe(true);
            await vi.waitFor(() => expect(
                followSubscriptionDispose,
            ).toHaveBeenCalledTimes(2));
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
            await reloadController?.shutdown();
            if (!reloadController) {
                await Promise.all([
                    hRegistry?.dispose(),
                    iRegistry?.dispose(),
                ]);
            }
            await followInstallation.dispose();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
                rm(iHappyHomeDir, { recursive: true, force: true }),
                rm(iPluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 120_000);

    it('routes a retained runner created without predecessor Sessions access through current I', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-pair-h-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-pair-h-plugin-'));
        const iHappyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-pair-i-home-'));
        const iPluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-pair-i-plugin-'));
        let hRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let iRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        try {
            await writeExternalSessionsPlugin({
                pluginRoot,
                version: 'H',
                // A retained runner can outlive a predecessor whose public
                // Sessions capability was not selected. Its public service
                // must become usable when current I grants that capability;
                // an H-time `services.sessions` binding would stay false-empty.
                sessionsHostAccess: 'omitted',
            });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });
            const hInputs = await resolveCurrentnessInputs({ happyHomeDir, pluginRoot });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => hRegistry!,
            });
            // The daemon builds every registry with the controller-lifetime
            // router so a long-lived plugin context follows publication.
            hRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: hInputs.contributes,
                generation: 1,
                generationAuthority: hInputs.generationAuthority,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
                resolveExternalSessionCurrentMachineId: () => 'machine-current-global',
            });
            await hRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            const hLease = await reloadController.acquireRuntimeRegistry();
            const createCurrentH = hLease.registry
                .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
            const hBinding = hLease.registry.agentRuntimesByAgentId
                .get(ROUTING_AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!createCurrentH || !hBinding) {
                throw new Error('Expected the leased H External Sessions binding');
            }
            const hService = await createCurrentH({
                binding: hBinding,
                sessionId: SESSION_ID,
                correlationId: 'current-global-pair-h',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await writeExternalSessionsPlugin({ pluginRoot: iPluginRoot, version: 'I' });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir: iHappyHomeDir,
                pluginRoot: iPluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '2.0.0',
            });
            const iInputs = await resolveCurrentnessInputs({
                happyHomeDir: iHappyHomeDir,
                pluginRoot: iPluginRoot,
            });
            iRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir: iHappyHomeDir,
                contributes: iInputs.contributes,
                generation: 2,
                generationAuthority: iInputs.generationAuthority,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
                resolveExternalSessionCurrentMachineId: () => 'machine-current-global',
            });
            await iRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            await reloadController.adoptPreparedRuntimeRegistry({
                registry: iRegistry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 2,
                runningSessionDisposition: 'retainRunningSessions',
            });

            // The retained H runner keeps its exact generation only for private
            // execution custody. Its public SDK service resolves the published
            // global owner for every call, so replacement must be visible here.
            await expect(hService.list({
                agentId: ROUTING_AGENT_ID,
                limit: 1,
            })).resolves.toMatchObject({
                items: [expect.objectContaining({
                    ref: expect.objectContaining({ remoteSessionId: 'current-I' }),
                })],
            });
            await hLease.release();

            // The positive twin: the same public route resolved from the newly
            // leased current registry does reach I's owner.
            const iLease = await reloadController.acquireRuntimeRegistry();
            const createCurrentI = iLease.registry
                .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
            const iBinding = iLease.registry.agentRuntimesByAgentId
                .get(ROUTING_AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!createCurrentI || !iBinding) {
                throw new Error('Expected the leased I External Sessions binding');
            }
            const iService = await createCurrentI({
                binding: iBinding,
                sessionId: SESSION_ID,
                correlationId: 'current-global-pair-i',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(iService.list({
                agentId: ROUTING_AGENT_ID,
                limit: 1,
            })).resolves.toMatchObject({
                items: [expect.objectContaining({
                    ref: expect.objectContaining({ remoteSessionId: 'current-I' }),
                })],
            });
            await iLease.release();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
            await reloadController?.shutdown();
            if (!reloadController) {
                await Promise.all([hRegistry?.dispose(), iRegistry?.dispose()]);
            }
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
                rm(iHappyHomeDir, { recursive: true, force: true }),
                rm(iPluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 120_000);

    it('routes a background service through current H Sessions HostAccess', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-background-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-background-plugin-'));
        const backgroundProbeOutputPath = join(pluginRoot, 'background-probe.json');
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        try {
            await writeExternalSessionsPlugin({
                pluginRoot,
                version: 'H',
                backgroundProbeOutputPath,
            });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });
            const inputs = await resolveCurrentnessInputs({ happyHomeDir, pluginRoot });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => registry!,
            });
            registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: inputs.contributes,
                generation: 1,
                generationAuthority: inputs.generationAuthority,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
                resolveExternalSessionCurrentMachineId: () => 'machine-current-global',
            });
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            await reloadController.adoptPreparedRuntimeRegistry({
                registry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });

            await vi.waitFor(async () => {
                await expect(readFile(backgroundProbeOutputPath, 'utf8')).resolves
                    .toBe(JSON.stringify({
                        status: 'available',
                        remoteSessionId: 'current-H',
                    }));
            });

            // The same generic binding still preserves the retained Agent
            // caller route; its contribution identity remains Agent-qualified.
            const createCurrent = registry
                .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
            const binding = registry.agentRuntimesByAgentId
                .get(ROUTING_AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!createCurrent || !binding) {
                throw new Error('Expected the active External Sessions Agent binding');
            }
            const agentService = await createCurrent({
                binding,
                sessionId: SESSION_ID,
                correlationId: 'current-global-background-agent',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            await expect(agentService.list({
                agentId: ROUTING_AGENT_ID,
                limit: 1,
            })).resolves.toMatchObject({
                items: [expect.objectContaining({
                    ref: expect.objectContaining({ remoteSessionId: 'current-H' }),
                })],
            });
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
            await reloadController?.shutdown();
            if (!reloadController) await registry?.dispose();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 120_000);

    it('keeps a background service without current Sessions HostAccess unavailable', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-background-denied-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-background-denied-plugin-'));
        const backgroundProbeOutputPath = join(pluginRoot, 'background-probe.json');
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        try {
            await writeExternalSessionsPlugin({
                pluginRoot,
                version: 'H',
                sessionsHostAccess: 'omitted',
                backgroundProbeOutputPath,
            });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });
            const inputs = await resolveCurrentnessInputs({ happyHomeDir, pluginRoot });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => registry!,
            });
            registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: inputs.contributes,
                generation: 1,
                generationAuthority: inputs.generationAuthority,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
                resolveExternalSessionCurrentMachineId: () => 'machine-current-global',
            });
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            await reloadController.adoptPreparedRuntimeRegistry({
                registry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });

            await vi.waitFor(async () => {
                await expect(readFile(backgroundProbeOutputPath, 'utf8')).resolves
                    .toBe(JSON.stringify({
                        status: 'unavailable',
                        code: 'plugin_services_current_global_unavailable',
                    }));
            });
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
            await reloadController?.shutdown();
            if (!reloadController) await registry?.dispose();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 120_000);

    it('refreshes source-refusal diagnostics after admitted Account revisions', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-refusals-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-refusals-plugin-'));
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        let connectedProfilePresent = false;
        boundaries.fetchAccountProfile.mockClear();
        boundaries.fetchAccountProfile.mockImplementation(async (): Promise<AccountProfileResponse> => accountProfile(
            connectedProfilePresent
                ? [{
                    serviceId: 'openai-codex',
                    profiles: [{
                        profileId: 'refused-profile',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: null,
                        providerAccountId: null,
                        expiresAt: null,
                        lastUsedAt: null,
                        health: null,
                    }],
                    groups: [],
                }]
                : [],
        ));
        const publishAccountRevision = (settingsVersion: number): void => {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion,
                loadedAtMs: settingsVersion,
                settingsSecretsReadKeys: [],
                scopeKey: 'current-global-source-refusals',
            });
        };
        const hasCurrentRefusal = (): boolean => (
            registry?.pluginDiagnosticsByPluginId[PLUGIN_ID]
                ?.some((diagnostic) => (
                    diagnostic.code === 'plugin_external_session_source_refused'
                )) === true
        );
        try {
            publishAccountRevision(1);
            await writeExternalSessionsPlugin({
                pluginRoot,
                version: 'H',
                refuseConnectedServiceSources: true,
            });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });
            const inputs = await resolveCurrentnessInputs({ happyHomeDir, pluginRoot });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => registry!,
            });
            registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: inputs.contributes,
                generation: 1,
                generationAuthority: inputs.generationAuthority,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
            });
            await reloadController.adoptPreparedRuntimeRegistry({
                registry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);

            expect(hasCurrentRefusal()).toBe(false);

            connectedProfilePresent = true;
            publishAccountRevision(2);
            await vi.waitFor(() => expect(hasCurrentRefusal()).toBe(true));

            connectedProfilePresent = false;
            publishAccountRevision(3);
            await vi.waitFor(() => expect(hasCurrentRefusal()).toBe(false));
        } finally {
            connectedProfilePresent = false;
            resetActiveAccountSettingsSnapshotForTests();
            await reloadController?.shutdown();
            if (!reloadController) await registry?.dispose();
            boundaries.fetchAccountProfile.mockImplementation(async (): Promise<AccountProfileResponse> => accountProfile());
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 120_000);

    it('publishes one current-H owner for concurrent cold public demands', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-current-global-cold-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-current-global-cold-plugin-'));
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        let reloadController: ReturnType<typeof createPluginReloadController> | null = null;
        let releaseFirstAccount!: () => void;
        let releaseSecondAccount!: () => void;
        const firstAccount = new Promise<void>((resolve) => {
            releaseFirstAccount = resolve;
        });
        const secondAccount = new Promise<void>((resolve) => {
            releaseSecondAccount = resolve;
        });
        boundaries.fetchAccountProfile.mockClear();
        boundaries.fetchAccountProfile
            .mockImplementationOnce(async () => {
                await firstAccount;
                return accountProfile();
            })
            .mockImplementationOnce(async () => {
                await secondAccount;
                return accountProfile();
            });
        try {
            await writeExternalSessionsPlugin({
                pluginRoot,
                version: 'H',
                runtime: 'declarativeAcp',
                activation: 'onDemand',
            });
            await seedCurrentLocalPathPluginFixture({
                happyHomeDir,
                pluginRoot,
                pluginId: PLUGIN_ID,
                manifestVersion: '1.0.0',
            });
            const inputs = await resolveCurrentnessInputs({
                happyHomeDir,
                pluginRoot,
            });
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => registry!,
            });
            registry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                contributes: inputs.contributes,
                generation: 1,
                generationAuthority: inputs.generationAuthority,
                pluginIds: [],
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
            });
            await reloadController.adoptPreparedRuntimeRegistry({
                registry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });
            expect(registry.activatedPluginIds.has(PLUGIN_ID)).toBe(false);
            const createCurrent =
                registry.createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
            const binding = registry.agentRuntimesByAgentId
                .get(ROUTING_AGENT_ID)
                ?.sessionRunnerFactoryBinding;
            if (!createCurrent || !binding) {
                throw new Error('Expected the cold public External Sessions binding');
            }
            const [firstCurrent, secondCurrent] = await Promise.all([
                createCurrent({
                    binding,
                    sessionId: `${SESSION_ID}-cold-first`,
                    correlationId: 'current-global-cold-first',
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                }),
                createCurrent({
                    binding,
                    sessionId: `${SESSION_ID}-cold-second`,
                    correlationId: 'current-global-cold-second',
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                }),
            ]);

            const firstDemand = firstCurrent.list({ agentId: ROUTING_AGENT_ID, limit: 1 });
            await vi.waitFor(() => expect(
                boundaries.fetchAccountProfile,
            ).toHaveBeenCalledTimes(1));
            const secondDemand = secondCurrent.list({ agentId: ROUTING_AGENT_ID, limit: 1 });
            // Both public callers have completed the same lazy activation,
            // while the first owner is still held at its account boundary.
            await new Promise<void>((resolve) => setImmediate(resolve));
            releaseFirstAccount();
            const firstPage = await firstDemand;
            releaseSecondAccount();
            const secondPage = await secondDemand;

            expect(registry.activatedPluginIds.has(PLUGIN_ID)).toBe(true);
            expect(boundaries.fetchAccountProfile).toHaveBeenCalledTimes(1);
            const firstCursor = firstPage.nextCursor;
            if (!firstCursor) {
                throw new Error('Expected the first cold public demand to return a cursor');
            }
            expect(secondPage.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
            await expect(secondCurrent.list({
                agentId: ROUTING_AGENT_ID,
                cursor: firstCursor,
                limit: 1,
            })).resolves.toMatchObject({
                items: [expect.objectContaining({
                    ref: expect.objectContaining({
                        remoteSessionId: 'current-H-page-2',
                    }),
                })],
                nextCursor: null,
            });
        } finally {
            releaseFirstAccount();
            releaseSecondAccount();
            resetActiveAccountSettingsSnapshotForTests();
            await reloadController?.shutdown();
            if (!reloadController) await registry?.dispose();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 120_000);
});
