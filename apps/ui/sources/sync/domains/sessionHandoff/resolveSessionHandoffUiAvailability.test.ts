import { describe, expect, it } from 'vitest';

import { resolveSessionHandoffUiAvailability } from './resolveSessionHandoffUiAvailability';

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

describe('resolveSessionHandoffUiAvailability', () => {
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
