import { beforeEach, describe, expect, it } from 'vitest';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { resolveSessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';

beforeEach(() => storage.setState(storage.getInitialState(), true));

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

/**
 * A layout-v1 session whose owner metadata projection has not landed on this device yet. The
 * plaintext `metadata` bag is deliberately populated: a layout-v1 reader must not fall back to it,
 * so the only admissible source of a machine here is the canonical reachable/control target.
 */
const COLD_OWNER_VIEW_LAYOUT_V1_SESSION = {
    metadataLayoutVersion: 1,
    metadata: {
        flavor: 'claude',
        machineId: 'machine_stale_layout0',
    },
    ownerMetadataView: null,
} as const;

const EXTERNAL_AGENT_HANDOFF_SESSION = {
    metadata: {
        machineId: 'machine_source',
        runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.agent',
            agent: {
                providerSessionId: 'external_vendor_session',
            },
        },
    },
} as const;

function buildActiveDaemonTransferState(): NonNullable<Machine['daemonState']> {
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

function buildConfiguredInactiveDaemonTransferState(): NonNullable<Machine['daemonState']> {
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
    it('keeps the entry point available for an installed Agent and leaves handoff qualification to the daemon action', () => {
        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-external-agent',
            session: EXTERNAL_AGENT_HANDOFF_SESSION,
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

    it('reads source-machine daemon transfer state from an explicit server scope when callers pass one', () => {
        storage.setState({ machineListByServerId: {
            'server-explicit': [createMachineFixture({
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            })],
        } });

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
        storage.setState({ machineListByServerId: {
            'server-preferred': [createMachineFixture({
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            })],
        } });

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
        storage.setState({ machines: { 'stale-machine': createMachineFixture({ id: 'stale-machine' }) },
            sessions: { 'session-1': createSessionFixture({ id: 'session-1',
            metadata: { machineId: 'stale-machine', path: '/tmp/stale' } }) }, machineListByServerId: {
            'server-explicit': [createMachineFixture({
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            })],
        } });

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-1',
            serverId: 'server-explicit',
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
            reachableMachineId: 'machine_source',
        })).toEqual({
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
        storage.setState({ machineListByServerId: {
            'server-explicit': [createMachineFixture({
                id: 'machine_source',
                daemonState: null,
            })],
        }, machines: {
            machine_source: createMachineFixture({
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            }),
        } });

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

    it('allows handoff when server-routed transfer is the only transport the selected server can truthfully offer', () => {
        expect(resolveSessionHandoffUiAvailability({
            session: HANDOFF_ELIGIBLE_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: false,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: true,
            reason: 'available',
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

    it('keeps handoff available for a layout-v1 session with no owner metadata view when a canonical reachable source target exists', () => {
        storage.setState({ machineListByServerId: {
            'server-explicit': [createMachineFixture({
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            })],
        } });

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-cold-owner-view',
            reachableMachineId: 'machine_source',
            serverId: 'server-explicit',
            session: COLD_OWNER_VIEW_LAYOUT_V1_SESSION,
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

    it('stays session-ineligible when neither a reachable source target nor a readable owner metadata machine exists', () => {
        storage.setState({ machineListByServerId: {
            'server-explicit': [createMachineFixture({
                id: 'machine_source',
                daemonState: buildActiveDaemonTransferState(),
            })],
        } });

        expect(resolveSessionHandoffUiAvailability({
            sessionId: 'session-cold-owner-view',
            serverId: 'server-explicit',
            session: COLD_OWNER_VIEW_LAYOUT_V1_SESSION,
            sessionHandoffFeatureEnabled: true,
            serverSnapshot: buildReadyServerSnapshot({
                directPeerEnabled: true,
                serverRoutedEnabled: true,
            }),
        })).toEqual({
            available: false,
            reason: 'session_ineligible',
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
