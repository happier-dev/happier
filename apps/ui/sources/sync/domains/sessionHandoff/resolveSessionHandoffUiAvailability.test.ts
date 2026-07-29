import { describe, expect, it, vi } from 'vitest';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

import { resolveSessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';

const state = vi.hoisted(() => ({
    storageState: {
        machines: {} as Record<string, { daemonState?: unknown | null }>,
        machineListByServerId: {} as Record<string, { id: string; daemonState?: unknown | null }[] | null>,
    },
    preferredServerId: 'server-1',
    reachableMachineId: 'machine_source',
}));

vi.mock('@/sync/domains/state/storage', () => createStorageModuleStub({
    storage: {
        getState: () => state.storageState,
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => state.preferredServerId,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => ({ machineId: state.reachableMachineId }),
}));

function buildReadyServerSnapshot(input?: Readonly<{
    directPeerEnabled?: boolean;
    serverRoutedEnabled?: boolean;
}>): unknown {
    return {
        status: 'ready',
        features: {
            features: {
                sessions: {
                    enabled: true,
                    handoff: {
                        enabled: true,
                    },
                },
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: {
                            enabled: input?.directPeerEnabled ?? true,
                        },
                        serverRouted: {
                            enabled: input?.serverRoutedEnabled ?? true,
                        },
                    },
                },
            },
            capabilities: {},
        },
    };
}

const HANDOFF_ELIGIBLE_SESSION = {
    metadata: {
        flavor: 'claude',
        machineId: 'machine_source',
        claudeSessionId: 'claude_session_1',
    },
} as const;

function buildActiveDaemonTransferState(): unknown {
    return {
        transfer: {
            supported: {
                import: true,
                export: true,
            },
            listenerClasses: {
                loopback_http: {
                    enabled: true,
                    configured: true,
                    active: true,
                },
                lan_http: {
                    enabled: false,
                    configured: false,
                    active: false,
                },
                tailscale_serve_https: {
                    enabled: false,
                    configured: false,
                    active: false,
                    available: false,
                },
            },
            lifecycle: {
                mode: 'lazy_idle_shutdown',
                version: 1,
            },
        },
    };
}

function buildConfiguredInactiveDaemonTransferState(): unknown {
    return {
        transfer: {
            supported: {
                import: true,
                export: true,
            },
            listenerClasses: {
                loopback_http: {
                    enabled: true,
                    configured: true,
                    active: false,
                },
                lan_http: {
                    enabled: false,
                    configured: false,
                    active: false,
                },
                tailscale_serve_https: {
                    enabled: false,
                    configured: false,
                    active: false,
                    available: false,
                },
            },
            lifecycle: {
                mode: 'lazy_idle_shutdown',
                version: 1,
            },
        },
    };
}

function buildPredecessorLanOnlyDaemonTransferState(): unknown {
    return {
        transfer: {
            supported: {
                import: true,
                export: true,
            },
            listenerClasses: {
                loopback_http: {
                    enabled: false,
                    configured: false,
                    active: false,
                },
                lan_http: {
                    enabled: true,
                    configured: true,
                    active: true,
                },
                tailscale_serve_https: {
                    enabled: false,
                    configured: false,
                    active: false,
                    available: false,
                },
            },
            lifecycle: {
                mode: 'lazy_idle_shutdown',
                version: 1,
            },
        },
    };
}

describe('resolveSessionHandoffUiAvailability', () => {
    it('reads source-machine daemon transfer state from an explicit server scope when callers pass one', () => {
        state.preferredServerId = 'server-preferred-ignored';
        state.storageState.machineListByServerId = {
            'server-explicit': [{
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            }],
        };
        state.storageState.machines = {};

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            serverId: 'server-explicit',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: true,
            reason: 'available',
        });
    });

    it('does not infer a server-scoped source-machine daemon state from the preferred server when callers omit serverId', () => {
        state.preferredServerId = 'server-preferred';
        state.storageState.machineListByServerId = {
            'server-preferred': [{
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            }],
        };
        state.storageState.machines = {};

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        });
    });

    it('uses an explicitly reachable machine target even when the session cache reader is stale', () => {
        state.reachableMachineId = 'stale-machine';
        state.storageState.machineListByServerId = {
            'server-explicit': [{
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            }],
        };
        state.storageState.machines = {};

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            serverId: 'server-explicit',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            reachableMachineId: 'machine_source' as any,
        } as any)).toEqual({
            available: true,
            reason: 'available',
        });
    });

    it('allows handoff when daemon state proves the source machine transfer listener is active even if runtime reachability is still unknown', () => {
        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            machineDaemonState: buildActiveDaemonTransferState(),
        })).toEqual({
            available: true,
            reason: 'available',
        });
    });

    it('fails closed when the explicit server-scoped machine record exists but has no daemon state yet, even if the global machine cache is stale-active', () => {
        state.storageState.machineListByServerId = {
            'server-explicit': [{
                id: 'machine_source',
                daemonState: null,
            }],
        };
        state.storageState.machines = {
            machine_source: {
                daemonState: buildActiveDaemonTransferState(),
            },
        };

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            serverId: 'server-explicit',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        });
    });

    it('allows handoff when live runtime reachability is proven even if the source transfer listener is currently configured but inactive', () => {
        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            runtimeAvailability: 'reachable',
            machineDaemonState: buildConfiguredInactiveDaemonTransferState(),
        })).toEqual({
            available: true,
            reason: 'available',
        });
    });

    it('fails closed when server-routed transfer is the only transport the selected server can truthfully offer', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: false,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        });
    });

    it('does not invent a server-routed handoff carrier for predecessor lan_http-only daemon state', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            runtimeAvailability: 'reachable',
            machineDaemonState: buildPredecessorLanOnlyDaemonTransferState(),
        })).toEqual({
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        });
    });

    it('fails closed when direct peer requires runtime truth but only server-routed fallback is statically known', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        });
    });

    it('allows handoff when direct peer is preferred and runtime viability is explicitly proven', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            runtimeAvailability: 'reachable',
        })).toEqual({
            available: true,
            reason: 'available',
        });
    });

    it('allows handoff when source reachability is proven even if active direct machine-rpc viability is not separately cached', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            runtimeAvailability: 'reachable',
        })).toEqual({
            available: true,
            reason: 'available',
        });
    });

    it('fails closed when direct peer is runtime-unknown even if there is no server-routed fallback', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: false,
            }),
        })).toEqual({
            available: false,
            reason: 'runtime_direct_peer_unavailable',
        });
    });
});
