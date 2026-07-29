import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    accountSettingsParse,
    sealSessionOwnerMetadataV1,
    SessionOwnerMetadataV1Schema,
    V2SessionListResponseSchema,
} from '@happier-dev/protocol';

import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const defaultRestoreMocks = vi.hoisted(() => ({
    fetchSessionById: vi.fn(),
    readCredentials: vi.fn(),
    loadLinkedExternalSession: vi.fn(),
    loadLinkedExternalSessionFromRaw: vi.fn(),
    loadPersistedLinkedExternalSession: vi.fn(),
    resolveExternalSessionObservationLinkInput: vi.fn(),
    resolveGenerationBoundExternalSessionFollowSurface: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readCredentials: defaultRestoreMocks.readCredentials,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<
        typeof import('@/session/transport/http/sessionsHttp')
    >(),
    fetchSessionById: defaultRestoreMocks.fetchSessionById,
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', async (
    importOriginal,
) => ({
    ...await importOriginal<
        typeof import('@/api/session/external/takeover/loadLinkedExternalSession')
    >(),
    loadLinkedExternalSession: defaultRestoreMocks.loadLinkedExternalSession,
    loadLinkedExternalSessionFromRaw:
        defaultRestoreMocks.loadLinkedExternalSessionFromRaw,
    loadPersistedLinkedExternalSession:
        defaultRestoreMocks.loadPersistedLinkedExternalSession,
}));

vi.mock('./resolveExternalSessionObservationLinkInput', async (
    importOriginal,
) => ({
    ...await importOriginal<
        typeof import('./resolveExternalSessionObservationLinkInput')
    >(),
    resolveExternalSessionObservationLinkInput:
        defaultRestoreMocks.resolveExternalSessionObservationLinkInput,
}));

vi.mock('@/session/actions/externalSessions/providerOpsResolution', async (
    importOriginal,
) => ({
    ...await importOriginal<
        typeof import('@/session/actions/externalSessions/providerOpsResolution')
    >(),
    resolveGenerationBoundExternalSessionFollowSurface:
        defaultRestoreMocks.resolveGenerationBoundExternalSessionFollowSurface,
}));

import type { ExternalSessionObservationLinkInput } from './resolveExternalSessionObservationLinkInput';
import { createExternalSessionFollowLeaseManager } from './createExternalSessionFollowLeaseManager';
import {
    listCurrentExternalSessionPassivePolicies,
    startExternalSessionPassiveObservation,
} from './startExternalSessionPassiveObservation';

const { debugLog } = vi.hoisted(() => ({
    debugLog: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: debugLog,
    },
}));

function resolvedInput(sessionId: string): ExternalSessionObservationLinkInput {
    return {
        resource: {
            pluginId: 'happier.opencode',
            agentLocalId: 'opencode',
            pluginGeneration: 'plugin-generation-1',
            resourceKey: 'endpoint-one',
        },
        link: {
            sessionId,
            linkGeneration: '1000',
            linkKey: `native-${sessionId}`,
            linkedSource: {
                source: { kind: 'opencode.server' },
                remoteSessionId: `native-${sessionId}`,
                linkData: {},
            },
            changeObservation: 'observe_resource',
        },
        target: {
            qualifiedLinkIdentity: {
                v: 1,
                agent: {
                    pluginId: 'happier.opencode',
                    localId: 'opencode',
                },
                source: {
                    kind: 'opencode.server',
                    contractVersion: 1,
                },
            },
            linkGeneration: '1000',
        },
    };
}

function accountSettingsWithPassiveRestore(enabled: boolean) {
    return accountSettingsParse({
        externalSessionsSettingsV1: {
            v: 1,
            keepPassivelyFollowingAfterRestart: enabled,
        },
    });
}

describe('startExternalSessionPassiveObservation', () => {
    beforeEach(() => {
        for (const mock of Object.values(defaultRestoreMocks)) {
            mock.mockReset();
        }
    });

    it('does not serialize passive-startup failure details into its log sink', async () => {
        const sentinel = '/Users/alice/private/provider-session.jsonl TOKEN_SECRET transcript-secret';
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' })),
                removeLink: vi.fn(async () => ({ removed: true })),
            },
            listCurrentLinks: async () => {
                throw Object.assign(new Error(sentinel), {
                    cause: { token: sentinel },
                    request: { source: sentinel },
                    link: { claim: sentinel },
                });
            },
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.ready;

        expect(debugLog).toHaveBeenCalledWith(
            '[externalSessions][internal_error]',
            {
                context: 'external_session.passive_observation_startup',
                errorCode: 'internal_error',
                errorKind: 'error',
            },
        );
        expect(JSON.stringify(debugLog.mock.calls)).not.toContain(sentinel);
        await lifecycle.dispose();
    });

    it('loads only explicit unarchived background-follow policies through the bounded canonical inventory', async () => {
        const fetchPage = vi.fn()
            .mockResolvedValueOnce({
                sessions: [
                    { id: 'session-local' },
                    { id: 'session-implicit' },
                    { id: 'session-other-machine' },
                    { id: 'session-archived', archivedAt: 2_000 },
                    { id: 'session-hosted' },
                ],
                hasNext: true,
                nextCursor: 'page-2',
            })
            .mockResolvedValueOnce({
                sessions: [{ id: 'session-local-2' }],
                hasNext: false,
                nextCursor: null,
            });
        const metadataById = new Map<string, Record<string, unknown>>([
            ['session-local', {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-1',
                    source: { kind: 'opencodeServer', directory: '/tmp/project' },
                    linkedAtMs: 1_000,
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                        updatedAtMs: 1_500,
                    },
                },
            }],
            ['session-implicit', {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-implicit',
                    source: { kind: 'opencodeServer', directory: '/tmp/project' },
                    linkedAtMs: 1_000,
                },
            }],
            ['session-other-machine', {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-2',
                    remoteSessionId: 'native-2',
                    source: { kind: 'opencodeServer', directory: '/tmp/project' },
                    linkedAtMs: 1_000,
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                        updatedAtMs: 1_500,
                    },
                },
            }],
            ['session-archived', {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-archived',
                    source: { kind: 'opencodeServer', directory: '/tmp/project' },
                    linkedAtMs: 1_000,
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                        updatedAtMs: 1_500,
                    },
                },
            }],
            ['session-hosted', {}],
            ['session-local-2', {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-3',
                    source: { kind: 'opencodeServer', directory: '/tmp/project' },
                    linkedAtMs: 1_000,
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                        updatedAtMs: 1_500,
                    },
                },
            }],
        ]);
        const resolveLinkInput = vi.fn(async ({ sessionId }: { sessionId: string }) => (
            resolvedInput(sessionId)
        ));

        const links = await listCurrentExternalSessionPassivePolicies({
            machineId: 'machine-1',
            signal: new AbortController().signal,
            readCredentials: async () => ({ token: 'token' } as never),
            fetchPage: fetchPage as never,
            decryptOwnerMetadataView: ({ rawSession }) => (
                metadataById.get((rawSession as { id: string }).id) ?? null
            ),
            resolveLinkInput: resolveLinkInput as never,
        });

        expect(fetchPage).toHaveBeenNthCalledWith(1, {
            token: 'token',
            limit: 200,
        });
        expect(fetchPage).toHaveBeenNthCalledWith(2, {
            token: 'token',
            cursor: 'page-2',
            limit: 200,
        });
        expect(links.map((policy) => policy.sessionId)).toEqual([
            'session-local',
            'session-local-2',
        ]);
        expect(resolveLinkInput).toHaveBeenCalledTimes(2);
    });

    it('loads a layout-v1 background-follow policy from the owner metadata view', async () => {
        const secret = new Uint8Array(32).fill(17);
        const externalSessionV1 = {
            v: 1 as const,
            agentId: 'opencode',
            machineId: 'machine-1',
            remoteSessionId: 'native-layout-1',
            source: { kind: 'opencodeServer' as const, directory: '/tmp/layout-1' },
            linkedAtMs: 1_000,
            followPolicyV1: {
                v: 1 as const,
                policy: 'background_follow' as const,
                updatedAtMs: 1_500,
            },
        };
        const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
            v: 1,
            nativeSession: { externalSessionV1 },
        });
        const ownerMetadataCiphertext = sealSessionOwnerMetadataV1({
            material: { type: 'legacy', secret },
            ownerMetadata,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const rawSessions = V2SessionListResponseSchema.parse({
            sessions: [{
                id: 'session-layout-1',
                seq: 1,
                createdAt: 1_000,
                updatedAt: 1_000,
                active: false,
                activeAt: 1_000,
                encryptionMode: 'plain',
                metadataLayoutVersion: 1,
                metadataVersion: 1,
                metadata: JSON.stringify({
                    v: 1,
                    agentPresentation: { agentId: 'opencode' },
                }),
                ownerMetadata: ownerMetadataCiphertext,
                agentState: null,
                agentStateVersion: 1,
                dataEncryptionKey: null,
            }],
            hasNext: false,
            nextCursor: null,
        }).sessions;
        const resolveLinkInput = vi.fn(async ({ sessionId }: { sessionId: string }) => (
            resolvedInput(sessionId)
        ));

        const policies = await listCurrentExternalSessionPassivePolicies({
            machineId: 'machine-1',
            signal: new AbortController().signal,
            readCredentials: async () => ({
                token: 'token',
                encryption: { type: 'legacy', secret },
            }),
            fetchPage: async () => ({
                sessions: rawSessions,
                hasNext: false,
                nextCursor: null,
            }),
            resolveLinkInput: resolveLinkInput as never,
        });

        expect(policies).toEqual([{
            sessionId: 'session-layout-1',
            observation: resolvedInput('session-layout-1'),
        }]);
        expect(resolveLinkInput).toHaveBeenCalledOnce();
    });

    it('rejects more than 100 persisted policies before acquiring observation or follow work', async () => {
        const sessions = Array.from({ length: 101 }, (_, index) => ({
            id: `session-${index}`,
        }));

        await expect(listCurrentExternalSessionPassivePolicies({
            machineId: 'machine-1',
            signal: new AbortController().signal,
            readCredentials: async () => ({ token: 'token' } as never),
            fetchPage: async () => ({
                sessions: sessions as never,
                hasNext: false,
                nextCursor: null,
            }),
            decryptOwnerMetadataView: ({ rawSession }) => ({
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: (rawSession as { id: string }).id,
                    source: { kind: 'opencodeServer', directory: '/tmp/project' },
                    linkedAtMs: 1_000,
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                        updatedAtMs: 1_500,
                    },
                },
            }),
            resolveLinkInput: async ({ sessionId }) => resolvedInput(sessionId),
        })).rejects.toThrow('exceeded its 100-policy bound');
    });

    it('restores file-backed passive observation before transcript follow only after connectivity resumes', async () => {
        const fileBacked = {
            ...resolvedInput('session-1'),
            link: {
                ...resolvedInput('session-1').link,
                changeObservation: 'watch_file_changes' as const,
                watchFileChanges: {
                    files: ['/fixture/rollout.jsonl'],
                },
            },
        };
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const restoreFollowPolicy = vi.fn(async () => {});
        const pauseFollowPolicy = vi.fn(async () => {});
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const listCurrentLinks = vi.fn(async () => [{
            sessionId: 'session-1',
            observation: fileBacked,
        }]);
        const jitterDelay = vi.fn(async () => {});
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: { reconcileLink, removeLink },
            listCurrentLinks,
            restoreFollowPolicy,
            pauseFollowPolicy,
            startPaused: true,
            jitterDelay,
            isRestoreEnabled: () => true,
        });

        await lifecycle.ready;
        expect(reconcileLink).not.toHaveBeenCalled();
        expect(restoreFollowPolicy).not.toHaveBeenCalled();

        await Promise.all([lifecycle.resume(), lifecycle.resume()]);

        expect(reconcileLink).toHaveBeenCalledWith({
            ...fileBacked,
            demand: {
                passiveEvent: true,
                persistedPolicy: true,
                fallbackDemand: false,
            },
        });
        expect(jitterDelay).toHaveBeenCalledTimes(1);
        expect(listCurrentLinks).toHaveBeenCalledTimes(1);
        expect(restoreFollowPolicy).toHaveBeenCalledTimes(1);
        const reconcileCallOrder = reconcileLink.mock.invocationCallOrder[0]!;
        const restoreCallOrder =
            restoreFollowPolicy.mock.invocationCallOrder[0]!;

        await lifecycle.pause();
        expect(pauseFollowPolicy).toHaveBeenCalledWith('session-1');
        expect(removeLink).toHaveBeenCalledWith(fileBacked.link);
        await lifecycle.dispose();

        expect(reconcileCallOrder).toBeLessThan(restoreCallOrder);
    });

    it('restores grouping-only Codex background follow through canonical descriptor admission', async () => {
        const sessionId = 'session-codex-grouping-restore';
        const source = {
            kind: 'codexHome',
            home: 'user',
            homePath: '/tmp/codex-home',
        } as const;
        const groupingOnly: ExternalSessionObservationLinkInput = {
            resource: {
                pluginId: 'happier.agent.codex',
                agentLocalId: 'codex',
                pluginGeneration: 'plugin-codex-restore',
                resourceKey: '/tmp/codex-home',
            },
            link: {
                sessionId,
                linkGeneration: 'link-codex-restore',
                linkKey: 'codex-thread-restore',
                linkedSource: {
                    source,
                    remoteSessionId: 'codex-thread-restore',
                    linkData: { source },
                },
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    },
                    source: {
                        kind: 'codexHome',
                        contractVersion: 1,
                    },
                },
                linkGeneration: 'link-codex-restore',
            },
        };
        defaultRestoreMocks.readCredentials.mockResolvedValue({
            token: 'token',
            encryption: {
                type: 'legacy',
                secret: new Uint8Array([1]),
            },
        });
        defaultRestoreMocks.loadLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: {
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'codex-thread-restore',
                linkGeneration: 'link-codex-restore',
                source,
                metadata: {},
            },
        });
        defaultRestoreMocks.resolveExternalSessionObservationLinkInput
            .mockResolvedValue(groupingOnly);
        defaultRestoreMocks.resolveGenerationBoundExternalSessionFollowSurface
            .mockResolvedValue({
                providerOps: {
                    pageTranscript: vi.fn(async () => ({
                        items: [],
                        nextCursor: null,
                        tailCursor: 'cursor-codex-restore',
                        hasMore: false,
                        truncated: false,
                    })),
                    readAfterTranscript: vi.fn(async () => ({
                        outcome: 'already_current',
                    })),
                },
                resource: {
                    linkGeneration: 'link-codex-restore',
                    pluginGeneration: 'plugin-codex-restore',
                },
            });
        const transcriptDemand: boolean[] = [];
        const followLeaseManager = createExternalSessionFollowLeaseManager();
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'reconcile-only' })),
                reconcileTranscriptDemand: vi.fn(async (input) => {
                    transcriptDemand.push(input.demanded);
                    return {
                        state: input.demanded ? 'observing' : 'not-demanded',
                    };
                }),
                removeLink: vi.fn(async () => ({ removed: true })),
            },
            followLeaseManager,
            listCurrentLinks: async () => [{
                sessionId,
                observation: groupingOnly,
            }],
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();

        expect(transcriptDemand).toEqual([true]);
        expect(followLeaseManager.hasBackgroundFollowLease(sessionId)).toBe(true);

        await lifecycle.dispose();
        await followLeaseManager.dispose();
        expect(transcriptDemand).toEqual([true, false]);
    });

    it('does zero passive work until the canonical account opt-in is enabled and releases it when disabled', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        const listCurrentLinks = vi.fn(async () => [{
            sessionId: 'session-opt-in',
            observation: resolvedInput('session-opt-in'),
        }]);
        const restoreFollowPolicy = vi.fn(async () => {});
        const disableFollowPolicy = vi.fn(async () => {});
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: { reconcileLink, removeLink },
            listCurrentLinks,
            restoreFollowPolicy,
            pauseFollowPolicy: vi.fn(async () => {}),
            disableFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
        });

        await lifecycle.resume();

        expect(listCurrentLinks).not.toHaveBeenCalled();
        expect(restoreFollowPolicy).not.toHaveBeenCalled();
        expect(reconcileLink).not.toHaveBeenCalled();

        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 1_000,
            settingsSecretsReadKeys: [],
        });
        await vi.waitFor(() => {
            expect(restoreFollowPolicy).toHaveBeenCalledWith(
                'session-opt-in',
                expect.any(AbortSignal),
            );
            expect(reconcileLink).toHaveBeenCalledTimes(1);
        });
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 2,
            loadedAtMs: 2_000,
            settingsSecretsReadKeys: [],
        });
        expect(listCurrentLinks).toHaveBeenCalledTimes(1);

        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(false),
            settingsVersion: 3,
            loadedAtMs: 3_000,
            settingsSecretsReadKeys: [],
        });
        await vi.waitFor(() => {
            expect(disableFollowPolicy).toHaveBeenCalledWith('session-opt-in');
            expect(removeLink).toHaveBeenCalledWith(
                resolvedInput('session-opt-in').link,
            );
        });

        await lifecycle.dispose();
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 4,
            loadedAtMs: 4_000,
            settingsSecretsReadKeys: [],
        });
        expect(listCurrentLinks).toHaveBeenCalledTimes(1);
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('hard-releases prior-account manager state before a rejected new-account inventory', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 4,
            loadedAtMs: 1_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-a',
        });
        let activeAccount: 'a' | 'b' = 'a';
        let rejectAccountBInventory: ((error: Error) => void) | undefined;
        const accountBInventory = new Promise<never>((_resolve, reject) => {
            rejectAccountBInventory = reject;
        });
        const listCurrentLinks = vi.fn(async () => {
            if (activeAccount === 'b') return await accountBInventory;
            const sessionId = 'session-account-a';
            return [{
                sessionId,
                observation: resolvedInput(sessionId),
            }];
        });
        const releaseAccountAFollow = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager();
        const restoreFollowPolicy = vi.fn(async (sessionId: string) => {
            await manager.setBackgroundFollowEnabled({
                sessionId,
                enabled: true,
                resource: {
                    linkGeneration: 'link-1',
                    pluginGeneration: 'plugin-1',
                },
                acquireFollowLease: async () => ({
                    release: releaseAccountAFollow,
                }),
            });
        });
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: { reconcileLink, removeLink },
            listCurrentLinks,
            restoreFollowPolicy,
            pauseFollowPolicy: vi.fn(async () => {}),
            releaseFollowSession: async (sessionId) => {
                await manager.releaseSession({ sessionId });
            },
            startPaused: true,
            jitterDelay: async () => {},
        });

        await lifecycle.resume();
        expect(listCurrentLinks).toHaveBeenCalledTimes(1);
        expect(reconcileLink).toHaveBeenLastCalledWith({
            ...resolvedInput('session-account-a'),
            demand: {
                passiveEvent: true,
                persistedPolicy: true,
                fallbackDemand: false,
            },
        });

        activeAccount = 'b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 2_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-b',
        });

        await vi.waitFor(() => {
            expect(listCurrentLinks).toHaveBeenCalledTimes(2);
            expect(releaseAccountAFollow).toHaveBeenCalledOnce();
            expect(manager.isBackgroundFollowEnabled('session-account-a')).toBe(false);
            expect(removeLink).toHaveBeenCalledWith(
                resolvedInput('session-account-a').link,
            );
        });
        rejectAccountBInventory?.(new Error('account B inventory unavailable'));
        await vi.waitFor(() => {
            expect(reconcileLink).toHaveBeenCalledTimes(1);
        });

        await lifecycle.dispose();
        await manager.dispose();
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('hard-releases credential-bound work and reacquires only from a later valid inventory', async () => {
        let credentialInvalidationListener: (() => void) | undefined;
        const detachCredentialInvalidations = vi.fn();
        let credentialAvailable = true;
        let includeLatePersistedPolicy = false;
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const lateFirstRelease = vi.fn(async () => {});
        const lateSecondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const acquireLateFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: lateFirstRelease })
            .mockResolvedValueOnce({ release: lateSecondRelease });
        const manager = createExternalSessionFollowLeaseManager();
        const sessionId = 'session-credential-bound';
        const lateSessionId = 'session-late-credential-bound';
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const reconcileSharedCredentialDemand = vi.fn(async () => {});
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: { reconcileLink, removeLink },
            followLeaseManager: manager,
            listCurrentLinks: async () => credentialAvailable
                ? [
                    { sessionId, observation: resolvedInput(sessionId) },
                    ...(includeLatePersistedPolicy
                        ? [{
                            sessionId: lateSessionId,
                            observation: resolvedInput(lateSessionId),
                        }]
                        : []),
                ]
                : [],
            restoreFollowPolicy: async (restoredSessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId: restoredSessionId,
                    enabled: true,
                    resource: {
                        linkGeneration: 'link-1',
                        pluginGeneration: credentialAvailable
                            ? `plugin-${acquireFollowLease.mock.calls.length + 1}`
                            : 'plugin-unavailable',
                    },
                    acquireFollowLease: restoredSessionId === lateSessionId
                        ? acquireLateFollowLease
                        : acquireFollowLease,
                });
            },
            releaseFollowSession: async (releasedSessionId) => {
                await manager.releaseSession({ sessionId: releasedSessionId });
            },
            pauseFollowPolicy: async (pausedSessionId) => {
                await manager.suspendSession({
                    sessionId: pausedSessionId,
                    reason: 'daemon_disconnected',
                });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({
                subscribeConnectedAccountInvalidations: (listener: () => void) => {
                    credentialInvalidationListener = listener;
                    return detachCredentialInvalidations;
                },
                reconcileSharedCredentialDemand,
            } as object),
        });

        await lifecycle.resume();
        expect(acquireFollowLease).toHaveBeenCalledOnce();
        expect(reconcileLink).toHaveBeenCalledOnce();
        includeLatePersistedPolicy = true;
        await manager.setBackgroundFollowEnabled({
            sessionId: lateSessionId,
            enabled: true,
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: 'plugin-late-1',
            },
            acquireFollowLease: acquireLateFollowLease,
        });
        expect(acquireLateFollowLease).toHaveBeenCalledOnce();

        credentialAvailable = false;
        credentialInvalidationListener?.();
        await vi.waitFor(() => {
            expect(firstRelease).toHaveBeenCalledOnce();
            expect(lateFirstRelease).toHaveBeenCalledOnce();
            expect(removeLink).toHaveBeenCalledOnce();
            expect(reconcileSharedCredentialDemand).toHaveBeenCalledOnce();
        });
        expect(acquireFollowLease).toHaveBeenCalledOnce();
        expect(reconcileLink).toHaveBeenCalledOnce();
        expect(manager.isBackgroundFollowEnabled(sessionId)).toBe(false);
        expect(manager.isBackgroundFollowEnabled(lateSessionId)).toBe(false);

        credentialAvailable = true;
        credentialInvalidationListener?.();
        await vi.waitFor(() => {
            expect(acquireFollowLease).toHaveBeenCalledTimes(2);
            expect(acquireLateFollowLease).toHaveBeenCalledTimes(2);
            expect(reconcileLink).toHaveBeenCalledTimes(3);
        });
        expect(firstRelease).toHaveBeenCalledOnce();
        expect(secondRelease).not.toHaveBeenCalled();
        expect(lateFirstRelease).toHaveBeenCalledOnce();
        expect(lateSecondRelease).not.toHaveBeenCalled();

        await lifecycle.dispose();
        expect(detachCredentialInvalidations).toHaveBeenCalledOnce();
        expect(secondRelease).toHaveBeenCalledOnce();
        expect(lateSecondRelease).toHaveBeenCalledOnce();
        await manager.dispose();
    });

    it('awaits and hard-releases a late stale restore before starting the next account inventory', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 1_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-a',
        });
        let activeAccount: 'a' | 'b' = 'a';
        let finishAccountARestore: (() => void) | undefined;
        const accountARestoreBarrier = new Promise<void>((resolve) => {
            finishAccountARestore = resolve;
        });
        const accountARestoreStarted = vi.fn();
        const accountBInventoryStarted = vi.fn();
        const releaseFollowSession = vi.fn(async () => {});
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => {
                if (activeAccount === 'b') {
                    accountBInventoryStarted();
                    return [];
                }
                return [{
                    sessionId: 'session-account-a-late',
                    observation: resolvedInput('session-account-a-late'),
                }];
            },
            restoreFollowPolicy: async () => {
                accountARestoreStarted();
                await accountARestoreBarrier;
            },
            pauseFollowPolicy: vi.fn(async () => {}),
            releaseFollowSession,
            startPaused: true,
            jitterDelay: async () => {},
        });

        const initialRestore = lifecycle.resume();
        await vi.waitFor(() => {
            expect(accountARestoreStarted).toHaveBeenCalledOnce();
        });
        activeAccount = 'b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 2_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-b',
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(accountBInventoryStarted).not.toHaveBeenCalled();

        finishAccountARestore?.();
        await initialRestore;
        await vi.waitFor(() => {
            expect(releaseFollowSession).toHaveBeenCalledWith(
                'session-account-a-late',
            );
            expect(accountBInventoryStarted).toHaveBeenCalledOnce();
        });
        expect(reconcileLink).not.toHaveBeenCalled();

        await lifecycle.dispose();
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('serializes rapid account rotations and inventories only the latest scope', async () => {
        resetActiveAccountSettingsSnapshotForTests();
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 1_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-a',
        });
        let activeAccount: 'a' | 'b' | 'c' = 'a';
        const inventoriedAccounts: string[] = [];
        const releaseFollowSession = vi.fn(async () => {});
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => {
                inventoriedAccounts.push(activeAccount);
                return [{
                    sessionId: `session-account-${activeAccount}`,
                    observation: resolvedInput(`session-account-${activeAccount}`),
                }];
            },
            restoreFollowPolicy: vi.fn(async () => {}),
            pauseFollowPolicy: vi.fn(async () => {}),
            releaseFollowSession,
            startPaused: true,
            jitterDelay: async () => {},
        });
        await lifecycle.resume();

        activeAccount = 'b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 2_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-b',
        });
        activeAccount = 'c';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsWithPassiveRestore(true),
            settingsVersion: 1,
            loadedAtMs: 3_000,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-c',
        });

        await vi.waitFor(() => {
            expect(inventoriedAccounts).toEqual(['a', 'c']);
        });
        expect(releaseFollowSession).toHaveBeenCalledTimes(1);
        expect(releaseFollowSession).toHaveBeenCalledWith('session-account-a');

        await lifecycle.dispose();
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('fences a stale inventory callback after disconnect and performs zero restore work', async () => {
        let resolveInventory!: (
            links: readonly ExternalSessionObservationLinkInput[],
        ) => void;
        const inventory = new Promise<readonly ExternalSessionObservationLinkInput[]>((resolve) => {
            resolveInventory = resolve;
        });
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const restoreFollowPolicy = vi.fn(async () => {});
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: false as const })),
            },
            listCurrentLinks: async () => (await inventory).map((observation) => ({
                sessionId: observation.link.sessionId,
                observation,
            })),
            restoreFollowPolicy,
            pauseFollowPolicy: vi.fn(async () => {}),
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        const resume = lifecycle.resume();
        await lifecycle.pause();
        resolveInventory([resolvedInput('session-stale')]);
        await resume;

        expect(reconcileLink).not.toHaveBeenCalled();
        expect(restoreFollowPolicy).not.toHaveBeenCalled();
        await lifecycle.dispose();
    });

    it('releases a follower whose restore completes after archive cleanup', async () => {
        let resolveRestore!: () => void;
        const restoreBarrier = new Promise<void>((resolve) => {
            resolveRestore = resolve;
        });
        let actualFollower = false;
        const restoreStarted = vi.fn();
        const releaseFollowSession = vi.fn(async () => {
            actualFollower = false;
        });
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: false as const })),
            },
            listCurrentLinks: async () => [{
                sessionId: 'session-archived-during-restore',
                observation: resolvedInput('session-archived-during-restore'),
            }],
            restoreFollowPolicy: async () => {
                restoreStarted();
                await restoreBarrier;
                actualFollower = true;
            },
            pauseFollowPolicy: vi.fn(async () => {}),
            releaseFollowSession,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        const resume = lifecycle.resume();
        await vi.waitFor(() => {
            expect(restoreStarted).toHaveBeenCalledOnce();
        });
        const release = lifecycle.releaseSession('session-archived-during-restore');
        resolveRestore();
        await Promise.all([resume, release]);

        expect(actualFollower).toBe(false);
        expect(releaseFollowSession).toHaveBeenCalledTimes(2);
        expect(reconcileLink).not.toHaveBeenCalled();
        await lifecycle.dispose();
    });

    it('pauses manager-owned archive state and keeps a failed release visible for retry', async () => {
        const release = vi.fn()
            .mockRejectedValueOnce(new Error('secret release failure'))
            .mockResolvedValueOnce(undefined);
        const writeFollowStatus = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager({
            now: () => 43_000,
            writeFollowStatus,
        });
        await manager.setBackgroundFollowEnabled({
            sessionId: 'session-archive-release-retry',
            enabled: true,
            acquireFollowLease,
        });
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: false as const })),
            },
            followLeaseManager: manager,
            restoreFollowPolicy: async (sessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    acquireFollowLease,
                });
                return true;
            },
            listCurrentLinks: async () => [],
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({
                loadCurrentSessionPolicy: async () => ({
                    state: 'active',
                    observation: resolvedInput(
                        'session-archive-release-retry',
                    ),
                }),
            } as object),
        });

        await lifecycle.resume();
        await lifecycle.releaseSession('session-archive-release-retry');

        expect(manager.isBackgroundFollowEnabled('session-archive-release-retry')).toBe(true);
        expect(manager.hasBackgroundFollowLease('session-archive-release-retry')).toBe(true);
        expect(manager.isSessionSuspended({
            sessionId: 'session-archive-release-retry',
            reason: 'session_archived',
        })).toBe(true);
        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-archive-release-retry',
            followStatusV1: {
                v: 1,
                status: 'error',
                reason: 'lease_release_failed',
                updatedAtMs: 43_000,
            },
            lastFollowIssueV1: {
                v: 1,
                code: 'follow_lease_release_failed',
                retryable: true,
                observedAtMs: 43_000,
            },
        });

        await lifecycle.reconcileSession('session-archive-release-retry');

        expect(release).toHaveBeenCalledTimes(2);
        expect(manager.isBackgroundFollowEnabled('session-archive-release-retry')).toBe(true);
        expect(manager.hasBackgroundFollowLease('session-archive-release-retry')).toBe(true);
        expect(manager.isSessionSuspended({
            sessionId: 'session-archive-release-retry',
            reason: 'session_archived',
        })).toBe(false);
        expect(writeFollowStatus).toHaveBeenLastCalledWith({
            sessionId: 'session-archive-release-retry',
            followStatusV1: {
                v: 1,
                status: 'active',
                reason: 'background_follow',
                updatedAtMs: 43_000,
            },
        });

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('clears archive suspension after reconnect restores the current active background policy', async () => {
        const sessionId = 'session-archive-external-unarchive-reconnect';
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager();
        const restoreFollowPolicy = vi.fn(async (restoredSessionId: string) => {
            await manager.setBackgroundFollowEnabled({
                sessionId: restoredSessionId,
                enabled: true,
                acquireFollowLease,
            });
            await manager.resumeSession({
                sessionId: restoredSessionId,
                reason: 'daemon_disconnected',
            });
            return true;
        });
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({
                    state: 'observing' as const,
                })),
                removeLink: vi.fn(async () => ({
                    removed: true as const,
                })),
            },
            followLeaseManager: manager,
            listCurrentLinks: async () => [{
                sessionId,
                observation: resolvedInput(sessionId),
            }],
            restoreFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        expect(acquireFollowLease).toHaveBeenCalledOnce();
        await lifecycle.releaseSession(sessionId);
        expect(manager.isSessionSuspended({
            sessionId,
            reason: 'session_archived',
        })).toBe(true);
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(false);

        await lifecycle.pause();
        await lifecycle.resume();

        expect(restoreFollowPolicy).toHaveBeenCalledTimes(2);
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(manager.isSessionSuspended({
            sessionId,
            reason: 'session_archived',
        })).toBe(false);
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(true);

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('retries failed archive release custody before reconnect clears archive suspension', async () => {
        const sessionId = 'session-archive-failed-release-reconnect';
        const release = vi.fn()
            .mockRejectedValueOnce(new Error('secret release failure'))
            .mockResolvedValue(undefined);
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager();
        const restoreFollowPolicy = vi.fn(async (restoredSessionId: string) => {
            await manager.setBackgroundFollowEnabled({
                sessionId: restoredSessionId,
                enabled: true,
                acquireFollowLease,
            });
            await manager.resumeSession({
                sessionId: restoredSessionId,
                reason: 'daemon_disconnected',
            });
            return true;
        });
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({
                    state: 'observing' as const,
                })),
                removeLink: vi.fn(async () => ({
                    removed: true as const,
                })),
            },
            followLeaseManager: manager,
            listCurrentLinks: async () => [{
                sessionId,
                observation: resolvedInput(sessionId),
            }],
            restoreFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        await lifecycle.releaseSession(sessionId);
        expect(release).toHaveBeenCalledOnce();
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(true);
        expect(manager.isSessionSuspended({
            sessionId,
            reason: 'session_archived',
        })).toBe(true);

        await lifecycle.pause();
        await lifecycle.resume();

        expect(release).toHaveBeenCalledTimes(2);
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(manager.isSessionSuspended({
            sessionId,
            reason: 'session_archived',
        })).toBe(false);
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(true);

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('disables a follower whose restore completes after the account opt-in is revoked', async () => {
        let resolveRestore!: () => void;
        const restoreBarrier = new Promise<void>((resolve) => {
            resolveRestore = resolve;
        });
        let restoreEnabled = true;
        let settingsListener!: () => void;
        let actualFollower = false;
        const restoreStarted = vi.fn();
        const disableFollowPolicy = vi.fn(async () => {
            actualFollower = false;
        });
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: false as const })),
            },
            listCurrentLinks: async () => [{
                sessionId: 'session-disabled-during-restore',
                observation: resolvedInput('session-disabled-during-restore'),
            }],
            restoreFollowPolicy: async () => {
                restoreStarted();
                await restoreBarrier;
                actualFollower = true;
            },
            pauseFollowPolicy: vi.fn(async () => {}),
            disableFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => restoreEnabled,
            subscribeRestoreEnabled: (listener) => {
                settingsListener = listener;
                return () => {};
            },
        });

        const resume = lifecycle.resume();
        await vi.waitFor(() => {
            expect(restoreStarted).toHaveBeenCalledOnce();
        });
        restoreEnabled = false;
        settingsListener();
        resolveRestore();
        await resume;

        await vi.waitFor(() => {
            expect(actualFollower).toBe(false);
            expect(disableFollowPolicy).toHaveBeenCalledWith(
                'session-disabled-during-restore',
            );
        });
        expect(reconcileLink).not.toHaveBeenCalled();
        await lifecycle.dispose();
    });

    it('bounds passive policy restoration concurrency at eight', async () => {
        let active = 0;
        let peak = 0;
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: false as const })),
            },
            listCurrentLinks: async () => Array.from({ length: 17 }, (_, index) => ({
                sessionId: `session-${index}`,
                observation: null,
            })),
            restoreFollowPolicy: async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                active -= 1;
            },
            pauseFollowPolicy: vi.fn(async () => {}),
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();

        expect(peak).toBe(8);
        await lifecycle.dispose();
    });

    it('removes a persisted desired follower when the policy disappears while disconnected', async () => {
        let policies: readonly {
            sessionId: string;
            observation: ExternalSessionObservationLinkInput | null;
        }[] = [{
            sessionId: 'session-removed-offline',
            observation: resolvedInput('session-removed-offline'),
        }];
        const disableFollowPolicy = vi.fn(async () => {});
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => policies,
            restoreFollowPolicy: vi.fn(async () => {}),
            pauseFollowPolicy: vi.fn(async () => {}),
            disableFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        await lifecycle.pause();
        policies = [];
        await lifecycle.resume();

        expect(disableFollowPolicy).toHaveBeenCalledWith('session-removed-offline');
        await lifecycle.dispose();
    });

    it('reacquires the one manager-owned follower after a connectivity suspension', async () => {
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const manager = createExternalSessionFollowLeaseManager();
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => [{
                sessionId: 'session-connectivity',
                observation: null,
            }],
            restoreFollowPolicy: async (sessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    resource: {
                        linkGeneration: 'link-1',
                        pluginGeneration: 'plugin-1',
                    },
                    acquireFollowLease,
                });
                await manager.resumeSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            pauseFollowPolicy: async (sessionId) => {
                await manager.suspendSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            disableFollowPolicy: async (sessionId) => {
                await manager.releaseSession({ sessionId });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await lifecycle.pause();
        expect(firstRelease).toHaveBeenCalledTimes(1);

        await lifecycle.resume();
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(secondRelease).not.toHaveBeenCalled();

        await lifecycle.dispose();
        await manager.dispose();
        expect(secondRelease).toHaveBeenCalledTimes(1);
    });

    it('keeps takeover suspension authoritative across passive pause and restore', async () => {
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const manager = createExternalSessionFollowLeaseManager();
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => [{
                sessionId: 'session-takeover-restore',
                observation: null,
            }],
            restoreFollowPolicy: async (sessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    resource: {
                        linkGeneration: 'link-1',
                        pluginGeneration: 'plugin-1',
                    },
                    acquireFollowLease,
                });
                await manager.resumeSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            pauseFollowPolicy: async (sessionId) => {
                await manager.suspendSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await manager.suspendSession({
            sessionId: 'session-takeover-restore',
            reason: 'takeover',
        });
        expect(firstRelease).toHaveBeenCalledOnce();
        await lifecycle.pause();
        await lifecycle.resume();

        expect(manager.isSessionSuspended({
            sessionId: 'session-takeover-restore',
            reason: 'takeover',
        })).toBe(true);
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        await manager.resumeSession({
            sessionId: 'session-takeover-restore',
            reason: 'takeover',
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(2);
        expect(secondRelease).not.toHaveBeenCalled();

        await lifecycle.dispose();
        await manager.dispose();
        expect(secondRelease).toHaveBeenCalledOnce();
    });

    it('re-resolves persisted passive demand once after a plugin runtime generation reload', async () => {
        let pluginGeneration = 'plugin-generation-1';
        let runtimeReloadListener: (() => void) | undefined;
        const detachRuntimeReload = vi.fn();
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const manager = createExternalSessionFollowLeaseManager();
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const listCurrentLinks = vi.fn(async () => [{
            sessionId: 'session-reload',
            observation: {
                ...resolvedInput('session-reload'),
                resource: {
                    ...resolvedInput('session-reload').resource,
                    pluginGeneration,
                },
            },
        }]);
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks,
            restoreFollowPolicy: async (sessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    resource: {
                        linkGeneration: 'link-1',
                        pluginGeneration,
                    },
                    acquireFollowLease,
                });
                await manager.resumeSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            pauseFollowPolicy: async (sessionId) => {
                await manager.suspendSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            subscribeRuntimeReload: (listener) => {
                runtimeReloadListener = listener;
                return detachRuntimeReload;
            },
        });

        await lifecycle.resume();
        expect(listCurrentLinks).toHaveBeenCalledTimes(1);
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);
        expect(reconcileLink).toHaveBeenLastCalledWith(expect.objectContaining({
            resource: expect.objectContaining({
                pluginGeneration: 'plugin-generation-1',
            }),
        }));

        pluginGeneration = 'plugin-generation-2';
        runtimeReloadListener?.();

        await vi.waitFor(() => {
            expect(listCurrentLinks).toHaveBeenCalledTimes(2);
            expect(acquireFollowLease).toHaveBeenCalledTimes(2);
            expect(reconcileLink).toHaveBeenLastCalledWith(expect.objectContaining({
                resource: expect.objectContaining({
                    pluginGeneration: 'plugin-generation-2',
                }),
            }));
        });
        expect(firstRelease).toHaveBeenCalledTimes(1);
        expect(secondRelease).not.toHaveBeenCalled();

        await lifecycle.dispose();
        expect(detachRuntimeReload).toHaveBeenCalledTimes(1);
        expect(secondRelease).toHaveBeenCalledTimes(1);
        runtimeReloadListener?.();
        await Promise.resolve();
        expect(listCurrentLinks).toHaveBeenCalledTimes(2);
        await manager.dispose();
        expect(secondRelease).toHaveBeenCalledTimes(1);
    });

    it('hard-releases observation and follow work when reload makes the persisted plugin source unavailable', async () => {
        let pluginGeneration: string | null = 'plugin-generation-1';
        let runtimeReloadListener: (() => void) | undefined;
        const firstRelease = vi.fn(async () => {});
        const secondRelease = vi.fn(async () => {});
        const acquireFollowLease = vi.fn()
            .mockResolvedValueOnce({ release: firstRelease })
            .mockResolvedValueOnce({ release: secondRelease });
        const manager = createExternalSessionFollowLeaseManager();
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const listCurrentLinks = vi.fn(async () => [{
            sessionId: 'session-unavailable-reload',
            observation: pluginGeneration
                ? {
                    ...resolvedInput('session-unavailable-reload'),
                    resource: {
                        ...resolvedInput('session-unavailable-reload').resource,
                        pluginGeneration,
                    },
                }
                : null,
        }]);
        const restoreFollowPolicy = vi.fn(async (sessionId: string) => {
            if (!pluginGeneration) {
                throw new Error('plugin source unavailable');
            }
            await manager.setBackgroundFollowEnabled({
                sessionId,
                enabled: true,
                resource: {
                    linkGeneration: 'link-1',
                    pluginGeneration,
                },
                acquireFollowLease,
            });
            await manager.resumeSession({
                sessionId,
                reason: 'daemon_disconnected',
            });
        });
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink,
            },
            listCurrentLinks,
            restoreFollowPolicy,
            pauseFollowPolicy: async (sessionId) => {
                await manager.suspendSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            releaseFollowSession: async (sessionId) => {
                await manager.releaseSession({ sessionId });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            subscribeRuntimeReload: (listener) => {
                runtimeReloadListener = listener;
                return () => {};
            },
        });

        await lifecycle.resume();
        const firstObservation = {
            ...resolvedInput('session-unavailable-reload'),
            resource: {
                ...resolvedInput('session-unavailable-reload').resource,
                pluginGeneration: 'plugin-generation-1',
            },
        };
        expect(reconcileLink).toHaveBeenCalledWith(expect.objectContaining({
            resource: expect.objectContaining({
                pluginGeneration: 'plugin-generation-1',
            }),
        }));

        pluginGeneration = null;
        runtimeReloadListener?.();
        await vi.waitFor(() => {
            expect(listCurrentLinks).toHaveBeenCalledTimes(2);
            expect(firstRelease).toHaveBeenCalledOnce();
            expect(removeLink).toHaveBeenCalledWith(firstObservation.link);
        });
        expect(restoreFollowPolicy).toHaveBeenCalledTimes(1);
        expect(reconcileLink).toHaveBeenCalledTimes(1);
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);
        expect(manager.isBackgroundFollowEnabled('session-unavailable-reload')).toBe(false);

        pluginGeneration = 'plugin-generation-2';
        runtimeReloadListener?.();
        await vi.waitFor(() => {
            expect(listCurrentLinks).toHaveBeenCalledTimes(3);
            expect(acquireFollowLease).toHaveBeenCalledTimes(2);
            expect(reconcileLink).toHaveBeenLastCalledWith(expect.objectContaining({
                resource: expect.objectContaining({
                    pluginGeneration: 'plugin-generation-2',
                }),
            }));
        });
        expect(firstRelease).toHaveBeenCalledOnce();
        expect(secondRelease).not.toHaveBeenCalled();

        await lifecycle.dispose();
        await manager.dispose();
        expect(firstRelease).toHaveBeenCalledOnce();
        expect(secondRelease).toHaveBeenCalledOnce();
    });

    it('keeps an unchanged runtime reload on the existing follower resource', async () => {
        let runtimeReloadListener: (() => void) | undefined;
        const release = vi.fn(async () => {});
        const acquireFollowLease = vi.fn(async () => ({ release }));
        const manager = createExternalSessionFollowLeaseManager();
        const listCurrentLinks = vi.fn(async () => [{
            sessionId: 'session-unchanged-reload',
            observation: resolvedInput('session-unchanged-reload'),
        }]);
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks,
            restoreFollowPolicy: async (sessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId,
                    enabled: true,
                    resource: {
                        linkGeneration: 'link-1',
                        pluginGeneration: 'plugin-generation-1',
                    },
                    acquireFollowLease,
                });
                await manager.resumeSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            pauseFollowPolicy: async (sessionId) => {
                await manager.suspendSession({
                    sessionId,
                    reason: 'daemon_disconnected',
                });
            },
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            subscribeRuntimeReload: (listener) => {
                runtimeReloadListener = listener;
                return () => {};
            },
        });

        await lifecycle.resume();
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);

        runtimeReloadListener?.();
        await vi.waitFor(() => {
            expect(listCurrentLinks).toHaveBeenCalledTimes(2);
            expect(reconcileLink).toHaveBeenCalledTimes(2);
        });
        expect(acquireFollowLease).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();

        await lifecycle.dispose();
        await manager.dispose();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('serializes a reload restore behind stale in-flight passive work', async () => {
        let pluginGeneration = 'plugin-generation-1';
        let runtimeReloadListener: (() => void) | undefined;
        let finishFirstRestore: (() => void) | undefined;
        const firstRestoreBarrier = new Promise<void>((resolve) => {
            finishFirstRestore = resolve;
        });
        let activeRestores = 0;
        let peakActiveRestores = 0;
        const restoreFollowPolicy = vi.fn(async () => {
            activeRestores += 1;
            peakActiveRestores = Math.max(peakActiveRestores, activeRestores);
            if (restoreFollowPolicy.mock.calls.length === 1) {
                await firstRestoreBarrier;
            }
            activeRestores -= 1;
        });
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => [{
                sessionId: 'session-reload-in-flight',
                observation: {
                    ...resolvedInput('session-reload-in-flight'),
                    resource: {
                        ...resolvedInput('session-reload-in-flight').resource,
                        pluginGeneration,
                    },
                },
            }],
            restoreFollowPolicy,
            pauseFollowPolicy: vi.fn(async () => {}),
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            subscribeRuntimeReload: (listener) => {
                runtimeReloadListener = listener;
                return () => {};
            },
        });

        const initialRestore = lifecycle.resume();
        await vi.waitFor(() => {
            expect(restoreFollowPolicy).toHaveBeenCalledTimes(1);
        });
        pluginGeneration = 'plugin-generation-2';
        runtimeReloadListener?.();
        await Promise.resolve();
        expect(restoreFollowPolicy).toHaveBeenCalledTimes(1);

        finishFirstRestore?.();
        await initialRestore;
        await vi.waitFor(() => {
            expect(restoreFollowPolicy).toHaveBeenCalledTimes(2);
        });

        expect(peakActiveRestores).toBe(1);
        expect(reconcileLink).toHaveBeenCalledTimes(1);
        expect(reconcileLink).toHaveBeenCalledWith(expect.objectContaining({
            resource: expect.objectContaining({
                pluginGeneration: 'plugin-generation-2',
            }),
        }));
        await lifecycle.dispose();
    });

    it('exactly restores an archived-at-bootstrap background policy after unarchive without duplicate acquisition', async () => {
        const sessionId = 'session-archived-at-bootstrap';
        const acquireFollowLease = vi.fn(async () => ({
            release: vi.fn(async () => {}),
        }));
        const manager = createExternalSessionFollowLeaseManager();
        const restoreFollowPolicy = vi.fn(async (restoredSessionId: string) => {
            await manager.setBackgroundFollowEnabled({
                sessionId: restoredSessionId,
                enabled: true,
                resource: {
                    linkGeneration: 'link-1',
                    pluginGeneration: 'plugin-1',
                },
                acquireFollowLease,
            });
        });
        const loadCurrentSessionPolicy = vi.fn(async () => ({
            state: 'active',
            observation: resolvedInput(sessionId),
        }));
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => [],
            restoreFollowPolicy,
            followLeaseManager: manager,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({ loadCurrentSessionPolicy } as object),
        });

        await lifecycle.resume();
        expect(acquireFollowLease).not.toHaveBeenCalled();

        const exactLifecycle = lifecycle as typeof lifecycle & Readonly<{
            reconcileSession(sessionId: string): Promise<{
                status: 'settled' | 'unavailable' | 'stale';
            }>;
        }>;
        await exactLifecycle.reconcileSession(sessionId);
        await exactLifecycle.reconcileSession(sessionId);

        expect(loadCurrentSessionPolicy).toHaveBeenCalledTimes(2);
        expect(restoreFollowPolicy).toHaveBeenCalledTimes(2);
        expect(acquireFollowLease).toHaveBeenCalledOnce();
        expect(reconcileLink).toHaveBeenCalledTimes(2);
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(true);

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('classifies archived exact state before resolving observation or plugin work', async () => {
        defaultRestoreMocks.readCredentials.mockResolvedValue({
            token: 'token',
            encryption: {
                type: 'legacy',
                secret: new Uint8Array([1]),
            },
        });
        const rawSession = {
            id: 'session-exact-archived',
            archivedAt: 3_000,
        };
        defaultRestoreMocks.loadPersistedLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-archived',
                linkGeneration: 'link-archived',
                source: {
                    kind: 'opencodeServer',
                    directory: '/tmp/project',
                },
                metadata: {
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-archived',
                        source: {
                            kind: 'opencodeServer',
                            directory: '/tmp/project',
                        },
                        linkedAtMs: 1_000,
                        followPolicyV1: {
                            v: 1,
                            policy: 'background_follow',
                            updatedAtMs: 2_000,
                        },
                    },
                },
                rawSession,
            },
        });
        const manager = createExternalSessionFollowLeaseManager();
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            followLeaseManager: manager,
            listCurrentLinks: async () => [],
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        await lifecycle.reconcileSession('session-exact-archived');

        expect(
            defaultRestoreMocks.loadPersistedLinkedExternalSession,
        ).toHaveBeenCalledOnce();
        expect(
            defaultRestoreMocks.loadLinkedExternalSessionFromRaw,
        ).not.toHaveBeenCalled();
        expect(
            defaultRestoreMocks.resolveExternalSessionObservationLinkInput,
        ).not.toHaveBeenCalled();
        expect(
            defaultRestoreMocks.resolveGenerationBoundExternalSessionFollowSurface,
        ).not.toHaveBeenCalled();
        expect(manager.isBackgroundFollowEnabled(
            'session-exact-archived',
        )).toBe(true);
        expect(manager.isSessionSuspended({
            sessionId: 'session-exact-archived',
            reason: 'session_archived',
        })).toBe(true);
        expect(manager.hasBackgroundFollowLease(
            'session-exact-archived',
        )).toBe(false);

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('classifies disabled exact state without resolving an Agent runtime surface', async () => {
        defaultRestoreMocks.readCredentials.mockResolvedValue({
            token: 'token',
            encryption: {
                type: 'legacy',
                secret: new Uint8Array([1]),
            },
        });
        const rawSession = {
            id: 'session-exact-disabled',
        };
        defaultRestoreMocks.loadPersistedLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: {
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-disabled',
                linkGeneration: 'link-disabled',
                source: {
                    kind: 'opencodeServer',
                    directory: '/tmp/project',
                },
                metadata: {
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-disabled',
                        source: {
                            kind: 'opencodeServer',
                            directory: '/tmp/project',
                        },
                        linkedAtMs: 1_000,
                        followPolicyV1: {
                            v: 1,
                            policy: 'attached_only',
                            updatedAtMs: 2_000,
                        },
                    },
                },
                rawSession,
            },
        });
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({
                    state: 'observing' as const,
                })),
                removeLink: vi.fn(async () => ({
                    removed: true as const,
                })),
            },
            listCurrentLinks: async () => [],
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        await expect(
            lifecycle.reconcileSession('session-exact-disabled'),
        ).resolves.toEqual({ status: 'settled' });

        expect(
            defaultRestoreMocks.loadLinkedExternalSessionFromRaw,
        ).not.toHaveBeenCalled();
        expect(
            defaultRestoreMocks.resolveExternalSessionObservationLinkInput,
        ).not.toHaveBeenCalled();
        expect(
            defaultRestoreMocks.resolveGenerationBoundExternalSessionFollowSurface,
        ).not.toHaveBeenCalled();

        await lifecycle.dispose();
    });

    it('keeps an archived source suspended when exact current observation resolution returns null', async () => {
        const sessionId = 'session-exact-observation-unavailable';
        defaultRestoreMocks.readCredentials.mockResolvedValue({
            token: 'token',
            encryption: {
                type: 'legacy',
                secret: new Uint8Array([1]),
            },
        });
        const rawSession = {
            id: sessionId,
        };
        const persistedSession = {
            agentId: 'opencode' as const,
            machineId: 'machine-1',
            remoteSessionId: 'remote-observation-unavailable',
            linkGeneration: 'link-observation-unavailable',
            source: {
                kind: 'opencodeServer' as const,
                directory: '/tmp/project',
            },
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-observation-unavailable',
                    source: {
                        kind: 'opencodeServer',
                        directory: '/tmp/project',
                    },
                    linkedAtMs: 1_000,
                    followPolicyV1: {
                        v: 1,
                        policy: 'background_follow',
                        updatedAtMs: 2_000,
                    },
                },
            },
            rawSession,
        };
        defaultRestoreMocks.loadPersistedLinkedExternalSession
            .mockResolvedValue({
                ok: true,
                session: persistedSession,
            });
        defaultRestoreMocks.loadLinkedExternalSessionFromRaw
            .mockResolvedValue({
                ok: true,
                session: persistedSession,
            });
        defaultRestoreMocks.resolveExternalSessionObservationLinkInput
            .mockResolvedValue(null);
        const acquireFollowLease = vi.fn(async () => ({
            release: vi.fn(async () => {}),
        }));
        const manager = createExternalSessionFollowLeaseManager();
        await manager.setBackgroundFollowEnabled({
            sessionId,
            enabled: true,
            acquireFollowLease,
        });
        await manager.archiveSession({
            sessionId,
            preserveBackgroundFollow: true,
        });
        acquireFollowLease.mockClear();
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({
                    state: 'observing' as const,
                })),
                removeLink: vi.fn(async () => ({
                    removed: true as const,
                })),
            },
            followLeaseManager: manager,
            listCurrentLinks: async () => [],
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
        });

        await lifecycle.resume();
        await expect(lifecycle.reconcileSession(sessionId)).resolves.toEqual({
            status: 'unavailable',
        });

        expect(manager.isSessionSuspended({
            sessionId,
            reason: 'session_archived',
        })).toBe(true);
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(false);
        expect(acquireFollowLease).not.toHaveBeenCalled();

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('skips exact reconciliation work when passive restore is globally disabled', async () => {
        const loadCurrentSessionPolicy = vi.fn(async () => ({
            state: 'active' as const,
            observation: resolvedInput('session-global-disabled'),
        }));
        const restoreFollowPolicy = vi.fn(async () => {});
        const reconcileLink = vi.fn(async () => ({
            state: 'observing' as const,
        }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({
                    removed: true as const,
                })),
            },
            listCurrentLinks: async () => [],
            loadCurrentSessionPolicy,
            restoreFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => false,
        });

        await lifecycle.resume();
        await expect(
            lifecycle.reconcileSession('session-global-disabled'),
        ).resolves.toEqual({ status: 'stale' });

        expect(loadCurrentSessionPolicy).not.toHaveBeenCalled();
        expect(restoreFollowPolicy).not.toHaveBeenCalled();
        expect(reconcileLink).not.toHaveBeenCalled();

        await lifecycle.dispose();
    });

    it('awaits exact-session Disable projection removal before reporting reconciliation settled', async () => {
        const sessionId = 'session-disable-settlement';
        const releaseFollowLease = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager();
        let finishProjectionRemoval!: () => void;
        const projectionRemoval = new Promise<void>((resolve) => {
            finishProjectionRemoval = resolve;
        });
        const removeLink = vi.fn(async () => {
            await projectionRemoval;
            return { removed: true as const };
        });
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink,
            },
            listCurrentLinks: async () => [{
                sessionId,
                observation: resolvedInput(sessionId),
            }],
            restoreFollowPolicy: async (restoredSessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId: restoredSessionId,
                    enabled: true,
                    resource: {
                        linkGeneration: 'link-1',
                        pluginGeneration: 'plugin-1',
                    },
                    acquireFollowLease: async () => ({
                        release: releaseFollowLease,
                    }),
                });
            },
            followLeaseManager: manager,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({
                loadCurrentSessionPolicy: async () => ({
                    state: 'disabled',
                }),
            } as object),
        });

        await lifecycle.resume();
        const exactLifecycle = lifecycle as typeof lifecycle & Readonly<{
            reconcileSession(sessionId: string): Promise<{
                status: 'settled' | 'unavailable' | 'stale';
            }>;
        }>;
        let settled = false;
        const reconcile = exactLifecycle.reconcileSession(sessionId)
            .then(() => {
                settled = true;
            });

        await vi.waitFor(() => {
            expect(removeLink).toHaveBeenCalledWith(resolvedInput(sessionId).link);
        });
        expect(settled).toBe(false);
        expect(releaseFollowLease).toHaveBeenCalledOnce();
        expect(manager.isBackgroundFollowEnabled(sessionId)).toBe(false);

        finishProjectionRemoval();
        await reconcile;
        expect(settled).toBe(true);

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('retains current follow and projection custody when exact policy loading is unavailable', async () => {
        const sessionId = 'session-exact-policy-unavailable';
        const releaseFollowLease = vi.fn(async () => {});
        const manager = createExternalSessionFollowLeaseManager();
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink: vi.fn(async () => ({ state: 'observing' as const })),
                removeLink,
            },
            listCurrentLinks: async () => [{
                sessionId,
                observation: resolvedInput(sessionId),
            }],
            restoreFollowPolicy: async (restoredSessionId) => {
                await manager.setBackgroundFollowEnabled({
                    sessionId: restoredSessionId,
                    enabled: true,
                    acquireFollowLease: async () => ({
                        release: releaseFollowLease,
                    }),
                });
            },
            followLeaseManager: manager,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({
                loadCurrentSessionPolicy: async () => ({
                    state: 'unavailable',
                }),
            } as object),
        });

        await lifecycle.resume();
        await expect(lifecycle.reconcileSession(sessionId)).resolves.toEqual({
            status: 'unavailable',
        });

        expect(manager.isBackgroundFollowEnabled(sessionId)).toBe(true);
        expect(manager.hasBackgroundFollowLease(sessionId)).toBe(true);
        expect(releaseFollowLease).not.toHaveBeenCalled();
        expect(removeLink).not.toHaveBeenCalled();

        await lifecycle.dispose();
        await manager.dispose();
    });

    it('fences an exact-session completion invalidated by account generation', async () => {
        const sessionId = 'session-stale-exact-reconcile';
        let credentialInvalidationListener: (() => void) | undefined;
        let finishExactLoad!: () => void;
        const exactLoadBarrier = new Promise<void>((resolve) => {
            finishExactLoad = resolve;
        });
        const exactLoadStarted = vi.fn();
        const restoreFollowPolicy = vi.fn(async () => {});
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => [],
            restoreFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            subscribeConnectedAccountInvalidations: (listener) => {
                credentialInvalidationListener = listener;
                return () => {};
            },
            ...({
                loadCurrentSessionPolicy: async () => {
                    exactLoadStarted();
                    await exactLoadBarrier;
                    return {
                        state: 'active',
                        observation: resolvedInput(sessionId),
                    };
                },
            } as object),
        });

        await lifecycle.resume();
        const exactLifecycle = lifecycle as typeof lifecycle & Readonly<{
            reconcileSession(sessionId: string): Promise<{
                status: 'settled' | 'unavailable' | 'stale';
            }>;
        }>;
        const reconcile = exactLifecycle.reconcileSession(sessionId);
        await vi.waitFor(() => {
            expect(exactLoadStarted).toHaveBeenCalledOnce();
        });
        credentialInvalidationListener?.();
        finishExactLoad();
        await reconcile;

        expect(restoreFollowPolicy).not.toHaveBeenCalled();
        expect(reconcileLink).not.toHaveBeenCalled();

        await lifecycle.dispose();
    });

    it('fences an in-flight exact-session completion when connectivity goes offline', async () => {
        const sessionId = 'session-exact-offline';
        let finishExactLoad!: () => void;
        const exactLoadBarrier = new Promise<void>((resolve) => {
            finishExactLoad = resolve;
        });
        const exactLoadStarted = vi.fn();
        const restoreFollowPolicy = vi.fn(async () => {});
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: {
                reconcileLink,
                removeLink: vi.fn(async () => ({ removed: true as const })),
            },
            listCurrentLinks: async () => [],
            restoreFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({
                loadCurrentSessionPolicy: async () => {
                    exactLoadStarted();
                    await exactLoadBarrier;
                    return {
                        state: 'active',
                        observation: resolvedInput(sessionId),
                    };
                },
            } as object),
        });

        await lifecycle.resume();
        const reconcile = lifecycle.reconcileSession(sessionId);
        await vi.waitFor(() => {
            expect(exactLoadStarted).toHaveBeenCalledOnce();
        });
        const pause = lifecycle.pause();
        finishExactLoad();
        await Promise.all([reconcile, pause]);

        expect(restoreFollowPolicy).not.toHaveBeenCalled();
        expect(reconcileLink).not.toHaveBeenCalled();
        await lifecycle.dispose();
    });

    it('awaits and fences an in-flight exact-session completion during disposal', async () => {
        const sessionId = 'session-exact-dispose';
        let finishExactLoad!: () => void;
        const exactLoadBarrier = new Promise<void>((resolve) => {
            finishExactLoad = resolve;
        });
        const exactLoadStarted = vi.fn();
        const restoreFollowPolicy = vi.fn(async () => {});
        const reconcileLink = vi.fn(async () => ({ state: 'observing' as const }));
        const removeLink = vi.fn(async () => ({ removed: true as const }));
        const lifecycle = startExternalSessionPassiveObservation({
            machineId: 'machine-1',
            projection: { reconcileLink, removeLink },
            listCurrentLinks: async () => [],
            restoreFollowPolicy,
            startPaused: true,
            jitterDelay: async () => {},
            isRestoreEnabled: () => true,
            ...({
                loadCurrentSessionPolicy: async () => {
                    exactLoadStarted();
                    await exactLoadBarrier;
                    return {
                        state: 'active',
                        observation: resolvedInput(sessionId),
                    };
                },
            } as object),
        });

        await lifecycle.resume();
        const reconcile = lifecycle.reconcileSession(sessionId);
        await vi.waitFor(() => {
            expect(exactLoadStarted).toHaveBeenCalledOnce();
        });
        let disposeSettled = false;
        const dispose = lifecycle.dispose().then(() => {
            disposeSettled = true;
        });
        await Promise.resolve();
        expect(disposeSettled).toBe(false);

        finishExactLoad();
        await Promise.all([reconcile, dispose]);

        expect(restoreFollowPolicy).not.toHaveBeenCalled();
        expect(reconcileLink).not.toHaveBeenCalled();
        expect(removeLink).not.toHaveBeenCalled();
        expect(disposeSettled).toBe(true);
    });
});
