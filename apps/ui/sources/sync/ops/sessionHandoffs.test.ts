import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const resumeSessionMock = vi.hoisted(() => vi.fn());
const machineStopSessionMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn());
const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const followUpSpawnedSessionWithServerScopeMock = vi.hoisted(() => vi.fn());
const waitForSessionHandoffTargetSessionActiveMock = vi.hoisted(() => vi.fn());
const readSessionHandoffSessionActivityMock = vi.hoisted(() => vi.fn());
const stabilizeSessionHandoffTargetBindingMock = vi.hoisted(() => vi.fn());
const storageGetStateMock = vi.hoisted(() => vi.fn());
const storageApplySessionsMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('./sessionMachineTarget', () => ({
    readMachineTargetForSession: readMachineTargetForSessionMock,
    shouldFallbackFromMachineRpc: (error: unknown) =>
        error instanceof Error
        && (
            error.message.includes('Machine encryption not found')
            || error.message.includes('Socket not connected')
            || error.message.includes('Scoped RPC socket connection timeout')
            || error.message.includes('Scoped RPC socket connection failed')
        ),
}));

vi.mock('../api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

vi.mock('./sessions', () => ({
    resumeSession: resumeSessionMock,
}));

vi.mock('./machines', () => ({
    machineStopSession: (...args: unknown[]) => machineStopSessionMock(...args),
}));

vi.mock('../sync', () => ({
    sync: {
        patchSessionMetadataWithRetry: (...args: unknown[]) => patchSessionMetadataWithRetryMock(...args),
        ensureSessionVisibleForMessageRoute: (...args: unknown[]) => ensureSessionVisibleForMessageRouteMock(...args),
    },
}));

vi.mock('../runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: (...args: unknown[]) => followUpSpawnedSessionWithServerScopeMock(...args),
}));

vi.mock('../domains/sessionHandoff/waitForSessionHandoffTargetSessionActive', () => ({
    waitForSessionHandoffTargetSessionActive: (...args: unknown[]) => waitForSessionHandoffTargetSessionActiveMock(...args),
}));

vi.mock('../domains/sessionHandoff/readSessionHandoffSessionActivity', () => ({
    readSessionHandoffSessionActivity: (...args: unknown[]) => readSessionHandoffSessionActivityMock(...args),
}));

vi.mock('../domains/sessionHandoff/stabilizeSessionHandoffTargetBinding', () => ({
    stabilizeSessionHandoffTargetBinding: (...args: unknown[]) => stabilizeSessionHandoffTargetBindingMock(...args),
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: (...args: unknown[]) => storageGetStateMock(...args),
    },
}));

describe('sessionHandoffs ops', () => {
    beforeEach(() => {
        vi.resetModules();
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
            if (input?.method === 'daemon.sessionHandoff.commit') {
                const handoffId = typeof input?.payload?.handoffId === 'string' ? input.payload.handoffId : 'handoff_unknown';
                return {
                    handoffId,
                    status: {
                        handoffId,
                        status: 'completed',
                        phase: 'finalizing',
                        recoveryActions: [],
                    },
                };
            }
            throw new Error(`Unexpected machineRpcWithServerScope call: ${String(input?.method ?? '')}`);
        });
        readMachineTargetForSessionMock.mockReset();
        getServerFeaturesSnapshotMock.mockReset();
        resumeSessionMock.mockReset();
        machineStopSessionMock.mockReset();
        patchSessionMetadataWithRetryMock.mockReset();
        ensureSessionVisibleForMessageRouteMock.mockReset();
        followUpSpawnedSessionWithServerScopeMock.mockReset();
        waitForSessionHandoffTargetSessionActiveMock.mockReset();
        readSessionHandoffSessionActivityMock.mockReset();
        stabilizeSessionHandoffTargetBindingMock.mockReset();
        storageGetStateMock.mockReset();
        storageApplySessionsMock.mockReset();
        readMachineTargetForSessionMock.mockReturnValue(null);
        machineStopSessionMock.mockResolvedValue({ ok: true });
        ensureSessionVisibleForMessageRouteMock.mockResolvedValue(undefined);
        followUpSpawnedSessionWithServerScopeMock.mockResolvedValue(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockResolvedValue({ ok: true });
        readSessionHandoffSessionActivityMock.mockReturnValue({ active: true });
        stabilizeSessionHandoffTargetBindingMock.mockImplementation(async (params: {
            readSession: () => { active?: boolean } | null | undefined;
            readTargetMachineId: () => string | null;
            reapplyOptimisticBinding: () => void;
            targetMachineId: string;
        }) => {
            let stablePollCount = 0;
            for (let attempt = 0; attempt < 4; attempt += 1) {
                const alreadyStable =
                    params.readSession()?.active === true
                    && params.readTargetMachineId() === params.targetMachineId;
                if (alreadyStable) {
                    stablePollCount += 1;
                    if (stablePollCount >= 2) {
                        return { ok: true } as const;
                    }
                } else {
                    stablePollCount = 0;
                    params.reapplyOptimisticBinding();
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (stablePollCount === 0) {
                params.reapplyOptimisticBinding();
            }
            return { ok: true } as const;
        });
        storageGetStateMock.mockReturnValue({
            sessions: {},
            applySessions: (...args: unknown[]) => storageApplySessionsMock(...args),
        });
    });

    it('routes startSessionHandoff through server-scoped machine rpc with the source machine id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            handoffId: 'handoff_1',
            status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
            endpointCandidates: [],
            handoffMetadataV2: {},
            targetPath: '/repo',
        });

        const { startSessionHandoff } = await import('./sessionHandoffs');
        const result = await startSessionHandoff({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
            serverId: 'server_b',
            sourceStartRetry: {
                timeoutMs: 0,
                intervalMs: 0,
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_1',
            status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
            endpointCandidates: [],
            handoffMetadataV2: {},
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.start',
            serverId: 'server_b',
            timeoutMs: expect.any(Number),
            payload: expect.objectContaining({
                sessionId: 'sess_1',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                sessionStorageMode: 'persisted',
                preferredTransportStrategies: ['direct_peer'],
            }),
        }));
        const call = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        expect(call.timeoutMs).toBe(90_000);
    }, 60_000);

    it('maps macOS /Users/<user> paths into the target machine homeDir when preparing a Linux target', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });

        storageGetStateMock.mockReturnValue({
            sessions: {},
            machines: {
                machine_source: {
                    id: 'machine_source',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    metadataVersion: 1,
                    metadata: {
                        host: 'source-host',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/Users/leeroy/.happy-dev',
                        homeDir: '/Users/leeroy',
                    },
                    daemonState: null,
                    daemonStateVersion: 1,
                },
                machine_target: {
                    id: 'machine_target',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    metadataVersion: 1,
                    metadata: {
                        host: 'target-host',
                        platform: 'linux',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/home/guest/.happy-dev',
                        homeDir: '/home/guest',
                    },
                    daemonState: null,
                    daemonStateVersion: 1,
                },
            },
            applySessions: (...args: unknown[]) => storageApplySessionsMock(...args),
        });

        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_linux_map',
                status: { handoffId: 'handoff_linux_map', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {},
                targetPath: '/Users/leeroy/wsrepl-large',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_linux_map',
                status: {
                    handoffId: 'handoff_linux_map',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    recoveryActions: [],
                },
                remoteSessionId: 'remote_session_linux_map',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/home/guest/wsrepl-large',
                    agent: 'claude',
                    resume: 'remote_session_linux_map',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_linux_map',
                status: {
                    handoffId: 'handoff_linux_map',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });

        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_linux_map' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_linux_map',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/Users/leeroy/wsrepl-large',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_linux_map',
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                targetPath: '/home/guest/wsrepl-large',
            }),
        }));
    });

    it('maps Linux /home/<user> paths into the target machine homeDir when preparing a macOS target', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });

        storageGetStateMock.mockReturnValue({
            sessions: {},
            machines: {
                machine_source: {
                    id: 'machine_source',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    metadataVersion: 1,
                    metadata: {
                        host: 'source-host',
                        platform: 'linux',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/home/guest/.happy-dev',
                        homeDir: '/home/guest',
                    },
                    daemonState: null,
                    daemonStateVersion: 1,
                },
                machine_target: {
                    id: 'machine_target',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    metadataVersion: 1,
                    metadata: {
                        host: 'target-host',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/Users/leeroy/.happy-dev',
                        homeDir: '/Users/leeroy',
                    },
                    daemonState: null,
                    daemonStateVersion: 1,
                },
            },
            applySessions: (...args: unknown[]) => storageApplySessionsMock(...args),
        });

        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_darwin_map',
                status: { handoffId: 'handoff_darwin_map', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {},
                targetPath: '/home/guest/wsrepl-large',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_darwin_map',
                status: {
                    handoffId: 'handoff_darwin_map',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    recoveryActions: [],
                },
                remoteSessionId: 'remote_session_darwin_map',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/Users/leeroy/wsrepl-large',
                    agent: 'claude',
                    resume: 'remote_session_darwin_map',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_darwin_map',
                status: {
                    handoffId: 'handoff_darwin_map',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });

        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_darwin_map' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_darwin_map',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/home/guest/wsrepl-large',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_darwin_map',
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                targetPath: '/Users/leeroy/wsrepl-large',
            }),
        }));
    });

    it('uses the previous source workspace root when handing back to the prior source machine (sync_changes target path override)', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });

        storageGetStateMock.mockReturnValue({
            sessions: {},
            machines: {
                machine_source: {
                    id: 'machine_source',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    metadataVersion: 1,
                    metadata: {
                        host: 'source-host',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/Users/leeroy/.happy-dev',
                        homeDir: '/Users/leeroy',
                    },
                    daemonState: null,
                    daemonStateVersion: 1,
                },
                machine_target: {
                    id: 'machine_target',
                    seq: 1,
                    createdAt: 0,
                    updatedAt: 0,
                    active: true,
                    activeAt: 0,
                    metadataVersion: 1,
                    metadata: {
                        host: 'target-host',
                        platform: 'linux',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/home/guest/.happy-dev',
                        homeDir: '/home/guest',
                    },
                    daemonState: null,
                    daemonStateVersion: 1,
                },
            },
            applySessions: (...args: unknown[]) => storageApplySessionsMock(...args),
        });

        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_back',
                status: { handoffId: 'handoff_back', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {},
                targetPath: '/home/guest/wsrepl-large-replication-9',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_back',
                status: {
                    handoffId: 'handoff_back',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    recoveryActions: [],
                },
                remoteSessionId: 'remote_session_back',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/Users/leeroy/wsrepl-large',
                    agent: 'claude',
                    resume: 'remote_session_back',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_back',
                status: {
                    handoffId: 'handoff_back',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });

        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_back' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_back',
            sourceMachineId: 'machine_target',
            targetMachineId: 'machine_source',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'create_sibling_copy',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
            sourceMetadata: {
                flavor: 'claude',
                path: '/home/guest/wsrepl-large-replication-9',
                host: 'target-host',
                machineId: 'machine_target',
                claudeSessionId: 'claude_session_back',
                handoffV1: {
                    v: 1,
                    sourceMachineId: 'machine_source',
                    targetMachineId: 'machine_target',
                    providerId: 'claude',
                    sessionStorageBefore: 'persisted',
                    sessionStorageAfter: 'persisted',
                    transportStrategy: 'server_routed_stream',
                    completedAtMs: 1,
                    sourceWorkspaceRootPath: '/Users/leeroy/wsrepl-large',
                    targetWorkspaceRootPath: '/home/guest/wsrepl-large-replication-9',
                },
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                targetPath: '/Users/leeroy/wsrepl-large',
            }),
        }));
    });

    it('uses the daemon-supplied handoff-back target root when available (sync_changes target path override)', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });

        // Simulate a non-hydrated session store so the override must come from the daemon hint.
        storageGetStateMock.mockReturnValue({
            sessions: {},
            machines: {},
            applySessions: (...args: unknown[]) => storageApplySessionsMock(...args),
        });

        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_back_daemon_hint',
                status: { handoffId: 'handoff_back_daemon_hint', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    workspaceReplicationHandoffBackTargetRootPath: '/Users/leeroy/wsrepl-large',
                },
                targetPath: '/home/guest/wsrepl-large-replication-9',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_back_daemon_hint',
                status: {
                    handoffId: 'handoff_back_daemon_hint',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    recoveryActions: [],
                },
                remoteSessionId: 'remote_session_back_daemon_hint',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/Users/leeroy/wsrepl-large',
                    agent: 'claude',
                    resume: 'remote_session_back_daemon_hint',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_back_daemon_hint',
                status: {
                    handoffId: 'handoff_back_daemon_hint',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });

        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_back_daemon_hint' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_back_daemon_hint',
            sourceMachineId: 'machine_target',
            targetMachineId: 'machine_source',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'create_sibling_copy',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
            sourceMetadata: {
                flavor: 'claude',
                path: '/home/guest/wsrepl-large-replication-9',
                host: 'target-host',
                machineId: 'machine_target',
                claudeSessionId: 'claude_session_back',
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                targetPath: '/Users/leeroy/wsrepl-large',
            }),
        }));
    });

    it('targets the original source workspace root when handing back with sync_changes even if the stored handoff target machine id mismatches', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });

        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_back_mismatch',
                status: { handoffId: 'handoff_back_mismatch', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {},
                targetPath: '/home/guest/wsrepl-large-replication-9',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_back_mismatch',
                status: {
                    handoffId: 'handoff_back_mismatch',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    recoveryActions: [],
                },
                remoteSessionId: 'remote_session_back_mismatch',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/Users/leeroy/wsrepl-large',
                    agent: 'claude',
                    resume: 'remote_session_back_mismatch',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_back_mismatch',
                status: {
                    handoffId: 'handoff_back_mismatch',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });

        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_back_mismatch' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_back_mismatch',
            sourceMachineId: 'machine_target',
            targetMachineId: 'machine_source',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'create_sibling_copy',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
            sourceMetadata: {
                flavor: 'claude',
                path: '/home/guest/wsrepl-large-replication-9',
                host: 'target-host',
                machineId: 'machine_target',
                claudeSessionId: 'claude_session_back',
                handoffV1: {
                    v: 1,
                    sourceMachineId: 'machine_source',
                    // Simulate drift/mismatch: targetMachineId is no longer the current source machine.
                    targetMachineId: 'some_other_machine',
                    providerId: 'claude',
                    sessionStorageBefore: 'persisted',
                    sessionStorageAfter: 'persisted',
                    transportStrategy: 'server_routed_stream',
                    completedAtMs: 1,
                    sourceWorkspaceRootPath: '/Users/leeroy/wsrepl-large',
                    targetWorkspaceRootPath: '/home/guest/wsrepl-large-replication-9',
                },
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                targetPath: '/Users/leeroy/wsrepl-large',
            }),
        }));
    });

    it('publishes handoff progress updates while target prepare is pending and when the handoff completes', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_progress',
                status: {
                    handoffId: 'handoff_progress',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_progress',
                status: {
                    handoffId: 'handoff_progress',
                    jobId: 'job_progress',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'not_found',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_progress',
                status: {
                    handoffId: 'handoff_progress',
                    jobId: 'job_progress',
                    status: 'pending',
                    phase: 'staging_target',
                    workspacePreflightSummary: {
                        addedPathsCount: 3,
                        changedPathsCount: 2,
                        removedPathsCount: 1,
                        totalBytes: 2048,
                    },
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'transfer_blobs',
                        planned: {
                            totalFiles: 6,
                            totalBytes: 2048,
                        },
                        transferred: {
                            files: 3,
                            bytes: 1024,
                            blobs: 2,
                        },
                        current: {
                            relativePath: 'README.md',
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_progress',
                status: {
                    handoffId: 'handoff_progress',
                    jobId: 'job_progress',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    workspacePreflightSummary: {
                        addedPathsCount: 3,
                        changedPathsCount: 2,
                        removedPathsCount: 1,
                        totalBytes: 2048,
                    },
                    progress: {
                        updatedAtMs: 456,
                        checkpoint: 'apply',
                        planned: {
                            totalFiles: 6,
                            totalBytes: 2048,
                        },
                        transferred: {
                            files: 6,
                            bytes: 2048,
                            blobs: 3,
                        },
                        current: {
                            relativePath: 'README.md',
                        },
                        resumable: true,
                    },
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_progress',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_progress',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_progress',
                status: {
                    handoffId: 'handoff_progress',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_progress' });
        storageGetStateMock.mockReturnValue({
            sessions: {
                sess_progress: {
                    id: 'sess_progress',
                    metadata: {
                        path: '/repo',
                        machineId: 'machine_source',
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_progress',
                    },
                },
            },
            applySessions: (...args: unknown[]) => storageApplySessionsMock(...args),
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const { subscribeSessionHandoffProgress } = await import('../domains/sessionHandoff/sessionHandoffProgressEvents');

        const seenStatuses: string[] = [];
        const unsubscribe = subscribeSessionHandoffProgress((update) => {
            if (update.sessionId === 'sess_progress' && update.targetMachineId === 'machine_target') {
                const checkpoint = update.status.progress?.checkpoint ?? 'none';
                seenStatuses.push(`${update.status.phase}:${update.status.status}:${checkpoint}`);
            }
        });

        try {
            const result = await completeSessionHandoff({
                sessionId: 'sess_progress',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                serverId: 'server_b',
                sessionStorageMode: 'persisted',
                preferredTransportStrategies: ['server_routed_stream'],
                sourceMetadata: {
                    flavor: 'claude',
                    path: '/repo',
                    host: 'source-host',
                    machineId: 'machine_source',
                    claudeSessionId: 'claude_session_progress',
                },
            });

            expect(result).toEqual({
                ok: true,
                handoffId: 'handoff_progress',
                status: {
                    handoffId: 'handoff_progress',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });
        } finally {
            unsubscribe();
        }

        expect(seenStatuses).toEqual([
            'preparing:pending:none',
            'staging_target:pending:transfer_blobs',
            'staging_target:ready_for_cutover:apply',
            // UI-driven progress must not invent a new checkpoint; keep the daemon-emitted checkpoint.
            'resuming:in_progress:apply',
            'finalizing:completed:none',
        ]);
    });

    it('prefers the reachable machine target from the session over a stale source machine id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            handoffId: 'handoff_1',
            status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
            endpointCandidates: [],
            targetPath: '/repo',
        });
        readMachineTargetForSessionMock.mockReturnValueOnce({ machineId: 'reachable_machine', basePath: '/repo' });

        const { startSessionHandoff } = await import('./sessionHandoffs');
        await startSessionHandoff({
            sessionId: 'sess_1',
            sourceMachineId: 'stale_machine',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'direct',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'reachable_machine',
            payload: expect.objectContaining({
                sourceMachineId: 'reachable_machine',
            }),
        }));
    });

    it('fails closed when generic session target fallback collapses the source onto the selected target machine', async () => {
        readMachineTargetForSessionMock.mockReturnValueOnce({ machineId: 'machine_target', basePath: '/repo' });

        const { startSessionHandoff } = await import('./sessionHandoffs');
        const result = await startSessionHandoff({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'direct',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable source machine target found for session handoff',
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('returns DAEMON_RPC_UNAVAILABLE when the source daemon does not expose handoff rpc', async () => {
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
        );

        const { startSessionHandoff } = await import('./sessionHandoffs');
        const result = await startSessionHandoff({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
            sourceStartRetry: {
                timeoutMs: 0,
                intervalMs: 0,
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            errorMessage: expect.stringContaining('Daemon RPC is not available'),
        });
    });

    it('retries source handoff start when the source daemon rpc is transiently unavailable', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(
                Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
            )
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_source_start',
                status: {
                    handoffId: 'handoff_retry_source_start',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo',
            });

        let nowMs = 0;
        const { startSessionHandoffOnSourceWithRetry } = await import('./sessionHandoffs');
        const result = await startSessionHandoffOnSourceWithRetry({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
        }, {
            timeoutMs: 10,
            intervalMs: 1,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            sourceMachineId: 'machine_source',
            response: {
                handoffId: 'handoff_retry_source_start',
                status: {
                    handoffId: 'handoff_retry_source_start',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo',
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.start',
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.start',
        }));
        const firstStartCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        const secondStartCall = machineRpcWithServerScopeMock.mock.calls[1]?.[0] as any;
        expect(firstStartCall.timeoutMs).toBe(10);
        expect(secondStartCall.timeoutMs).toBe(9);
    });

    it('retries source handoff start when the source machine rpc attempt times out within the retry budget', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(
                Object.assign(new Error('Machine RPC timed out after 10ms while using active scope for daemon.sessionHandoff.start'), {
                    code: 'MACHINE_RPC_TIMEOUT',
                }),
            )
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_source_start_timeout',
                status: {
                    handoffId: 'handoff_retry_source_start_timeout',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo',
            });

        let nowMs = 0;
        const { startSessionHandoffOnSourceWithRetry } = await import('./sessionHandoffs');
        const result = await startSessionHandoffOnSourceWithRetry({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
        }, {
            timeoutMs: 10,
            intervalMs: 1,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            sourceMachineId: 'machine_source',
            response: {
                handoffId: 'handoff_retry_source_start_timeout',
                status: {
                    handoffId: 'handoff_retry_source_start_timeout',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo',
            },
        });
        const firstStartCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        const secondStartCall = machineRpcWithServerScopeMock.mock.calls[1]?.[0] as any;
        expect(firstStartCall.timeoutMs).toBe(10);
        expect(secondStartCall.timeoutMs).toBe(9);
    });

    it('stops retrying source handoff start once the retry budget is consumed during sleep', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
        );

        let nowMs = 0;
        const { startSessionHandoffOnSourceWithRetry } = await import('./sessionHandoffs');
        const result = await startSessionHandoffOnSourceWithRetry({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
        }, {
            timeoutMs: 10,
            intervalMs: 20,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            errorMessage: expect.stringContaining('Daemon RPC is not available'),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        const onlyStartCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        expect(onlyStartCall.timeoutMs).toBe(10);
    });

    it('completes a persisted session handoff by preparing the target, resuming there, patching metadata, committing on the target, then cleaning up the source', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: { workspaceReplicationSourceRootPath: '/Users/leeroy/wsrepl-large' },
                // The prepare-target root can differ cross-platform; reverse-baseline must still
                // target the original source root path (from metadataV2), not this rewritten path.
                targetPath: '/home/guest/wsrepl-large-replication-9',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: {
                    handoffId: 'handoff_1',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_1',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/home/guest/wsrepl-large-replication-9',
                    agent: 'claude',
                    resume: 'claude_session_1',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_1' });
        patchSessionMetadataWithRetryMock.mockImplementationOnce(async (_sessionId: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            const updated = updater({
                flavor: 'claude',
                path: '/repo',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_1',
            });
            expect(updated).toMatchObject({
                machineId: 'machine_target',
                path: '/home/guest/wsrepl-large-replication-9',
                claudeSessionId: 'claude_session_1',
                handoffV1: {
                    sourceMachineId: 'machine_source',
                    targetMachineId: 'machine_target',
                    providerId: 'claude',
                    sessionStorageBefore: 'persisted',
                    sessionStorageAfter: 'persisted',
                    transportStrategy: 'server_routed_stream',
                },
            });
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_1',
            },
            serverId: 'server_b',
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_1',
            status: {
                handoffId: 'handoff_1',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(machineStopSessionMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.start',
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
            preferScoped: true,
            payload: expect.objectContaining({
                sourceMachineId: 'machine_source',
                handoffId: 'handoff_1',
                negotiatedTransportStrategy: 'server_routed_stream',
                allowServerRoutedFallback: true,
                handoffMetadataV2: {
                    workspaceReplicationSourceRootPath: '/Users/leeroy/wsrepl-large',
                },
                targetPath: '/home/guest/wsrepl-large-replication-9',
            }),
        }));
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload).not.toHaveProperty('endpointCandidates');
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload).not.toHaveProperty('workspaceBundle');
        expect(machineStopSessionMock).not.toHaveBeenCalled();
        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_1',
            machineId: 'machine_target',
            directory: '/home/guest/wsrepl-large-replication-9',
            backendTarget: {
                kind: 'builtInAgent',
                agentId: 'claude',
            },
            resume: 'claude_session_1',
            transcriptStorage: 'persisted',
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
            preferRequestedMachineTarget: true,
            preferScopedMachineRpc: true,
            serverId: 'server_b',
        }));
        expect(waitForSessionHandoffTargetSessionActiveMock).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            ensureSessionVisible: expect.any(Function),
            readSession: expect.any(Function),
            readTargetMachineId: expect.any(Function),
            targetMachineId: 'machine_target',
        });
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('sess_1', { forceRefresh: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.commit',
            payload: { handoffId: 'handoff_1', mode: 'target' },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.commit',
            payload: expect.objectContaining({
                handoffId: 'handoff_1',
                mode: 'source_cleanup',
                workspaceReplicationReverseSourceRootPath: '/home/guest/wsrepl-large-replication-9',
                workspaceReplicationReverseTargetRootPath: '/Users/leeroy/wsrepl-large',
            }),
        }));
    });

    it('waits for the best-effort source_cleanup commit before resolving completeSessionHandoff (enables immediate handoff-back planning)', async () => {
        let resolveCleanup: ((value: unknown) => void) | undefined;
        const cleanupPromise = new Promise<unknown>((resolve) => {
            resolveCleanup = resolve;
        });

        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: { workspaceReplicationSourceRootPath: '/Users/leeroy/wsrepl-large' },
                targetPath: '/home/guest/wsrepl-large-replication-9',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: {
                    handoffId: 'handoff_1',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_1',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/home/guest/wsrepl-large-replication-9',
                    agent: 'claude',
                    resume: 'claude_session_1',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_1',
                status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            })
            .mockImplementationOnce(async () => await cleanupPromise);

        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_1' });
        // Make the test prove we're truly blocked on the cleanup promise (not on other retry loops).
        stabilizeSessionHandoffTargetBindingMock.mockResolvedValue({ ok: true });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        let settled = false;
        const promise = completeSessionHandoff({
            sessionId: 'sess_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_1',
            },
            serverId: 'server_b',
        }).then((result) => {
            settled = true;
            return result;
        });

        await vi.waitFor(() => {
            expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(4);
        });
        // If `completeSessionHandoff(...)` does not await the source cleanup commit, it would be
        // free to resolve immediately after issuing the 4th machine RPC.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);

        resolveCleanup?.({
            handoffId: 'handoff_1',
            status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
        });

        await expect(promise).resolves.toMatchObject({
            ok: true,
            handoffId: 'handoff_1',
            status: {
                handoffId: 'handoff_1',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
    });

    it('returns recovery when source handoff start fails after the source session has already been stopped', async () => {
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'source_export_failed',
            error: 'start failed',
            handoffId: 'handoff_start_failure_after_stop',
            status: {
                handoffId: 'handoff_start_failure_after_stop',
                status: 'awaiting_recovery',
                phase: 'preparing',
                recoveryActions: ['restart_on_source', 'keep_stopped'],
            },
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_start_failure_after_stop',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_start_failure_after_stop',
            },
            serverId: 'server_b',
            sourceStartRetry: {
                timeoutMs: 0,
                intervalMs: 0,
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'source_export_failed',
            errorMessage: 'start failed',
            handoffId: 'handoff_start_failure_after_stop',
            status: {
                handoffId: 'handoff_start_failure_after_stop',
                status: 'awaiting_recovery',
                phase: 'preparing',
                recoveryActions: ['restart_on_source', 'keep_stopped'],
            },
            recovery: {
                handoffId: 'handoff_start_failure_after_stop',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_start_failure_after_stop',
                    machineId: 'machine_source',
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_start_failure_after_stop',
                    transcriptStorage: 'persisted',
                    serverId: 'server_b',
                },
            },
        });
        expect(machineStopSessionMock).not.toHaveBeenCalled();
    });

    it('aborts the target before the source when target prepare fails after the source session has already been stopped', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_prepare_failure_after_stop',
                status: { handoffId: 'handoff_prepare_failure_after_stop', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_prepare_failure_after_stop:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_prepare_failure_after_stop',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'target_prepare_failed',
                error: 'prepare failed',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_prepare_failure_after_stop',
                status: { handoffId: 'handoff_prepare_failure_after_stop', status: 'aborted', phase: 'preparing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                            serverRouted: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_prepare_failure_after_stop',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_prepare_failure_after_stop',
            },
            serverId: 'server_b',
            sourceStartRetry: {
                timeoutMs: 0,
                intervalMs: 0,
            },
            targetPrepareRetry: {
                timeoutMs: 0,
                intervalMs: 0,
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'target_prepare_failed',
            errorMessage: 'prepare failed',
            recovery: {
                handoffId: 'handoff_prepare_failure_after_stop',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_prepare_failure_after_stop',
                    machineId: 'machine_source',
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_prepare_failure_after_stop',
                    transcriptStorage: 'persisted',
                    serverId: 'server_b',
                },
            },
        });
        expect(machineStopSessionMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.abort',
            payload: {
                handoffId: 'handoff_prepare_failure_after_stop',
                reason: 'target_prepare_failed',
            },
            serverId: 'server_b',
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.abort',
            payload: {
                handoffId: 'handoff_prepare_failure_after_stop',
                reason: 'target_prepare_failed',
            },
            serverId: 'server_b',
        }));
    });

    it('hydrates the resumed target session through the selected server before waiting for handoff rebinding', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_scoped_refresh',
                status: { handoffId: 'handoff_scoped_refresh', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_scoped_refresh:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_scoped_refresh',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_scoped_refresh',
                status: {
                    handoffId: 'handoff_scoped_refresh',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_scoped_refresh',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_scoped_refresh',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_scoped_refresh',
                status: { handoffId: 'handoff_scoped_refresh', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_scoped_refresh' });
        patchSessionMetadataWithRetryMock.mockImplementationOnce(async (_sessionId: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            updater({
                flavor: 'claude',
                path: '/repo',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_scoped_refresh',
            });
        });
        readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine_source', basePath: '/repo' });
        followUpSpawnedSessionWithServerScopeMock.mockImplementationOnce(async ({ sessionId, targetServerId }) => {
            expect(sessionId).toBe('sess_scoped_refresh');
            expect(targetServerId).toBe('server_b');
            readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine_target', basePath: '/repo' });
        });
        waitForSessionHandoffTargetSessionActiveMock.mockImplementationOnce(async (params: {
            sessionId: string;
            ensureSessionVisible: (sessionId: string) => Promise<void>;
            readSession: () => { active?: boolean } | null;
            readTargetMachineId?: () => string | null;
        }) => {
            await params.ensureSessionVisible(params.sessionId);
            if (params.readSession()?.active === true && params.readTargetMachineId?.() === 'machine_target') {
                return { ok: true };
            }

            return {
                ok: false,
                error: 'Timed out waiting for session handoff target session to become active',
            } as const;
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_scoped_refresh',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_scoped_refresh',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_scoped_refresh',
            status: { handoffId: 'handoff_scoped_refresh', status: 'completed', phase: 'finalizing', recoveryActions: [] },
        });
        expect(followUpSpawnedSessionWithServerScopeMock).toHaveBeenCalledWith({
            sessionId: 'sess_scoped_refresh',
            targetServerId: 'server_b',
        });
    });

    it('optimistically rebinds the local session target before waiting for forced server-routed cutover', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_cutover: {
                    id: 'sess_server_routed_cutover',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_cutover',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_cutover',
                status: { handoffId: 'handoff_server_routed_cutover', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_cutover',
                status: {
                    handoffId: 'handoff_server_routed_cutover',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_cutover',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_cutover',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_cutover',
                status: { handoffId: 'handoff_server_routed_cutover', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_server_routed_cutover' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockImplementationOnce(async (params: {
            readTargetMachineId?: () => string | null;
        }) => {
            expect(params.readTargetMachineId?.()).toBe('machine_target');
            return { ok: true };
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_cutover',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_cutover',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_cutover',
            status: { handoffId: 'handoff_server_routed_cutover', status: 'completed', phase: 'finalizing', recoveryActions: [] },
        });
        expect(storageApplySessionsMock).toHaveBeenCalledWith([
            expect.objectContaining({
                id: 'sess_server_routed_cutover',
                metadata: expect.objectContaining({
                    machineId: 'machine_target',
                    path: '/repo-target',
                }),
            }),
        ]);
    });

    it('reapplies the optimistic local session binding after forced server-routed hydration rewrites the session to the source machine', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_rebind: {
                    id: 'sess_server_routed_rebind',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_rebind',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_rebind',
                status: { handoffId: 'handoff_server_routed_rebind', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_rebind',
                status: {
                    handoffId: 'handoff_server_routed_rebind',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_rebind',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_rebind',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_rebind',
                status: { handoffId: 'handoff_server_routed_rebind', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_server_routed_rebind' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        followUpSpawnedSessionWithServerScopeMock.mockImplementationOnce(async () => {
            storageGetStateMock().applySessions([{
                id: 'sess_server_routed_rebind',
                active: true,
                metadata: {
                    machineId: 'machine_source',
                    path: '/repo',
                    flavor: 'claude',
                    claudeSessionId: 'claude_session_server_routed_rebind',
                },
            }]);
        });
        waitForSessionHandoffTargetSessionActiveMock.mockImplementationOnce(async (params: {
            sessionId: string;
            ensureSessionVisible: (sessionId: string) => Promise<void>;
            readTargetMachineId?: () => string | null;
        }) => {
            await params.ensureSessionVisible(params.sessionId);
            expect(params.readTargetMachineId?.()).toBe('machine_target');
            return { ok: true };
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_rebind',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_rebind',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_rebind',
            status: { handoffId: 'handoff_server_routed_rebind', status: 'completed', phase: 'finalizing', recoveryActions: [] },
        });
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
    });

    it('reapplies the target session binding after post-cutover force refresh rewrites the session to the source machine', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_post_refresh_rebind: {
                    id: 'sess_server_routed_post_refresh_rebind',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_refresh_rebind',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_refresh_rebind',
                status: { handoffId: 'handoff_server_routed_post_refresh_rebind', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_refresh_rebind',
                status: {
                    handoffId: 'handoff_server_routed_post_refresh_rebind',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_post_refresh_rebind',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_post_refresh_rebind',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_refresh_rebind',
                status: { handoffId: 'handoff_server_routed_post_refresh_rebind', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_server_routed_post_refresh_rebind' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockImplementationOnce(async (params: {
            readTargetMachineId?: () => string | null;
        }) => {
            expect(params.readTargetMachineId?.()).toBe('machine_target');
            return { ok: true };
        });
        ensureSessionVisibleForMessageRouteMock.mockImplementationOnce(async () => {
            storageGetStateMock().applySessions([{
                id: 'sess_server_routed_post_refresh_rebind',
                active: true,
                metadata: {
                    machineId: 'machine_source',
                    path: '/repo',
                    flavor: 'claude',
                    claudeSessionId: 'claude_session_server_routed_post_refresh_rebind',
                },
            }]);
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_post_refresh_rebind',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_post_refresh_rebind',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_post_refresh_rebind',
            status: { handoffId: 'handoff_server_routed_post_refresh_rebind', status: 'completed', phase: 'finalizing', recoveryActions: [] },
        });
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
    });

    it('reapplies the target session binding after post-commit force refresh rewrites the session to the source machine', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_post_commit_force_refresh_rebind: {
                    id: 'sess_server_routed_post_commit_force_refresh_rebind',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_force_refresh_rebind',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_post_commit_force_refresh_rebind',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_post_commit_force_refresh_rebind',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess_server_routed_post_commit_force_refresh_rebind',
        });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockResolvedValueOnce({ ok: true });
        let ensureCallCount = 0;
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async () => {
            ensureCallCount += 1;
            if (ensureCallCount === 2) {
                storageGetStateMock().applySessions([{
                    id: 'sess_server_routed_post_commit_force_refresh_rebind',
                    active: true,
                    metadata: {
                        machineId: 'machine_source',
                        path: '/repo',
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_force_refresh_rebind',
                    },
                }]);
            }
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_post_commit_force_refresh_rebind',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_post_commit_force_refresh_rebind',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
            status: {
                handoffId: 'handoff_server_routed_post_commit_force_refresh_rebind',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenNthCalledWith(
            1,
            'sess_server_routed_post_commit_force_refresh_rebind',
            { forceRefresh: true },
        );
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenNthCalledWith(
            2,
            'sess_server_routed_post_commit_force_refresh_rebind',
            { forceRefresh: true },
        );
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
    });

    it('re-stabilizes the target session binding when a late source overwrite lands after the final force refresh', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_post_commit_late_refresh_overwrite: {
                    id: 'sess_server_routed_post_commit_late_refresh_overwrite',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_late_refresh_overwrite',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_late_refresh_overwrite',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_late_refresh_overwrite',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_late_refresh_overwrite',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_late_refresh_overwrite',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_post_commit_late_refresh_overwrite',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_post_commit_late_refresh_overwrite',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_late_refresh_overwrite',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_late_refresh_overwrite',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess_server_routed_post_commit_late_refresh_overwrite',
        });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockResolvedValueOnce({ ok: true });
        let ensureCallCount = 0;
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async () => {
            ensureCallCount += 1;
            if (ensureCallCount === 2) {
                setTimeout(() => {
                    storageGetStateMock().applySessions([{
                        id: 'sess_server_routed_post_commit_late_refresh_overwrite',
                        active: true,
                        metadata: {
                            machineId: 'machine_source',
                            path: '/repo',
                            flavor: 'claude',
                            claudeSessionId: 'claude_session_server_routed_post_commit_late_refresh_overwrite',
                        },
                    }]);
                }, 5);
            }
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_post_commit_late_refresh_overwrite',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_post_commit_late_refresh_overwrite',
            },
        });

        expect(result.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
    });

    it('reapplies the target session binding when a late local source overwrite lands after commit completes', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_post_commit_rebind: {
                    id: 'sess_server_routed_post_commit_rebind',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_rebind',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_rebind',
                status: { handoffId: 'handoff_server_routed_post_commit_rebind', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_rebind',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_rebind',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_post_commit_rebind',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_post_commit_rebind',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockImplementationOnce(async () => {
                setTimeout(() => {
                    storageGetStateMock().applySessions([{
                        id: 'sess_server_routed_post_commit_rebind',
                        active: true,
                        metadata: {
                            machineId: 'machine_source',
                            path: '/repo',
                            flavor: 'claude',
                            claudeSessionId: 'claude_session_server_routed_post_commit_rebind',
                        },
                    }]);
                }, 5);
                return {
                    handoffId: 'handoff_server_routed_post_commit_rebind',
                    status: { handoffId: 'handoff_server_routed_post_commit_rebind', status: 'completed', phase: 'finalizing', recoveryActions: [] },
                };
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_server_routed_post_commit_rebind' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockImplementationOnce(async (params: {
            readTargetMachineId?: () => string | null;
        }) => {
            expect(params.readTargetMachineId?.()).toBe('machine_target');
            return { ok: true };
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_post_commit_rebind',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_post_commit_rebind',
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_post_commit_rebind',
            status: { handoffId: 'handoff_server_routed_post_commit_rebind', status: 'completed', phase: 'finalizing', recoveryActions: [] },
        });
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
    });

    it('re-publishes target metadata after commit when a late authoritative overwrite restores the source machine', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        let authoritativeRemoteMetadata: Record<string, unknown> = {
            flavor: 'claude',
            path: '/repo',
            host: 'source-host',
            machineId: 'machine_source',
            claudeSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
        };
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_post_commit_remote_rebind: {
                    id: 'sess_server_routed_post_commit_remote_rebind',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_remote_rebind',
                status: { handoffId: 'handoff_server_routed_post_commit_remote_rebind', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_remote_rebind',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_remote_rebind',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_post_commit_remote_rebind',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockImplementationOnce(async () => {
                setTimeout(() => {
                    authoritativeRemoteMetadata = {
                        flavor: 'claude',
                        path: '/repo',
                        host: 'source-host',
                        machineId: 'machine_source',
                        claudeSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
                    };
                    storageGetStateMock().applySessions([{
                        id: 'sess_server_routed_post_commit_remote_rebind',
                        active: true,
                        metadata: {
                            machineId: 'machine_source',
                            path: '/repo',
                            flavor: 'claude',
                            claudeSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
                        },
                    }]);
                }, 5);
                return {
                    handoffId: 'handoff_server_routed_post_commit_remote_rebind',
                    status: {
                        handoffId: 'handoff_server_routed_post_commit_remote_rebind',
                        status: 'completed',
                        phase: 'finalizing',
                        recoveryActions: [],
                    },
                };
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_server_routed_post_commit_remote_rebind' });
        patchSessionMetadataWithRetryMock.mockImplementation(async (_sessionId: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            authoritativeRemoteMetadata = updater(authoritativeRemoteMetadata);
        });
        waitForSessionHandoffTargetSessionActiveMock.mockImplementationOnce(async (params: {
            readTargetMachineId?: () => string | null;
        }) => {
            expect(params.readTargetMachineId?.()).toBe('machine_target');
            return { ok: true };
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_post_commit_remote_rebind',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_post_commit_remote_rebind',
            status: {
                handoffId: 'handoff_server_routed_post_commit_remote_rebind',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
        expect(authoritativeRemoteMetadata).toMatchObject({
            machineId: 'machine_target',
            path: '/repo-target',
            claudeSessionId: 'claude_session_server_routed_post_commit_remote_rebind',
            handoffV1: expect.objectContaining({
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                transportStrategy: 'server_routed_stream',
            }),
        });
        expect(patchSessionMetadataWithRetryMock).toHaveBeenCalledTimes(2);
    });

    it('refreshes the session again after commit so the current view picks up active target presence', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        let currentActive = false;
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_post_commit_presence_refresh: {
                    id: 'sess_server_routed_post_commit_presence_refresh',
                    active: currentActive,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_presence_refresh',
                    },
                },
            },
            applySessions: (sessions: Array<{ active?: boolean; metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0];
                if (typeof rebound?.active === 'boolean') {
                    currentActive = rebound.active;
                }
                if (typeof rebound?.metadata?.machineId === 'string') {
                    currentMachineId = rebound.metadata.machineId;
                }
                if (typeof rebound?.metadata?.path === 'string') {
                    currentPath = rebound.metadata.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                    status: 'pending',
                    phase: 'preparing',
                    recoveryActions: [],
                },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_post_commit_presence_refresh',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_post_commit_presence_refresh',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                status: {
                    handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({
            type: 'success',
            sessionId: 'sess_server_routed_post_commit_presence_refresh',
        });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockResolvedValueOnce({ ok: true });
        let ensureCallCount = 0;
        ensureSessionVisibleForMessageRouteMock.mockImplementation(async () => {
            ensureCallCount += 1;
            if (ensureCallCount === 2) {
                storageGetStateMock().applySessions([{
                    id: 'sess_server_routed_post_commit_presence_refresh',
                    active: true,
                    metadata: {
                        machineId: 'machine_target',
                        path: '/repo-target',
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_post_commit_presence_refresh',
                    },
                }]);
            }
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_post_commit_presence_refresh',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_post_commit_presence_refresh',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_server_routed_post_commit_presence_refresh',
            status: {
                handoffId: 'handoff_server_routed_post_commit_presence_refresh',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenNthCalledWith(
            1,
            'sess_server_routed_post_commit_presence_refresh',
            { forceRefresh: true },
        );
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenNthCalledWith(
            2,
            'sess_server_routed_post_commit_presence_refresh',
            { forceRefresh: true },
        );
        expect(currentMachineId).toBe('machine_target');
        expect(currentPath).toBe('/repo-target');
        expect(currentActive).toBe(true);
    });

    it('restores the previous local session binding when forced server-routed cutover waiting throws', async () => {
        let currentMachineId = 'machine_source';
        let currentPath = '/repo';
        readMachineTargetForSessionMock.mockImplementation(() => ({
            machineId: currentMachineId,
            basePath: currentPath,
        }));
        storageGetStateMock.mockImplementation(() => ({
            sessions: {
                sess_server_routed_cutover_throw: {
                    id: 'sess_server_routed_cutover_throw',
                    active: true,
                    metadata: {
                        machineId: currentMachineId,
                        path: currentPath,
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_server_routed_cutover_throw',
                    },
                },
            },
            applySessions: (sessions: Array<{ metadata?: { machineId?: string; path?: string } }>) => {
                storageApplySessionsMock(sessions);
                const rebound = sessions[0]?.metadata;
                if (typeof rebound?.machineId === 'string') {
                    currentMachineId = rebound.machineId;
                }
                if (typeof rebound?.path === 'string') {
                    currentPath = rebound.path;
                }
            },
        }));
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_cutover_throw',
                status: { handoffId: 'handoff_server_routed_cutover_throw', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo-target',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_cutover_throw',
                status: {
                    handoffId: 'handoff_server_routed_cutover_throw',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_server_routed_cutover_throw',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_cutover_throw',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_server_routed_cutover_throw',
                status: { handoffId: 'handoff_server_routed_cutover_throw', status: 'aborted', phase: 'cutover', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_server_routed_cutover_throw' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);
        waitForSessionHandoffTargetSessionActiveMock.mockRejectedValueOnce(new Error('refresh failed'));

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_server_routed_cutover_throw',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            serverId: 'server_b',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_server_routed_cutover_throw',
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'target_session_not_active',
            errorMessage: 'refresh failed',
            recovery: {
                handoffId: 'handoff_server_routed_cutover_throw',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_server_routed_cutover_throw',
                    machineId: 'machine_source',
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_server_routed_cutover_throw',
                    transcriptStorage: 'persisted',
                    serverId: 'server_b',
                },
            },
        });
        expect(currentMachineId).toBe('machine_source');
        expect(currentPath).toBe('/repo');
        expect(storageApplySessionsMock).toHaveBeenNthCalledWith(1, [
            expect.objectContaining({
                id: 'sess_server_routed_cutover_throw',
                metadata: expect.objectContaining({
                    machineId: 'machine_target',
                    path: '/repo-target',
                }),
            }),
        ]);
        expect(storageApplySessionsMock).toHaveBeenNthCalledWith(2, [
            expect.objectContaining({
                id: 'sess_server_routed_cutover_throw',
                metadata: expect.objectContaining({
                    machineId: 'machine_source',
                    path: '/repo',
                }),
            }),
        ]);
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.abort',
            payload: {
                handoffId: 'handoff_server_routed_cutover_throw',
                reason: 'target_session_not_active',
            },
            serverId: 'server_b',
        }));
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('forwards codexBackendMode from the target resume payload when present', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_codex',
                status: { handoffId: 'handoff_codex', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_codex:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_codex',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_codex',
                status: {
                    handoffId: 'handoff_codex',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'codex_session_1',
                directSource: {
                    kind: 'codexHome',
                    home: 'user',
                },
                resume: {
                    directory: '/repo',
                    agent: 'codex',
                    resume: 'codex_session_1',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                    codexBackendMode: 'acp',
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_codex',
                status: { handoffId: 'handoff_codex', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_codex' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_codex',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'codex',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                codexSessionId: 'codex_session_1',
            },
        } as any);

        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_codex',
            machineId: 'machine_target',
            directory: '/repo',
            backendTarget: {
                kind: 'builtInAgent',
                agentId: 'codex',
            },
            resume: 'codex_session_1',
            transcriptStorage: 'persisted',
            codexBackendMode: 'acp',
        }));
    });

    it('prefers target agentRuntimeDescriptorV1 over the resume payload during handoff resume forwarding', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_codex_runtime_descriptor',
                status: { handoffId: 'handoff_codex_runtime_descriptor', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_codex_runtime_descriptor:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_codex_runtime_descriptor',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_codex_runtime_descriptor',
                status: {
                    handoffId: 'handoff_codex_runtime_descriptor',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'codex_session_runtime_descriptor',
                directSource: {
                    kind: 'codexHome',
                    home: 'user',
                },
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        vendorSessionId: 'codex_session_runtime_descriptor',
                    },
                },
                resume: {
                    directory: '/repo',
                    agent: 'codex',
                    resume: 'codex_session_runtime_descriptor',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_codex_runtime_descriptor',
                status: { handoffId: 'handoff_codex_runtime_descriptor', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_codex_runtime_descriptor' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        await completeSessionHandoff({
            sessionId: 'sess_codex_runtime_descriptor',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'codex',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                codexSessionId: 'codex_session_runtime_descriptor',
            },
        } as any);

        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_codex_runtime_descriptor',
            codexBackendMode: 'appServer',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex_session_runtime_descriptor',
                },
            },
        }));
    });

    it('retries target prepare when the target daemon rpc is transiently unavailable', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(
                Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
            )
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare',
                status: {
                    handoffId: 'handoff_retry_prepare',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            });

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            intervalMs: 1,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            response: {
                handoffId: 'handoff_retry_prepare',
                status: {
                    handoffId: 'handoff_retry_prepare',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
            preferScoped: true,
            timeoutMs: expect.any(Number),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
            preferScoped: true,
            timeoutMs: expect.any(Number),
        }));
        const firstPrepareCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        const secondPrepareCall = machineRpcWithServerScopeMock.mock.calls[1]?.[0] as any;
        expect(firstPrepareCall.payload).toMatchObject({ handoffMetadataV2: {} });
        expect(firstPrepareCall.payload).not.toHaveProperty('endpointCandidates');
        expect(secondPrepareCall.payload).toMatchObject({ handoffMetadataV2: {} });
        expect(secondPrepareCall.payload).not.toHaveProperty('endpointCandidates');
        expect(firstPrepareCall.timeoutMs).toBe(10);
        expect(secondPrepareCall.timeoutMs).toBe(9);
    });

    it('fails closed when preparing a cross-machine handoff without handoffMetadataV2', async () => {
        machineRpcWithServerScopeMock.mockImplementation(() => {
            throw new Error('prepareTarget should not be called without handoffMetadataV2');
        });

        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_missing_metadata_v2',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
        }, {
            timeoutMs: 0,
            intervalMs: 0,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'missing_handoff_metadata_v2',
            errorMessage: expect.stringContaining('handoffMetadataV2'),
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('fails closed when preparing a cross-machine server-routed handoff without handoffMetadataV2', async () => {
        machineRpcWithServerScopeMock.mockImplementation(() => {
            throw new Error('prepareTarget should not be called without handoffMetadataV2');
        });

        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_missing_metadata_v2_server_routed',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'server_routed_stream',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
        }, {
            timeoutMs: 0,
            intervalMs: 0,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'missing_handoff_metadata_v2',
            errorMessage: expect.stringContaining('handoffMetadataV2'),
        });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('polls status and result-get when target prepare returns a job-backed ack without the final resume payload', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS = '10000';
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async',
                status: {
                    handoffId: 'handoff_retry_prepare_async',
                    jobId: 'job_prepare_1',
                    status: 'pending',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'not_found',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async',
                status: {
                    handoffId: 'handoff_retry_prepare_async',
                    jobId: 'job_prepare_1',
                    status: 'pending',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async',
                status: {
                    handoffId: 'handoff_retry_prepare_async',
                    jobId: 'job_prepare_1',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_async',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_async',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            });

        let nowMs = 0;
        try {
            const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
            const result = await prepareTargetSessionHandoffWithRetry({
                handoffId: 'handoff_retry_prepare_async',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                targetPath: '/repo',
                negotiatedTransportStrategy: 'direct_peer',
                sourceSessionStorageMode: 'persisted',
                allowServerRoutedFallback: true,
                handoffMetadataV2: {},
            }, {
                timeoutMs: 10,
                intervalMs: 1,
                now: () => nowMs,
                sleep: async (delayMs) => {
                    nowMs += delayMs;
                },
            });

            expect(result).toEqual({
                ok: true,
                response: {
                    handoffId: 'handoff_retry_prepare_async',
                    status: {
                        handoffId: 'handoff_retry_prepare_async',
                        jobId: 'job_prepare_1',
                        status: 'ready_for_cutover',
                        phase: 'staging_target',
                        transportStrategy: 'direct_peer',
                        recoveryActions: [],
                    },
                    remoteSessionId: 'claude_session_retry_prepare_async',
                    directSource: {
                        kind: 'claudeConfig',
                        configDir: null,
                        projectId: null,
                    },
                    resume: {
                        directory: '/repo',
                        agent: 'claude',
                        resume: 'claude_session_retry_prepare_async',
                        transcriptStorage: 'persisted',
                        approvedNewDirectoryCreation: true,
                    },
                },
            });
            expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
                machineId: 'machine_target',
                method: 'daemon.sessionHandoff.prepareTarget',
            }));
            expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
                machineId: 'machine_target',
                method: 'daemon.sessionHandoff.prepareTargetResult.get',
                timeoutMs: 10_000,
            }));
            expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
                machineId: 'machine_target',
                method: 'daemon.sessionHandoff.status.get',
                timeoutMs: 10_000,
            }));
            expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
                machineId: 'machine_target',
                method: 'daemon.sessionHandoff.prepareTargetResult.get',
                timeoutMs: 10_000,
            }));
        } finally {
            delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS;
        }
    });

    it('uses a separate poll timeout budget after a job-backed prepare ack', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async_long_poll',
                status: {
                    handoffId: 'handoff_retry_prepare_async_long_poll',
                    jobId: 'job_prepare_long_poll',
                    status: 'pending',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'not_found',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async_long_poll',
                status: {
                    handoffId: 'handoff_retry_prepare_async_long_poll',
                    jobId: 'job_prepare_long_poll',
                    status: 'pending',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'not_found',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async_long_poll',
                status: {
                    handoffId: 'handoff_retry_prepare_async_long_poll',
                    jobId: 'job_prepare_long_poll',
                    status: 'pending',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_async_long_poll',
                status: {
                    handoffId: 'handoff_retry_prepare_async_long_poll',
                    jobId: 'job_prepare_long_poll',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_async_long_poll',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_async_long_poll',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            });

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare_async_long_poll',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            pollTimeoutMs: 30,
            intervalMs: 6,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            response: {
                handoffId: 'handoff_retry_prepare_async_long_poll',
                status: {
                    handoffId: 'handoff_retry_prepare_async_long_poll',
                    jobId: 'job_prepare_long_poll',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_async_long_poll',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_async_long_poll',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(6, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTargetResult.get',
        }));
    });

    it('does not time out while target prepare progress is still changing (idle timeout semantics)', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            handoffId: 'handoff_retry_prepare_progress_idle_timeout',
            status: {
                handoffId: 'handoff_retry_prepare_progress_idle_timeout',
                jobId: 'job_prepare_progress_idle_timeout',
                status: 'pending',
                phase: 'staging_target',
                transportStrategy: 'direct_peer',
                recoveryActions: [],
                progress: {
                    updatedAtMs: 1,
                    checkpoint: 'stage_target',
                    planned: {},
                    transferred: {},
                    current: { phaseDetail: 'tick_1' },
                    resumable: false,
                },
            },
        });

        // Simulate a long-running prepare where status keeps updating but the final ready payload
        // arrives after the original poll timeout budget.
        for (let i = 2; i <= 8; i += 1) {
            machineRpcWithServerScopeMock.mockResolvedValueOnce({
                ok: false,
                errorCode: 'not_found',
            });
            machineRpcWithServerScopeMock.mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_progress_idle_timeout',
                status: {
                    handoffId: 'handoff_retry_prepare_progress_idle_timeout',
                    jobId: 'job_prepare_progress_idle_timeout',
                    status: 'pending',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                    progress: {
                        updatedAtMs: i,
                        checkpoint: 'stage_target',
                        planned: {},
                        transferred: {},
                        current: { phaseDetail: `tick_${i}` },
                        resumable: false,
                    },
                },
            });
        }

        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            handoffId: 'handoff_retry_prepare_progress_idle_timeout',
            status: {
                handoffId: 'handoff_retry_prepare_progress_idle_timeout',
                jobId: 'job_prepare_progress_idle_timeout',
                status: 'ready_for_cutover',
                phase: 'staging_target',
                transportStrategy: 'direct_peer',
                recoveryActions: [],
            },
            remoteSessionId: 'claude_session_retry_prepare_progress_idle_timeout',
            directSource: {
                kind: 'claudeConfig',
                configDir: null,
                projectId: null,
            },
            resume: {
                directory: '/repo',
                agent: 'claude',
                resume: 'claude_session_retry_prepare_progress_idle_timeout',
                transcriptStorage: 'persisted',
                approvedNewDirectoryCreation: true,
            },
        });

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare_progress_idle_timeout',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            pollTimeoutMs: 30,
            intervalMs: 6,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            response: expect.objectContaining({
                handoffId: 'handoff_retry_prepare_progress_idle_timeout',
                remoteSessionId: 'claude_session_retry_prepare_progress_idle_timeout',
            }),
        });
        expect(nowMs).toBeGreaterThan(30);
    });

    it('retries target prepare when the target machine rpc attempt times out within the retry budget', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(
                Object.assign(new Error('Machine RPC timed out after 10ms while using scoped scope for daemon.sessionHandoff.prepareTarget'), {
                    code: 'MACHINE_RPC_TIMEOUT',
                }),
            )
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_timeout',
                status: {
                    handoffId: 'handoff_retry_prepare_timeout',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_timeout',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_timeout',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            });

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare_timeout',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            intervalMs: 1,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            response: {
                handoffId: 'handoff_retry_prepare_timeout',
                status: {
                    handoffId: 'handoff_retry_prepare_timeout',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_timeout',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_timeout',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            },
        });
        const firstPrepareCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        const secondPrepareCall = machineRpcWithServerScopeMock.mock.calls[1]?.[0] as any;
        expect(firstPrepareCall.timeoutMs).toBe(10);
        expect(secondPrepareCall.timeoutMs).toBe(9);
    });

    it('stops retrying target prepare once the retry budget is consumed during sleep', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
        );

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare_budget_exhausted',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            intervalMs: 20,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'DAEMON_RPC_UNAVAILABLE',
            errorMessage: expect.stringContaining('Daemon RPC is not available'),
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        const onlyPrepareCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0] as any;
        expect(onlyPrepareCall.timeoutMs).toBe(10);
    });

    it('retries target prepare when scoped machine encryption is not ready yet', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('Machine encryption not found for machine_target'))
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_machine_key',
                status: {
                    handoffId: 'handoff_retry_prepare_machine_key',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_machine_key',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_machine_key',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            });

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare_machine_key',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            intervalMs: 1,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            response: {
                handoffId: 'handoff_retry_prepare_machine_key',
                status: {
                    handoffId: 'handoff_retry_prepare_machine_key',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_machine_key',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_machine_key',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('retries target prepare when scoped socket connection has not come up yet', async () => {
        machineRpcWithServerScopeMock
            .mockRejectedValueOnce(new Error('Scoped RPC socket connection timeout'))
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_scoped_socket',
                status: {
                    handoffId: 'handoff_retry_prepare_scoped_socket',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_scoped_socket',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_scoped_socket',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            });

        let nowMs = 0;
        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_retry_prepare_scoped_socket',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 10,
            intervalMs: 1,
            now: () => nowMs,
            sleep: async (delayMs) => {
                nowMs += delayMs;
            },
        });

        expect(result).toEqual({
            ok: true,
            response: {
                handoffId: 'handoff_retry_prepare_scoped_socket',
                status: {
                    handoffId: 'handoff_retry_prepare_scoped_socket',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_scoped_socket',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_scoped_socket',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    });

    it('keeps canonical workspace artifacts across direct-peer prepare retries', async () => {
        const handoffMetadataV2 = {
            providerBundleTransferPublication: {
                transferId: 'transfer_provider_bundle_retry_prepare_artifacts',
                sizeBytes: 3,
                manifestHash: 'sha256:provider_bundle_retry_prepare_artifacts',
                endpointCandidates: [
                    {
                        kind: 'http',
                        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_retry_prepare_artifacts?token=test-token',
                        expiresAt: Date.now() + 30_000,
                    },
                ],
            },
        } as const;
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_artifacts',
                status: { handoffId: 'handoff_retry_prepare_artifacts', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [
                    {
                        kind: 'http',
                        url: 'http://127.0.0.1:46001/session-handoffs/direct-transfer/handoff_retry_prepare_artifacts?token=test-token',
                        expiresAt: Date.now() + 30_000,
                    },
                ],
                handoffMetadataV2,
                targetPath: '/repo',
            })
            .mockRejectedValueOnce(
                Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }),
            )
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_artifacts',
                status: {
                    handoffId: 'handoff_retry_prepare_artifacts',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_retry_prepare_artifacts',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_retry_prepare_artifacts',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_retry_prepare_artifacts',
                status: { handoffId: 'handoff_retry_prepare_artifacts', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_retry_prepare_artifacts' });
        waitForSessionHandoffTargetSessionActiveMock.mockResolvedValueOnce({ ok: true });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        let nowMs = 0;
        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_retry_prepare_artifacts',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_retry_prepare_artifacts',
            },
            targetPrepareRetry: {
                timeoutMs: 10,
                intervalMs: 1,
                now: () => nowMs,
                sleep: async (delayMs) => {
                    nowMs += delayMs;
                },
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_retry_prepare_artifacts',
            status: {
                handoffId: 'handoff_retry_prepare_artifacts',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });

        const firstPrepareCall = machineRpcWithServerScopeMock.mock.calls[1]?.[0] as any;
        const secondPrepareCall = machineRpcWithServerScopeMock.mock.calls[2]?.[0] as any;
        expect(firstPrepareCall.payload).toMatchObject({
            handoffId: 'handoff_retry_prepare_artifacts',
            negotiatedTransportStrategy: 'direct_peer',
            handoffMetadataV2: {
                providerBundleTransferPublication: {
                    endpointCandidates: [
                        expect.objectContaining({
                            kind: 'http',
                        }),
                    ],
                },
            },
        });
        expect(firstPrepareCall.payload).not.toHaveProperty('endpointCandidates');
        expect(secondPrepareCall.payload).toEqual(firstPrepareCall.payload);
    });

    it('surfaces daemon error-only target prepare envelopes instead of reporting an unsupported response', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            error: 'Target handoff import failed',
        });

        const { prepareTargetSessionHandoffWithRetry } = await import('./sessionHandoffs');
        const result = await prepareTargetSessionHandoffWithRetry({
            handoffId: 'handoff_error_only_prepare',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            targetPath: '/repo',
            negotiatedTransportStrategy: 'direct_peer',
            sourceSessionStorageMode: 'persisted',
            allowServerRoutedFallback: true,
            handoffMetadataV2: {},
        }, {
            timeoutMs: 0,
            intervalMs: 0,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: 'Target handoff import failed',
        });
    });

    it('aborts the source handoff when target resume fails after prepare', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_2',
                status: { handoffId: 'handoff_2', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_2:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_2',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_2',
                status: {
                    handoffId: 'handoff_2',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_2',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_2',
                    transcriptStorage: 'direct',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_2',
                status: { handoffId: 'handoff_2', status: 'aborted', phase: 'cutover', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({
            type: 'error',
            errorCode: 'SESSION_WEBHOOK_TIMEOUT',
            errorMessage: 'timeout',
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_2',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'direct',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_2',
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'SESSION_WEBHOOK_TIMEOUT',
            errorMessage: 'timeout',
            recovery: {
                handoffId: 'handoff_2',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_2',
                    machineId: 'machine_source',
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_2',
                    transcriptStorage: 'direct',
                    serverId: null,
                },
            },
        });
        expect(machineStopSessionMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.abort',
            payload: {
                handoffId: 'handoff_2',
                reason: 'SESSION_WEBHOOK_TIMEOUT',
            },
        }));
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    });

    it('aborts the source handoff when the resumed target session never becomes active', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_2b',
                status: { handoffId: 'handoff_2b', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_2b:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_2b',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_2b',
                status: {
                    handoffId: 'handoff_2b',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_2b',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_2b',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_2b',
                status: { handoffId: 'handoff_2b', status: 'aborted', phase: 'cutover', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_2b' });
        waitForSessionHandoffTargetSessionActiveMock.mockResolvedValueOnce({
            ok: false,
            error: 'Timed out waiting for session handoff target session to become active',
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_2b',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_2b',
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'target_session_not_active',
            errorMessage: 'Timed out waiting for session handoff target session to become active',
            recovery: {
                handoffId: 'handoff_2b',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_2b',
                    machineId: 'machine_source',
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_2b',
                    transcriptStorage: 'persisted',
                    serverId: null,
                },
            },
        });
        expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.abort',
            payload: {
                handoffId: 'handoff_2b',
                reason: 'target_session_not_active',
            },
        }));
    });

    it('converts a direct session to persisted metadata when requested', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_3',
                status: { handoffId: 'handoff_3', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_3:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_3',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo-target',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_3',
                status: {
                    handoffId: 'handoff_3',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_3',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: 'proj_target',
                },
                resume: {
                    directory: '/repo-target',
                    agent: 'claude',
                    resume: 'claude_session_3',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_3',
                status: { handoffId: 'handoff_3', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_3' });
        patchSessionMetadataWithRetryMock.mockImplementationOnce(async (_sessionId: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            const updated = updater({
                flavor: 'claude',
                path: '/repo-source',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_3',
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'machine_source',
                    remoteSessionId: 'claude_session_3',
                    source: { kind: 'claudeConfig', configDir: null, projectId: 'proj_source' },
                    linkedAtMs: 1,
                },
            });
            expect(updated.directSessionV1).toBeUndefined();
            expect(updated.externalHistoryImportV1).toMatchObject({
                v: 1,
                providerId: 'claude',
                remoteSessionId: 'claude_session_3',
                source: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: 'proj_target',
                },
            });
            expect(updated.handoffV1).toMatchObject({
                sessionStorageBefore: 'direct',
                sessionStorageAfter: 'persisted',
            });
            expect(updated.handoffV1).not.toHaveProperty('workspaceTransfer');
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_3',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'direct',
            targetSessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo-source',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_3',
            },
        } as any);

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_3',
            status: {
                handoffId: 'handoff_3',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            transcriptStorage: 'persisted',
        }));
    });

    it('prepares server-routed handoff targets without inline bundles and with the source machine id', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_6',
                status: { handoffId: 'handoff_6', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                targetPath: '/repo',
                handoffMetadataV2: {},
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_6',
                status: {
                    handoffId: 'handoff_6',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_6',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_6',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_6',
                status: { handoffId: 'handoff_6', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sess_6' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_6',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_6',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_6',
            status: {
                handoffId: 'handoff_6',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            machineId: 'machine_target',
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                sourceMachineId: 'machine_source',
                negotiatedTransportStrategy: 'server_routed_stream',
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            machineId: 'machine_source',
            method: 'daemon.sessionHandoff.start',
            payload: expect.objectContaining({
                negotiatedTransportStrategy: 'server_routed_stream',
            }),
        }));
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload).not.toHaveProperty('providerBundle');
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload).not.toHaveProperty('workspaceBundle');
    });

    it('uses direct peer transport when it is preferred and server-routed transfer is disabled', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_4',
                status: { handoffId: 'handoff_4', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_4:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates: [
                            {
                                kind: 'http',
                                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_4',
                                authorizationToken: 'test-token',
                                expiresAt: 60_000,
                            },
                        ],
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_4',
                status: {
                    handoffId: 'handoff_4',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_4',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_4',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_4',
                status: { handoffId: 'handoff_4', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: false },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: true },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'ok' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_4',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_4',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_4',
            status: {
                handoffId: 'handoff_4',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                negotiatedTransportStrategy: 'direct_peer',
                allowServerRoutedFallback: false,
            }),
        }));
    });

    it('forwards direct-peer transport choices without speculative seam flags', async () => {
        const endpointCandidates = [
            {
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_rns?token=test-token',
                expiresAt: 60_000,
            },
        ] as const;
        const handoffMetadataV2 = {
            providerBundleTransferPublication: {
                transferId: 'transfer_provider_bundle_rns',
                sizeBytes: 3,
                manifestHash: 'sha256:provider_bundle_rns',
                endpointCandidates,
            },
        } as const;
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_rns',
                status: { handoffId: 'handoff_rns', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates,
                handoffMetadataV2,
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_rns',
                status: {
                    handoffId: 'handoff_rns',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'direct_peer',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_rns',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_rns',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_rns',
                status: { handoffId: 'handoff_rns', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        });
        resumeSessionMock.mockResolvedValueOnce({ type: 'ok' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_rns',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_rns',
            },
        });

        expect(result).toEqual({
            ok: true,
            handoffId: 'handoff_rns',
            status: {
                handoffId: 'handoff_rns',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'daemon.sessionHandoff.start',
            payload: expect.objectContaining({
                negotiatedTransportStrategy: 'direct_peer',
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                negotiatedTransportStrategy: 'direct_peer',
                allowServerRoutedFallback: true,
                handoffMetadataV2: expect.objectContaining({
                    providerBundleTransferPublication: expect.objectContaining({
                        endpointCandidates,
                    }),
                }),
            }),
        }));
        expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload).not.toHaveProperty('endpointCandidates');
    });

    it('uses server-routed target prepare after a cached direct-peer unavailability for the same source machine and endpoint set', async () => {
        const endpointCandidates = [
            {
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_cached?token=test-token',
                expiresAt: 60_000,
            },
        ] as const;
        const serverSnapshot = {
            status: 'ready' as const,
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: true },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: { enabled: true },
                            directPeer: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                handoffId: 'handoff_cached_a',
                status: { handoffId: 'handoff_cached_a', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_cached_a:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates,
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'direct_peer_transfer_unavailable',
                error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({
                handoffId: 'handoff_cached_b',
                status: { handoffId: 'handoff_cached_b', status: 'pending', phase: 'preparing', recoveryActions: [] },
                endpointCandidates: [],
                handoffMetadataV2: {
                    providerBundleTransferPublication: {
                        transferId: 'session-handoff:handoff_cached_b:provider-bundle-file',
                        sizeBytes: 1,
                        manifestHash: 'sha256:provider-bundle',
                        endpointCandidates,
                    },
                },
                targetPath: '/repo',
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_cached_b',
                status: {
                    handoffId: 'handoff_cached_b',
                    status: 'ready_for_cutover',
                    phase: 'staging_target',
                    transportStrategy: 'server_routed_stream',
                    recoveryActions: [],
                },
                remoteSessionId: 'claude_session_cached_b',
                directSource: {
                    kind: 'claudeConfig',
                    configDir: null,
                    projectId: null,
                },
                resume: {
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_cached_b',
                    transcriptStorage: 'persisted',
                    approvedNewDirectoryCreation: true,
                },
            })
            .mockResolvedValueOnce({
                handoffId: 'handoff_cached_b',
                status: { handoffId: 'handoff_cached_b', status: 'completed', phase: 'finalizing', recoveryActions: [] },
            });
        getServerFeaturesSnapshotMock
            .mockResolvedValueOnce(serverSnapshot)
            .mockResolvedValueOnce(serverSnapshot);
        resumeSessionMock.mockResolvedValueOnce({ type: 'ok' });
        patchSessionMetadataWithRetryMock.mockResolvedValueOnce(undefined);

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const commonOptions = {
            sessionId: 'sess_cached_route',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted' as const,
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'] as const,
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_cached',
            },
        };

        await expect(completeSessionHandoff(commonOptions)).resolves.toEqual({
            ok: false,
            errorCode: 'direct_peer_transfer_unavailable',
            errorMessage: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
            recovery: {
                handoffId: 'handoff_cached_a',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_cached_route',
                    machineId: 'machine_source',
                    directory: '/repo',
                    agent: 'claude',
                    resume: 'claude_session_cached',
                    transcriptStorage: 'persisted',
                    serverId: null,
                },
            },
        });

        await expect(completeSessionHandoff(commonOptions)).resolves.toEqual({
            ok: true,
            handoffId: 'handoff_cached_b',
            status: {
                handoffId: 'handoff_cached_b',
                status: 'completed',
                phase: 'finalizing',
                recoveryActions: [],
            },
        });

        const secondPrepareCall = machineRpcWithServerScopeMock.mock.calls[5]?.[0];
        expect(secondPrepareCall).toEqual(expect.objectContaining({
            method: 'daemon.sessionHandoff.prepareTarget',
            payload: expect.objectContaining({
                negotiatedTransportStrategy: 'server_routed_stream',
                allowServerRoutedFallback: true,
            }),
        }));
        expect(secondPrepareCall?.payload).not.toHaveProperty('endpointCandidates');
    });

    it('fails closed when direct peer is preferred but the server does not allow any preferred handoff transport', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            handoffId: 'handoff_5',
            status: { handoffId: 'handoff_5', status: 'pending', phase: 'preparing', recoveryActions: [] },
            endpointCandidates: [],
            targetPath: '/repo',
        });
        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                            serverRoutedTransfer: { enabled: false },
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: { enabled: false },
                        },
                    },
                },
                capabilities: {},
            },
        });

        const { completeSessionHandoff } = await import('./sessionHandoffs');
        const result = await completeSessionHandoff({
            sessionId: 'sess_5',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            sessionStorageMode: 'persisted',
            preferredTransportStrategies: ['direct_peer'],
            sourceMetadata: {
                flavor: 'claude',
                path: '/repo',
                host: 'source-host',
                machineId: 'machine_source',
                claudeSessionId: 'claude_session_5',
            },
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        });
        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledWith({ force: true });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });

    it('preserves runtime descriptor and transport fields when restarting the source during recovery', async () => {
        resumeSessionMock.mockResolvedValueOnce({ type: 'ok' });

        const { performSessionHandoffRecoveryAction } = await import('./sessionHandoffs');
        const result = await performSessionHandoffRecoveryAction({
            recovery: {
                handoffId: 'handoff_recover_runtime',
                actions: ['restart_on_source', 'keep_stopped'],
                sourceResume: {
                    sessionId: 'sess_source',
                    machineId: 'machine_source',
                    directory: '/repo/source',
                    agent: 'codex',
                    resume: 'codex_session_recover',
                    transcriptStorage: 'direct',
                    serverId: 'server_a',
                    codexBackendMode: 'appServer',
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            vendorSessionId: 'codex_session_recover',
                        },
                    },
                    environmentVariables: {
                        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
                    },
                },
            },
            action: 'restart_on_source',
        });

        expect(result).toEqual({ ok: true });
        expect(resumeSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'codex_session_recover',
                },
            },
            codexBackendMode: 'appServer',
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
            },
        }));
    });
});
