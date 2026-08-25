import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from '@happier-dev/plugins-claude/agent';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';
import { configuration } from '@/configuration';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createDeferred } from '@/testkit/async/deferred';
import { logger } from '@/ui/logger';
import { resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';
import { ConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { bootstrapMachineSyncRuntime } from '@/daemon/machine/bootstrapMachineSyncRuntime';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { ApiMachineClient } from './apiMachine';

const { claudeProvenanceReplaceCount } = vi.hoisted(() => ({
    claudeProvenanceReplaceCount: { current: 0 },
}));
const {
    mockIo,
    axiosGet,
    axiosIsAxiosError,
        readAccountChangesCursor,
        retirePluginAccountCollectionWatchScope,
        writeAccountChangesCursor,
        publishPluginAccountCollectionWatchInvalidation,
        publishPluginAccountSettingsWatchInvalidation,
} = vi.hoisted(() => {
    return {
        mockIo: vi.fn(),
        axiosGet: vi.fn(),
        axiosIsAxiosError: vi.fn((error: unknown) => (
            typeof error === 'object' && error !== null && (error as { isAxiosError?: unknown }).isAxiosError === true
        )),
        readAccountChangesCursor: vi.fn(async () => 0),
        retirePluginAccountCollectionWatchScope: vi.fn(),
        writeAccountChangesCursor: vi.fn(async () => {}),
        publishPluginAccountCollectionWatchInvalidation: vi.fn(),
        publishPluginAccountSettingsWatchInvalidation: vi.fn(),
    };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        rename: async (
            oldPath: Parameters<typeof actual.rename>[0],
            newPath: Parameters<typeof actual.rename>[1],
        ) => {
            if (String(newPath).endsWith('.happier-claude-connected-service-home.json')) {
                claudeProvenanceReplaceCount.current += 1;
            }
            await actual.rename(oldPath, newPath);
        },
    };
});

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('axios', () => ({
    default: {
        get: axiosGet,
        isAxiosError: axiosIsAxiosError,
    },
    isAxiosError: axiosIsAxiosError,
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readAccountChangesCursor,
    writeAccountChangesCursor,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

vi.mock('@/plugins/runtime/context/pluginAccountSettingsChangeBroker', () => ({
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountSettingsWatchInvalidation,
    retirePluginAccountCollectionWatchScope,
    readPluginAccountCollectionWatchInvalidations: (changes: readonly unknown[]) => changes.flatMap((change) => {
        if (!change || typeof change !== 'object') return [];
        const entry = change as { cursor?: unknown; kind?: unknown; hint?: unknown };
        if (entry.kind !== 'pluginDomain' || !entry.hint || typeof entry.hint !== 'object') return [];
        const hint = entry.hint as {
            pluginDomain?: unknown;
            pluginId?: unknown;
            collectionId?: unknown;
            contractDigest?: unknown;
        };
        return hint.pluginDomain === 'dataCollection'
            && typeof entry.cursor === 'number'
            && typeof hint.pluginId === 'string'
            && typeof hint.collectionId === 'string'
            && typeof hint.contractDigest === 'string'
            ? [{
                kind: 'collection' as const,
                pluginId: hint.pluginId,
                collectionId: hint.collectionId,
                contractDigest: hint.contractDigest,
                changeCursor: entry.cursor,
            }]
            : [];
    }),
    readPluginAccountSettingsWatchInvalidations: (changes: readonly unknown[]) => changes.flatMap((change) => {
        if (!change || typeof change !== 'object') return [];
        const entry = change as { kind?: unknown; hint?: unknown };
        if (entry.kind !== 'pluginDomain' || !entry.hint || typeof entry.hint !== 'object') return [];
        const hint = entry.hint as { pluginDomain?: unknown; pluginId?: unknown; revision?: unknown };
        return hint.pluginDomain === 'settings'
            && typeof hint.pluginId === 'string'
            && typeof hint.revision === 'number'
            ? [{ kind: 'record' as const, pluginId: hint.pluginId, revision: hint.revision }]
            : [];
    }),
}));

function createMachineSocket(options: {
    emitWithAck?: (event: string, payload: unknown) => Promise<unknown> | unknown;
} = {}) {
    return createApiSessionSocketStub({
        emitWithAck: async (event, payload) => {
            if (options.emitWithAck) {
                return await options.emitWithAck(event, payload);
            }

            if (event === 'machine-update-state' && payload && typeof payload === 'object') {
                return {
                    result: 'success',
                    version: 1,
                    daemonState: (payload as { daemonState?: unknown }).daemonState,
                };
            }

            if (event === 'machine-update-metadata' && payload && typeof payload === 'object') {
                return {
                    result: 'success',
                    version: 1,
                    metadata: (payload as { metadata?: unknown }).metadata,
                };
            }

            return { result: 'success', version: 1 };
        },
    });
}

describe('ApiMachineClient /v2/changes reconnect', () => {
    it('resolves an exact Session Resource admission without acknowledging the returned Account cursor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string, options?: Readonly<{ params?: unknown }>) => {
            if (url.endsWith('/v1/account/profile')) {
                return { status: 200, data: { id: 'account-1' } };
            }
            expect(options?.params).toEqual({
                after: 0,
                limit: 1,
                sessionAccessSessionId: 'session-1',
            });
            return {
                status: 200,
                data: {
                    changes: [],
                    nextCursor: 44,
                    sessionAccessProbe: {
                        v: 1,
                        sessionId: 'session-1',
                        throughCursor: 44,
                        status: 'available',
                    },
                },
            };
        });
        const client = new ApiMachineClient('token', machine);

        await expect(client.resolvePluginResourceSessionAccess({
            accountId: 'account-1',
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })).resolves.toEqual({
            accountId: 'account-1',
            throughCursor: 44,
            status: 'available',
        });
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('fails only the exact Session Resource admission closed when an older server omits the probe', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => (
            url.endsWith('/v1/account/profile')
                ? { status: 200, data: { id: 'account-1' } }
                : { status: 200, data: { changes: [], nextCursor: 0 } }
        ));
        const client = new ApiMachineClient('token', machine);

        await expect(client.resolvePluginResourceSessionAccess({
            accountId: 'account-1',
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })).rejects.toThrow('plugin_resource_session_access_unavailable');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('connect uses an http(s) base URL and explicitly connects the socket', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);

        const client = new ApiMachineClient('token', machine);
        client.connect();

        expect(mockIo).toHaveBeenCalled();
        const url = ((mockIo as any).mock?.calls as any[] | undefined)?.[0]?.[0];
        expect(typeof url).toBe('string');
        expect(String(url).startsWith('http')).toBe(true);
        expect(socket.connect).toHaveBeenCalled();
    });

    it('connect does not crash if the socket lacks connect() and uses open() as a fallback', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socketNoConnect = {
            ...createMachineSocket(),
            connect: undefined,
            open: vi.fn(),
        } as any;
        bindApiSessionSocketMock(mockIo, socketNoConnect);

        const client = new ApiMachineClient('token', machine);
        client.connect();

        expect(socketNoConnect.open).toHaveBeenCalled();
    });

    it('refreshes machine snapshot when /v2/changes includes a machine change', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const encryptedMetadata = encodeBase64(
            encrypt(machine.encryptionKey, machine.encryptionVariant, {
                host: 'h',
                platform: 'p',
                happyCliVersion: 'v',
                homeDir: '/home',
                happyHomeDir: '/happy',
                happyLibDir: '/lib',
            }),
        );

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: { changes: [{ cursor: 1, kind: 'machine', entityId: 'machine-1', changedAt: 1, hint: null }], nextCursor: 1 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-1',
                            metadata: encryptedMetadata,
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.connect();

        // First connect
        socket.trigger('connect');

        // Disconnect + reconnect
        socket.trigger('disconnect');
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(machine.metadataVersion).toBe(2);
        });

        expect(machine.metadata).toEqual(
            expect.objectContaining({
                host: 'h',
                platform: 'p',
            }),
        );
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
    });

    it('reports account settings version hints from /v2/changes to the refresh callback', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                            { cursor: 2, kind: 'account', entityId: 'self', changedAt: 2, hint: { settingsVersion: 3 } },
                        ],
                        nextCursor: 2,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 2);
    });

    it('wakes only the matching Account plugin Settings record watcher from the closed settings change arm', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            {
                                cursor: 6,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/settings',
                                changedAt: 6,
                                hint: {
                                    pluginDomain: 'settings',
                                    pluginId: 'example.tasks',
                                    scope: 'account',
                                    revision: 11,
                                },
                            },
                            {
                                cursor: 7,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/data-kv',
                                changedAt: 7,
                                hint: {
                                    pluginDomain: 'dataKv',
                                    pluginId: 'example.tasks',
                                    full: true,
                                },
                            },
                            {
                                cursor: 8,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                                changedAt: 8,
                                hint: {
                                    pluginDomain: 'dataCollection',
                                    pluginId: 'example.tasks',
                                    collectionId: 'tasks',
                                    contractDigest: 'a'.repeat(43),
                                    revision: 4,
                                    full: true,
                                },
                            },
                        ],
                        nextCursor: 8,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        publishPluginAccountCollectionWatchInvalidation.mockClear();
        publishPluginAccountSettingsWatchInvalidation.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledTimes(1);
        expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledWith({
            kind: 'record',
            pluginId: 'example.tasks',
            revision: 11,
        });
        expect(publishPluginAccountCollectionWatchInvalidation).toHaveBeenCalledWith({
            accountScopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            kind: 'collection',
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'a'.repeat(43),
            changeCursor: 8,
        });
    });

    it('replays one exact inactive Pending activation before advancing the durable cursor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 7,
                            kind: 'session',
                            entityId: 'inactive-session',
                            changedAt: 1,
                            hint: {
                                pendingVersion: 9,
                                pendingCount: 1,
                                pendingActivationRequestId: 'pending-after-ui-death',
                            },
                        }],
                        nextCursor: 7,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        const order: string[] = [];
        const activation = vi.fn(async () => {
            order.push('activation');
        });
        writeAccountChangesCursor.mockImplementationOnce(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(activation);
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(activation).toHaveBeenCalledWith({
            sessionId: 'inactive-session',
            requestId: 'pending-after-ui-death',
            pendingVersion: 9,
            source: 'changes',
        });
        expect(order).toEqual(['activation', 'cursor']);
    });

    it('surfaces the same exact Pending authorization from a live machine-only update', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        const activation = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onPendingSessionActivationHint(activation);
        client.onConnectedServicesProjection(async () => {});
        client.connect();

        socket.trigger('update', {
            id: 'update-1',
            seq: 7,
            createdAt: 1,
            body: {
                t: 'pending-changed',
                sid: 'inactive-session',
                sessionId: 'inactive-session',
                pendingVersion: 9,
                pendingCount: 1,
                pendingActivationRequestId: 'pending-after-ui-death',
            },
        });

        await vi.waitFor(() => {
            expect(activation).toHaveBeenCalledWith({
                sessionId: 'inactive-session',
                requestId: 'pending-after-ui-death',
                pendingVersion: 9,
                source: 'live',
            });
        });
    });

    it('advances the durable account cursor while semantic generation deferral remains event-eligible', async () => {
        const tempRoot = await mkdtemp(join(tmpdir(), 'happier-projection-cursor-composition-'));
        const originalActiveServerDir = configuration.activeServerDir;
        const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.assign(configuration, { activeServerDir: join(tempRoot, 'server') });
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
        }
        claudeProvenanceReplaceCount.current = 0;
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const credentialRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        const previousCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
        const projection = {
            id: 'acc-1',
            connectedServicesV2: [{
                serviceId: 'claude-subscription',
                profiles: [{ profileId: 'team', status: 'connected', kind: 'oauth' }],
                groups: [{
                    groupId: 'shared',
                    displayName: 'Shared Claude',
                    activeProfileId: 'team',
                    generation: 9,
                    memberProfileIds: ['team'],
                }],
            }, {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'direct', status: 'connected', kind: 'oauth' }],
                groups: [],
            }],
            connectedServiceCredentialRevisionsV1: [{
                serviceId: 'claude-subscription',
                profileId: 'team',
                credentialRevision,
            }],
        } as const;
        const connectedCredential = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'claude-subscription',
            profileId: 'team',
            kind: 'oauth',
            expiresAt: Date.now() + 60 * 60 * 1_000,
            oauth: {
                accessToken: 'claude-access-placeholder',
                refreshToken: 'claude-refresh-placeholder',
                idToken: null,
                scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
                tokenType: 'Bearer',
                providerAccountId: 'claude-account',
                providerEmail: 'team@example.com',
            },
        });
        const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
        const targetInput = (pid: number, sessionId: string) => ({
            pid,
            agentId: 'claude' as const,
            sessionId,
            materializationKey: `csm_${sessionId}`,
            connectedServicesBindingsRaw: {
                v: 1,
                bindingsByServiceId: {
                    'claude-subscription': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'shared',
                        profileId: 'team',
                    },
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'direct',
                    },
                },
            },
            connectedServiceSelectionsEnvRaw: JSON.stringify([{
                kind: 'group',
                serviceId: 'claude-subscription',
                groupId: 'shared',
                activeProfileId: 'team',
                fallbackProfileId: 'team',
                generation: 9,
                credentialRevision: previousCredentialRevision,
            }, {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'direct',
            }]),
        });
        runtimeRegistry.registerTarget(targetInput(7101, 'sess-shared-a'));
        let authoritativeProofAvailable = false;
        const getConnectedServiceAuthGroup = vi.fn(async () => (
            authoritativeProofAvailable ? {
                serviceId: 'claude-subscription',
                groupId: 'shared',
                activeProfileId: 'team',
                generation: 9,
                memberProfileIds: ['team'],
            } : null
        ));
        const restartRequestedPids = new Set<number>();
        const runtime = await startDaemonSessionControlRuntime({
            machineId: machine.id,
            serverBaseUrl: 'https://account.example.test',
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: machine.encryptionKey },
            },
            daemonSessionMutationCustody: {
                stageTranscriptEvent: async () => ({ persisted: true, delivered: true }),
            },
            api: {
                getAccountEncryptionMode: vi.fn(async () => 'plain'),
                getConnectedServiceCredentialPlain: vi.fn(async () => ({
                    content: { t: 'plain' as const, v: connectedCredential },
                    credentialRevision,
                })),
                getConnectedServiceAuthGroup,
                push: vi.fn(() => ({ sendPushNotification: vi.fn() })),
            } as never,
            loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
            connectedServicesMaterializationBaseDir: join(tempRoot, 'materializations'),
            getConnectedServiceRefreshCoordinator: () => null,
            getConnectedServiceQuotasCoordinator: () => null,
            connectedServiceRuntimeRegistry: runtimeRegistry,
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            getApiMachineForSessions: () => null,
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            connectedServicesRestartRequestedPids: restartRequestedPids,
            beforeShutdown: vi.fn(),
            onHappySessionWebhook: vi.fn(),
            requestShutdown: vi.fn(),
            processEnv: {},
        });

        const socket = createMachineSocket();
        socket.connect.mockImplementation(() => {
            socket.connected = true;
            return socket;
        });
        bindApiSessionSocketMock(mockIo, socket);
        const client = new ApiMachineClient('token', machine);
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: projection };
            if (url.includes('/v2/sessions/')) return { status: 404, data: {} };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{ cursor: 3, kind: 'account', entityId: 'self', changedAt: 3, hint: { connectedServices: true } }],
                        nextCursor: 3,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();

        const bootstrap = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: machine.id,
            machine,
            preferredHost: 'host.local',
            happyHomeDir: tempRoot,
            happyLibDir: tempRoot,
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine: () => client,
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn(() => ({
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async () => null),
            spawnSession: vi.fn(async () => ({ type: 'success', sessionId: 'unused' })) as never,
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            reconcileConnectedServicesProjection: runtime.reconcileConnectedServicesProjection,
            startVoiceInferenceWorkerForMachine: vi.fn(async () => null),
        });

        try {
            runtimeRegistry.unregisterPid(7101);
            runtimeRegistry.registerTarget(targetInput(7101, 'sess-shared-a'));

            await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
            expect(writeAccountChangesCursor).toHaveBeenCalledOnce();
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 3);

            const materializedRoot = resolveConnectedServiceMaterializedHomeRoot('claude', {
                activeServerDir: configuration.activeServerDir,
                serviceId: 'claude-subscription',
                profileId: 'team',
                selection: {
                    kind: 'group',
                    serviceId: 'claude-subscription',
                    groupId: 'shared',
                    activeProfileId: 'team',
                    fallbackProfileId: 'team',
                    generation: 9,
                    policy: null,
                },
            });
            expect(materializedRoot).toEqual(expect.any(String));
            const provenancePath = join(materializedRoot!, '.happier-claude-connected-service-home.json');
            const effectAfterLostResponse = await stat(provenancePath, { bigint: true });
            // One real Claude hot-apply replaces base provenance and then stamps the exact group epoch.
            // Replays and additional recipients must verify those bytes without another replacement.
            expect(claudeProvenanceReplaceCount.current).toBe(2);

            authoritativeProofAvailable = true;
            runtimeRegistry.registerTarget(targetInput(7102, 'sess-shared-b'));
            writeAccountChangesCursor.mockClear();
            await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

            const finalEffect = await stat(provenancePath, { bigint: true });
            const finalProvenance = JSON.parse(await readFile(provenancePath, 'utf8'));
            expect(finalProvenance).toMatchObject({
                serviceId: 'claude-subscription',
                credentialProfileId: 'team',
                groupId: 'shared',
                generation: 9,
                credentialRevision,
            });
            expect(finalEffect.ino).toBe(effectAfterLostResponse.ino);
            expect(finalEffect.mtimeNs).toBe(effectAfterLostResponse.mtimeNs);
            expect(claudeProvenanceReplaceCount.current).toBe(2);
            expect(writeAccountChangesCursor).toHaveBeenCalledTimes(1);
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 3);
            expect(restartRequestedPids).toEqual(new Set());
            expect(runtimeRegistry.listTargets().map(({ pid, sessionId }) => ({ pid, sessionId }))).toEqual([
                { pid: 7101, sessionId: 'sess-shared-a' },
                { pid: 7102, sessionId: 'sess-shared-b' },
            ]);
        } finally {
            await bootstrap.stopPeerMediationLoopbackServer();
            bootstrap.machineConnectionStateCleanup?.();
            await client.shutdown();
            await runtime.stopControlServer();
            Object.assign(configuration, { activeServerDir: originalActiveServerDir });
            if (originalPlatformDescriptor) {
                Object.defineProperty(process, 'platform', originalPlatformDescriptor);
            }
            await rm(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps the durable account cursor behind when connected-services reconciliation cannot apply or persist', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{ cursor: 4, kind: 'account', entityId: 'self', changedAt: 4, hint: { connectedServices: true } }],
                        nextCursor: 4,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        (client as any).onConnectedServicesProjection(async (notification: { source: string }) => {
            if (notification.source === 'changes') throw new Error('durable disposition failed');
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' }))
            .rejects.toThrow('durable disposition failed');
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('reconciles current connected-services truth before an empty initial changes page', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
            }
            if (url.includes('/v2/changes')) {
                return { status: 200, data: { changes: [], nextCursor: 8 } };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine);
        const reconcile = vi.fn(async () => {});
        client.onConnectedServicesProjection(reconcile);

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ source: 'startup' }));
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 8);
        expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(writeAccountChangesCursor.mock.invocationCallOrder[0]!);
    });

    it.each([
        ['connect', 'startup'],
        ['reconnect', 'reconnect'],
    ] as const)('reconciles connected-services truth during %s recovery when /v2/changes is disabled', async (reason, source) => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockImplementation(async (url: string) => {
                if (url.includes('/v1/account/profile')) return {
                    status: 200,
                    data: {
                        id: 'acc-1',
                        connectedServicesV2: [],
                        connectedServiceCredentialRevisionsV1: [],
                    },
                };
                throw new Error(`unexpected url: ${url}`);
            });
            const reconcile = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(reconcile);

            await (client as any).syncChangesOnConnect({ reason });

            expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                source,
                executionAuthority: 'passive_projection',
            }));
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('does not reconcile connected services for a live session-only changes page', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 8,
                            kind: 'session',
                            entityId: 'session-1',
                            changedAt: 8,
                            hint: null,
                        }],
                        nextCursor: 8,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const reconcile = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(reconcile);

        await (client as any).syncChangesOnConnect({ reason: 'live' });

        expect(reconcile).not.toHaveBeenCalled();
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 8);
    });

    it('reconciles connected services once for a live connected-services change', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [{
                            cursor: 9,
                            kind: 'account',
                            entityId: 'self',
                            changedAt: 9,
                            hint: { connectedServices: true },
                        }],
                        nextCursor: 9,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        const reconcile = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(reconcile);

        await (client as any).syncChangesOnConnect({ reason: 'live' });

        expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            source: 'changes',
            executionAuthority: 'runtime_recovery',
        }));
    });

    it('continues /v2/changes catch-up without timer retry when generation reconciliation awaits another domain event', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockImplementation(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return {
                        status: 200,
                        data: {
                            id: 'acc-1',
                            connectedServicesV2: [],
                            connectedServiceCredentialRevisionsV1: [],
                        },
                    };
                }
                if (url.includes('/v2/changes')) {
                    return { status: 200, data: { changes: [], nextCursor: 9 } };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            axiosGet.mockClear();
            writeAccountChangesCursor.mockClear();
            const reconcile = vi.fn(async () => {
                throw new ConnectedServiceGenerationReconciliationNotAcknowledgeableError();
            });
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(reconcile);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.advanceTimersByTimeAsync(0);

            expect(reconcile).toHaveBeenCalledOnce();
            expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);

            await vi.advanceTimersByTimeAsync(60_000);
            expect(reconcile).toHaveBeenCalledOnce();

            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await vi.advanceTimersByTimeAsync(0);
            expect(reconcile).toHaveBeenCalledTimes(2);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries a transient projection disposition failure without another server event', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockImplementation(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return {
                        status: 200,
                        data: {
                            id: 'acc-1',
                            connectedServicesV2: [],
                            connectedServiceCredentialRevisionsV1: [],
                        },
                    };
                }
                if (url.includes('/v2/changes')) {
                    return { status: 200, data: { changes: [], nextCursor: 9 } };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            writeAccountChangesCursor.mockClear();
            const reconcile = vi.fn()
                .mockRejectedValueOnce(new Error('transient disposition failure'))
                .mockResolvedValueOnce(undefined);
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(reconcile);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2_000);
            await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));

            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it('serializes a newer projection hint behind an in-flight pass and leaves the newer projection applied last', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            const firstProfile = createDeferred<{ status: number; data: unknown }>();
            let activeFetches = 0;
            let maxActiveFetches = 0;
            let profileCalls = 0;
            axiosGet.mockImplementation(async (url: string) => {
                if (!url.includes('/v1/account/profile')) throw new Error(`unexpected url: ${url}`);
                profileCalls += 1;
                activeFetches += 1;
                maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
                const response = profileCalls === 1
                    ? await firstProfile.promise
                    : {
                        status: 200,
                        data: {
                            id: 'acc-1',
                            connectedServicesV2: [],
                            connectedServiceCredentialRevisionsV1: [{
                                serviceId: 'anthropic',
                                profileId: 'profile-a',
                                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                            }],
                        },
                    };
                activeFetches -= 1;
                return response;
            });
            axiosGet.mockClear();
            const appliedRevisions: string[] = [];
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(async (notification) => {
                const entries = notification.connectedServiceCredentialRevisionsV1 as Array<{ credentialRevision: string }>;
                appliedRevisions.push(entries[0]?.credentialRevision ?? 'none');
            });

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(profileCalls).toBe(1));
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await Promise.resolve();
            expect(profileCalls).toBe(1);

            firstProfile.resolve({
                status: 200,
                data: {
                    id: 'acc-1',
                    connectedServicesV2: [],
                    connectedServiceCredentialRevisionsV1: [{
                        serviceId: 'anthropic',
                        profileId: 'profile-a',
                        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                    }],
                },
            });
            await (client as any).connectedServicesProjectionRetry.waitForIdle();

            expect(maxActiveFetches).toBe(1);
            expect(appliedRevisions).toEqual([
                'csr_aaaaaaaaaaaaaaaaaaaaaa',
                'csr_bbbbbbbbbbbbbbbbbbbbbb',
            ]);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('does not turn repeated projection hints into concurrent work or reset retry backoff', async () => {
        vi.useFakeTimers();
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockResolvedValue({
                status: 200,
                data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
            });
            axiosGet.mockClear();
            let activeListeners = 0;
            let maxActiveListeners = 0;
            const firstDisposition = createDeferred<void>();
            let listenerCalls = 0;
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(async () => {
                listenerCalls += 1;
                activeListeners += 1;
                maxActiveListeners = Math.max(maxActiveListeners, activeListeners);
                try {
                    if (listenerCalls === 1) await firstDisposition.promise;
                } finally {
                    activeListeners -= 1;
                }
            });

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(listenerCalls).toBe(1));
            for (let index = 0; index < 20; index += 1) {
                (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            }
            firstDisposition.reject(new Error('transient disposition failure'));
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(1_999);
            expect(listenerCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(() => expect(listenerCalls).toBe(2));
            await (client as any).connectedServicesProjectionRetry.waitForIdle();

            expect(maxActiveListeners).toBe(1);
            expect(listenerCalls).toBe(2);
        } finally {
            vi.useRealTimers();
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('aborts an in-flight projection request and awaits scheduler quiescence on shutdown', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            let requestSignal: AbortSignal | undefined;
            axiosGet.mockImplementation(async (_url: string, config?: { signal?: AbortSignal }) => {
                requestSignal = config?.signal;
                await new Promise<void>((_resolve, reject) => {
                    config?.signal?.addEventListener('abort', () => reject(config.signal?.reason), { once: true });
                });
                throw new Error('unreachable');
            });
            axiosGet.mockClear();
            const listener = vi.fn(async () => {});
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(listener);

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledOnce());
            await client.shutdown();

            expect(requestSignal?.aborted).toBe(true);
            expect(listener).not.toHaveBeenCalled();
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('threads shutdown cancellation through the projection listener before changes or cursor side effects', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockResolvedValue({
            status: 200,
            data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
        });
        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        const listenerSideEffects: string[] = [];
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async (notification) => {
            listenerSideEffects.push('entered');
            await new Promise<void>((resolve) => {
                notification.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            if (!notification.signal.aborted) listenerSideEffects.push('after-abort');
        });

        (client as any).startChangesSyncWithRetry({ reason: 'connect' });
        await vi.waitFor(() => expect(listenerSideEffects).toEqual(['entered']));
        await client.shutdown();

        expect(listenerSideEffects).toEqual(['entered']);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('awaits an entered cursor write during shutdown instead of reporting false quiescence', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] } };
            }
            if (url.includes('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: 12 } };
            throw new Error(`unexpected url: ${url}`);
        });
        axiosGet.mockClear();
        const cursorWrite = createDeferred<void>();
        writeAccountChangesCursor.mockImplementationOnce(async () => await cursorWrite.promise);
        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        (client as any).startChangesSyncWithRetry({ reason: 'connect' });
        await vi.waitFor(() => expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 12));

        let shutdownSettled = false;
        const shutdown = client.shutdown().then(() => { shutdownSettled = true; });
        await Promise.resolve();
        expect(shutdownSettled).toBe(false);

        cursorWrite.resolve();
        await shutdown;
        expect(shutdownSettled).toBe(true);
    });

    it('rejects projection producers that race with or follow terminal shutdown', async () => {
        const previousV2Changes = process.env.HAPPY_ENABLE_V2_CHANGES;
        process.env.HAPPY_ENABLE_V2_CHANGES = 'false';
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockResolvedValue({
                status: 200,
                data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
            });
            axiosGet.mockClear();
            const current = createDeferred<void>();
            let calls = 0;
            const client = new ApiMachineClient('token', machine);
            const socket = createMachineSocket();
            (client as any).socket = socket;
            (client as any).activeTransportGeneration = 1;
            (client as any).installSocketEventHandlers(socket, 1);
            client.onConnectedServicesProjection(async () => {
                calls += 1;
                if (calls === 1) await current.promise;
            });
            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await vi.waitFor(() => expect(calls).toBe(1));

            const shutdown = client.shutdown();
            socket.trigger('update', { body: { t: 'update-account', connectedServices: [] } });
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            current.resolve();
            await shutdown;
            socket.trigger('update', { body: { t: 'update-account', connectedServices: [] } });
            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await Promise.resolve();

            expect(calls).toBe(1);
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
        } finally {
            if (previousV2Changes === undefined) delete process.env.HAPPY_ENABLE_V2_CHANGES;
            else process.env.HAPPY_ENABLE_V2_CHANGES = previousV2Changes;
        }
    });

    it('advances the changes cursor when account settings refresh for a hint fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                        ],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });
        client.onConnectedServicesProjection(async () => {});
        const secondListener = vi.fn(async () => {});
        client.onAccountSettingsVersionHint(secondListener);

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(secondListener).toHaveBeenCalledWith({
            settingsVersion: 5,
            source: 'changes',
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
    });

    it('does not surface an unhandled rejection when a background changes sync fails on connect', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [
                            { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 5 } },
                        ],
                        nextCursor: 1,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            const client = new ApiMachineClient('token', machine);
            client.onAccountSettingsVersionHint(async () => {
                throw new Error('settings refresh failed');
            });
            client.onConnectedServicesProjection(async () => {});
            client.connect();

            await vi.waitFor(() => {
                expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
            });
            await new Promise((resolve) => setImmediate(resolve));

            expect(unhandledRejections).toEqual([]);
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 1);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
    });

    it('refreshes account settings conservatively when the changes cursor is gone', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 410,
                    data: { error: 'cursor-gone', currentCursor: 9 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();
        publishPluginAccountCollectionWatchInvalidation.mockClear();

        const onAccountSettingsVersionHint = vi.fn(async () => {});
        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(onAccountSettingsVersionHint);
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(onAccountSettingsVersionHint).toHaveBeenCalledTimes(1);
        expect(onAccountSettingsVersionHint).toHaveBeenCalledWith({
            settingsVersion: null,
            source: 'cursor-gone',
        });
        expect(publishPluginAccountCollectionWatchInvalidation).toHaveBeenCalledExactlyOnceWith({
            accountScopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            kind: 'reset',
            changeCursor: 9,
        });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
        expect(
            publishPluginAccountCollectionWatchInvalidation.mock.invocationCallOrder[0],
        ).toBeLessThan(writeAccountChangesCursor.mock.invocationCallOrder[0]!);
    });

    it('applies a live permanent-removal witness before acknowledging its Account cursor without a Session detail read', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-live',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        let phase: 'initial' | 'live' = 'initial';
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return phase === 'initial'
                    ? {
                        status: 200,
                        data: {
                            changes: [],
                            nextCursor: 0,
                            sessionAccessWitness: { v: 1, throughCursor: 0, entries: [] },
                        },
                    }
                    : {
                        status: 200,
                        data: {
                            changes: [{
                                cursor: 7,
                                kind: 'session',
                                entityId: 'session-removed',
                                changedAt: 7,
                                hint: null,
                            }],
                            nextCursor: 7,
                            sessionAccessWitness: {
                                v: 1,
                                throughCursor: 7,
                                entries: [{
                                    sessionId: 'session-removed',
                                    cursor: 7,
                                    status: 'unavailable',
                                }],
                            },
                        },
                    };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});
        client.connect();
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 0);
        });

        phase = 'live';
        writeAccountChangesCursor.mockClear();
        applyResourceSessionAccessWitness.mockClear();
        order.length = 0;
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        socket.trigger('update', {
            id: 'account-change-resource-session',
            seq: 7,
            createdAt: 7,
            body: { t: 'account-change' },
        });

        await vi.waitFor(() => {
            expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
                accountId: 'acc-1',
                witness: {
                    v: 1,
                    throughCursor: 7,
                    entries: [{
                        sessionId: 'session-removed',
                        cursor: 7,
                        status: 'unavailable',
                    }],
                },
            });
        });
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/sessions/'))).toBe(false);
        expect(order).toEqual(['witness', 'cursor']);
        await client.shutdown();
    });

    it('forwards a page-saturated witness before acknowledging the cursor without enumerating Resource Sessions', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-page-limit',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: Array.from({ length: 200 }, (_unused, index) => ({
                            cursor: index + 1,
                            kind: 'account',
                            entityId: 'self',
                            changedAt: index + 1,
                            hint: null,
                        })),
                        nextCursor: 200,
                        sessionAccessWitness: { v: 1, throughCursor: 200, entries: [] },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
            accountId: 'acc-1',
            witness: { v: 1, throughCursor: 200, entries: [] },
        });
        expect(order).toEqual(['witness', 'cursor']);
    });

    it('marks Session Resources unavailable before acknowledging a cursor-gone reset', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-cursor-gone',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) {
                return { status: 410, data: { error: 'cursor-gone', currentCursor: 11 } };
            }
            if (url.includes('/v1/machines/machine-resource-session-cursor-gone')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-resource-session-cursor-gone',
                            metadata: null,
                            metadataVersion: 0,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({ accountId: 'acc-1' });
        expect(order).toEqual(['witness', 'cursor']);
    });

    it('does not change Session Resource access for a malformed cursor-gone response', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-malformed-cursor-gone',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const applyResourceSessionAccessWitness = vi.fn();
        axiosGet.mockClear();
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'acc-1' } };
            if (url.includes('/v2/changes')) return { status: 410, data: { error: 'not-cursor-gone' } };
            if (url.includes('/v1/machines/machine-resource-session-malformed-cursor-gone')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-resource-session-malformed-cursor-gone',
                            metadata: null,
                            metadataVersion: 0,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        readAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockResolvedValueOnce(17);
        writeAccountChangesCursor.mockClear();
        publishPluginAccountSettingsWatchInvalidation.mockClear();
        publishPluginAccountCollectionWatchInvalidation.mockClear();
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        let failure: unknown = null;
        try {
            await (client as any).syncChangesOnConnect({ reason: 'connect' });
        } catch (error) {
            failure = error;
        }

        expect(applyResourceSessionAccessWitness).not.toHaveBeenCalled();
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/'))).toBe(false);
        expect(publishPluginAccountSettingsWatchInvalidation).not.toHaveBeenCalled();
        expect(publishPluginAccountCollectionWatchInvalidation).not.toHaveBeenCalled();
        // A zero write deletes the prior persisted cursor entry.
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        expect(failure).toBeInstanceOf(Error);
    });

    it('applies an empty first Account-lifetime witness before acknowledging its cursor', async () => {
        const machine: Machine = {
            id: 'machine-resource-session-account-transition',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const order: string[] = [];
        const applyResourceSessionAccessWitness = vi.fn(() => {
            order.push('witness');
        });
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) return { status: 200, data: { id: 'account-b' } };
            if (url.includes('/v2/changes')) {
                return {
                    status: 200,
                    data: {
                        changes: [],
                        nextCursor: 12,
                        sessionAccessWitness: { v: 1, throughCursor: 12, entries: [] },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });
        writeAccountChangesCursor.mockClear();
        writeAccountChangesCursor.mockImplementation(async () => {
            order.push('cursor');
        });
        const client = new ApiMachineClient('account-b-token', machine, undefined, {
            resourceSessionLifecycle: {
                applyResourceSessionAccessWitness,
            },
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'connect' });

        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
            accountId: 'account-b',
            witness: { v: 1, throughCursor: 12, entries: [] },
        });
        expect(order).toEqual(['witness', 'cursor']);
    });

    it('retries a transient /v2/changes response without changing Session Resource access before proof arrives', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-resource-session-transient',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            const order: string[] = [];
            const applyResourceSessionAccessWitness = vi.fn(() => {
                order.push('witness');
            });
            let changesAttempts = 0;
            axiosGet.mockImplementation(async (url: string) => {
                if (url.includes('/v1/account/profile')) {
                    return {
                        status: 200,
                        data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
                    };
                }
                if (url.includes('/v2/changes')) {
                    changesAttempts += 1;
                    return changesAttempts === 1
                        ? { status: 503, data: { error: 'busy' } }
                        : {
                            status: 200,
                            data: {
                                changes: [{
                                    cursor: 1,
                                    kind: 'session',
                                    entityId: 'session-removed',
                                    changedAt: 1,
                                    hint: null,
                                }],
                                nextCursor: 1,
                                sessionAccessWitness: {
                                    v: 1,
                                    throughCursor: 1,
                                    entries: [{
                                        sessionId: 'session-removed',
                                        cursor: 1,
                                        status: 'unavailable',
                                    }],
                                },
                            },
                        };
                }
                if (url.includes('/v1/machines/machine-resource-session-transient')) {
                    return {
                        status: 200,
                        data: {
                            machine: {
                                id: 'machine-resource-session-transient',
                                metadata: null,
                                metadataVersion: 0,
                                daemonState: null,
                                daemonStateVersion: 0,
                            },
                        },
                    };
                }
                throw new Error(`unexpected url: ${url}`);
            });
            writeAccountChangesCursor.mockClear();
            writeAccountChangesCursor.mockImplementation(async () => {
                order.push('cursor');
            });
            const client = new ApiMachineClient('token', machine, undefined, {
                resourceSessionLifecycle: {
                    applyResourceSessionAccessWitness,
                },
            });
            client.onConnectedServicesProjection(async () => {});

            (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
            await vi.waitFor(() => expect(changesAttempts).toBe(1));

            expect(applyResourceSessionAccessWitness).not.toHaveBeenCalled();
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2_000);
            await vi.waitFor(() => expect(changesAttempts).toBe(2));

            expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({
                accountId: 'acc-1',
                witness: {
                    v: 1,
                    throughCursor: 1,
                    entries: [{
                        sessionId: 'session-removed',
                        cursor: 1,
                        status: 'unavailable',
                    }],
                },
            });
            expect(order).toEqual(['witness', 'cursor']);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([401, 403] as const)(
        'reports changes-feed auth status %i without changing Session Resource access, cursor advance, or retry',
        async (status) => {
            vi.useFakeTimers();
            let client: ApiMachineClient | null = null;
            try {
                const machine: Machine = {
                    id: 'machine-resource-session-detail-auth',
                    encryptionKey: new Uint8Array(32).fill(7),
                    encryptionVariant: 'legacy',
                    metadata: null,
                    metadataVersion: 0,
                    daemonState: null,
                    daemonStateVersion: 0,
                };
                const applyResourceSessionAccessWitness = vi.fn();
                let changesAttempts = 0;
                axiosGet.mockImplementation(async (url: string) => {
                    if (url.includes('/v1/account/profile')) {
                        return {
                            status: 200,
                            data: { id: 'acc-1', connectedServicesV2: [], connectedServiceCredentialRevisionsV1: [] },
                        };
                    }
                    if (url.includes('/v2/changes')) {
                        changesAttempts += 1;
                        return {
                            status,
                            data: { error: 'not-authenticated' },
                        };
                    }
                    throw new Error(`unexpected url: ${url}`);
                });
                writeAccountChangesCursor.mockClear();
                const reportProbeResult = vi.fn();
                client = new ApiMachineClient('token', machine, undefined, {
                    resourceSessionLifecycle: {
                        applyResourceSessionAccessWitness,
                    },
                });
                client.onConnectedServicesProjection(async () => {});
                Object.defineProperty(client, 'connectionSupervisor', {
                    configurable: true,
                    value: {
                        getState: () => ({
                            phase: 'online',
                            reason: null,
                            attempt: 0,
                            nextRetryAt: null,
                            lastConnectedAt: Date.now(),
                            lastDisconnectedAt: null,
                            lastErrorMessage: null,
                        }),
                        reportProbeResult,
                        stop: vi.fn(async () => {}),
                    },
                });

                (client as any).startChangesSyncWithRetry({ reason: 'reconnect' });
                await vi.advanceTimersByTimeAsync(0);

                expect(reportProbeResult).toHaveBeenCalledWith({
                    status: 'auth_failed',
                    statusCode: status,
                    errorMessage: `Authentication failed while fetching changes (${status})`,
                } satisfies ReadinessProbeResult);
                expect(applyResourceSessionAccessWitness).not.toHaveBeenCalled();
                expect(writeAccountChangesCursor).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(2_000);
                expect(changesAttempts).toBe(1);
                expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
            } finally {
                await client?.shutdown();
                vi.useRealTimers();
            }
        },
    );

    it('advances a cursor-gone cursor when conservative account settings refresh fails', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 410,
                    data: { error: 'cursor-gone', currentCursor: 9 },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: { machine: { id: 'machine-1', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onAccountSettingsVersionHint(async () => {
            throw new Error('settings refresh failed');
        });
        client.onConnectedServicesProjection(async () => {});

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });
        expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
    });

    it('refreshes machine snapshot when /v2/changes is missing while disabling only Session Resource access', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const encryptedMetadata = encodeBase64(
            encrypt(machine.encryptionKey, machine.encryptionVariant, {
                host: 'h',
                platform: 'p',
                happyCliVersion: 'v',
                homeDir: '/home',
                happyHomeDir: '/happy',
                happyLibDir: '/lib',
            }),
        );

        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status: 404,
                    data: { error: 'not-found' },
                };
            }
            if (url.includes('/v1/machines/machine-1')) {
                return {
                    status: 200,
                    data: {
                        machine: {
                            id: 'machine-1',
                            metadata: encryptedMetadata,
                            metadataVersion: 2,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const applyResourceSessionAccessWitness = vi.fn();
        const client = new ApiMachineClient('token', machine, undefined, {
            resourceSessionLifecycle: { applyResourceSessionAccessWitness },
        });
        client.onConnectedServicesProjection(async () => {});
        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(machine.metadata).toEqual(
            expect.objectContaining({
                host: 'h',
                platform: 'p',
            }),
        );
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
        expect(applyResourceSessionAccessWitness).toHaveBeenCalledExactlyOnceWith({ accountId: 'acc-1' });
    });

    it.each([401, 403] as const)('reports /v2/changes auth status %i to the machine supervisor without snapshot fallback', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('reports profile auth status %i to the machine supervisor before /v2/changes sync', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).syncChangesOnConnect({ reason: 'reconnect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v2/changes'))).toBe(false);
        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it('reports a scheduled profile auth failure once without cursor advancement or retry spin', async () => {
        vi.useFakeTimers();
        try {
            const machine: Machine = {
                id: 'machine-1',
                encryptionKey: new Uint8Array(32).fill(7),
                encryptionVariant: 'legacy',
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            };
            axiosGet.mockResolvedValue({ status: 401, data: { error: 'not-authenticated' } });
            axiosGet.mockClear();
            writeAccountChangesCursor.mockClear();
            const reportProbeResult = vi.fn();
            const client = new ApiMachineClient('token', machine);
            client.onConnectedServicesProjection(async () => {});
            Object.defineProperty(client, 'connectionSupervisor', {
                configurable: true,
                value: {
                    getState: () => ({
                        phase: 'online',
                        reason: null,
                        attempt: 0,
                        nextRetryAt: null,
                        lastConnectedAt: Date.now(),
                        lastDisconnectedAt: null,
                        lastErrorMessage: null,
                    }),
                    reportProbeResult,
                    stop: vi.fn(async () => {}),
                },
            });

            (client as any).startChangesSyncWithRetry({ reason: 'connect' });
            await (client as any).connectedServicesProjectionRetry.waitForIdle();
            await vi.advanceTimersByTimeAsync(60_000);

            expect(reportProbeResult).toHaveBeenCalledOnce();
            expect(axiosGet).toHaveBeenCalledOnce();
            expect(writeAccountChangesCursor).not.toHaveBeenCalled();
            expect((client as any).connectedServicesProjectionRetry.hasPendingWork()).toBe(false);
            await client.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([401, 403] as const)('throws /v2/changes auth status %i without a machine supervisor instead of snapshot fallback', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                return {
                    status,
                    data: { error: 'not-authenticated' },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        readAccountChangesCursor.mockClear();

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: null,
        });

        await expect((client as any).syncChangesOnConnect({ reason: 'reconnect' })).rejects.toMatchObject({
            code: 'not_authenticated',
            response: { status },
        });

        expect(axiosGet.mock.calls.some(([url]) => String(url).includes('/v1/machines/machine-1'))).toBe(false);
        expect(writeAccountChangesCursor).not.toHaveBeenCalled();
    });

    it.each([401, 403] as const)('reports machine snapshot refresh auth status %i to the machine supervisor', async (status) => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockResolvedValue({
            status,
            data: { error: 'not-authenticated' },
        });
        axiosGet.mockClear();

        const client = new ApiMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).refreshMachineFromServer();

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });

    it('redacts axios machine snapshot refresh failures before logging', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockRejectedValueOnce({
            isAxiosError: true,
            name: 'AxiosError',
            message: 'socket hang up',
            code: 'ECONNRESET',
            config: {
                method: 'get',
                url: 'http://localhost:3005/v1/machines/machine-1?token=secret#hash',
                headers: { Authorization: 'Bearer fake-token' },
                data: { encryptionKeyBase64: 'super-secret-key' },
            },
        });
        axiosGet.mockClear();
        const debug = vi.mocked(logger.debug);
        debug.mockClear();

        const client = new ApiMachineClient('fake-token', machine);
        await (client as any).refreshMachineFromServer();

        const logged = JSON.stringify(debug.mock.calls);
        expect(logged).not.toContain('fake-token');
        expect(logged).not.toContain('Authorization');
        expect(logged).not.toContain('token=secret');
        expect(logged).not.toContain('super-secret-key');
    });

    it('reports retryable machine snapshot refresh failures to the machine supervisor', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        axiosGet.mockResolvedValue({
            status: 503,
            data: { error: 'busy' },
        });
        axiosGet.mockClear();

        const client = new ApiMachineClient('token', machine);
        const reportProbeResult = vi.fn();
        Object.defineProperty(client, 'connectionSupervisor', {
            configurable: true,
            value: {
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });

        await (client as any).refreshMachineFromServer();

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'retry_later',
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });

    it('catches up the existing AccountChange cursor after a live content-free wake', async () => {
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const socket = createMachineSocket();
        bindApiSessionSocketMock(mockIo, socket);
        let phase: 'initial' | 'live' = 'initial';
        axiosGet.mockImplementation(async (url: string) => {
            if (url.includes('/v1/account/profile')) {
                return { status: 200, data: { id: 'acc-1' } };
            }
            if (url.includes('/v2/changes')) {
                if (phase === 'initial') {
                    return { status: 200, data: { changes: [], nextCursor: 0 } };
                }
                return {
                    status: 200,
                    data: {
                        changes: [
                            {
                                cursor: 6,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/settings',
                                changedAt: 6,
                                hint: {
                                    pluginDomain: 'settings',
                                    pluginId: 'example.tasks',
                                    scope: 'account',
                                    revision: 11,
                                },
                            },
                            {
                                cursor: 8,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/data-collection/tasks',
                                changedAt: 8,
                                hint: {
                                    pluginDomain: 'dataCollection',
                                    pluginId: 'example.tasks',
                                    collectionId: 'tasks',
                                    contractDigest: 'a'.repeat(43),
                                    revision: 4,
                                    full: true,
                                },
                            },
                            {
                                cursor: 9,
                                kind: 'pluginDomain',
                                entityId: 'pluginDomain/example.tasks/availability',
                                changedAt: 9,
                                hint: {
                                    pluginDomain: 'availability',
                                    pluginId: 'example.tasks',
                                },
                            },
                        ],
                        nextCursor: 9,
                    },
                };
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const client = new ApiMachineClient('token', machine);
        client.onConnectedServicesProjection(async () => {});
        client.connect();
        socket.trigger('connect');
        await vi.waitFor(() => {
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 0);
        });

        phase = 'live';
        axiosGet.mockClear();
        writeAccountChangesCursor.mockClear();
        publishPluginAccountSettingsWatchInvalidation.mockClear();
        publishPluginAccountCollectionWatchInvalidation.mockClear();
        socket.trigger('update', {
            id: 'account-change-9',
            seq: 9,
            createdAt: 9,
            body: { t: 'account-change' },
        });

        await vi.waitFor(() => {
            expect(writeAccountChangesCursor).toHaveBeenCalledWith('acc-1', 9);
        });
        expect(axiosGet).toHaveBeenCalledWith(expect.stringContaining('/v2/changes'), expect.anything());
        expect(publishPluginAccountSettingsWatchInvalidation).toHaveBeenCalledWith({
            kind: 'record',
            pluginId: 'example.tasks',
            revision: 11,
        });
        expect(publishPluginAccountCollectionWatchInvalidation).toHaveBeenCalledWith({
            accountScopeKey: resolveAccountSettingsScopeKeyForToken('token'),
            kind: 'collection',
            pluginId: 'example.tasks',
            collectionId: 'tasks',
            contractDigest: 'a'.repeat(43),
            changeCursor: 8,
        });
        await client.shutdown();
    });

    it('retires Collection watch retention only when the ApiMachine Account lifetime shuts down', async () => {
        const machine: Machine = {
            id: 'machine-collection-watch-retirement',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        retirePluginAccountCollectionWatchScope.mockClear();
        const client = new ApiMachineClient('account-token-retirement', machine);

        await client.shutdown();

        expect(retirePluginAccountCollectionWatchScope).toHaveBeenCalledExactlyOnceWith(
            resolveAccountSettingsScopeKeyForToken('account-token-retirement'),
        );
    });
});
