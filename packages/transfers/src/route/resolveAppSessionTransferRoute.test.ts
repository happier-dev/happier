import { describe, expect, it } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import { resolveAppSessionTransferRoute } from './resolveAppSessionTransferRoute';

function createServerFeatures(partial?: Partial<FeaturesResponse>): FeaturesResponse {
    return {
        features: {
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    serverRouted: {
                        enabled: true,
                    },
                },
            },
            ...(partial?.features ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities ?? {}),
        },
    };
}

describe('resolveAppSessionTransferRoute', () => {
    it('selects machine rpc when a direct machine target is available', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            serverFeatures: null,
        })).toEqual({
            kind: 'selected',
            route: 'direct_peer',
        });
    });

    it('selects server-routed transfer when no direct machine target is available', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            serverFeatures: null,
        })).toEqual({
            kind: 'selected',
            route: 'server_routed_stream',
        });
    });

    it('fails closed when no direct machine target is available and the session is inactive', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: false,
            sessionRpcAvailable: false,
            serverFeatures: null,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'inactive_session_rpc_unavailable',
        });
    });

    it('fails closed when the selected server-routed size policy is exceeded', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            serverFeatures: createServerFeatures({
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 4,
                            },
                        },
                    },
                },
            }),
            sessionRpcTransferSizeBytes: 5,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'server_routed_transfer_too_large',
        });
    });

    it('keeps the server-routed route available when selected server features are unavailable', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            serverFeatures: null,
            sessionRpcTransferSizeBytes: 5,
        })).toEqual({
            kind: 'selected',
            route: 'server_routed_stream',
        });
    });
});
