import { describe, expect, it } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
    resolveAppSessionTransferAvailability,
} from './resolveAppSessionTransferAvailability';

function createServerFeatures(partial?: Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>): FeaturesResponse {
    return {
        features: {
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: false,
                    },
                    serverRouted: {
                        enabled: true,
                    },
                },
            },
            ...(partial?.features as object | undefined ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities as object | undefined ?? {}),
        },
    } as FeaturesResponse;
}

describe('resolveAppSessionTransferAvailability', () => {
    it('returns a canonical inactive-session error when session RPC is unavailable', () => {
        expect(resolveAppSessionTransferAvailability({
            machineTargetAvailable: false,
            sessionRpcAvailable: false,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'inactive_session_rpc_unavailable',
            errorMessage: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        });
    });

    it('returns a canonical size-limit error when the selected server-routed policy is exceeded', () => {
        expect(resolveAppSessionTransferAvailability({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 5,
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
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'server_routed_transfer_too_large',
            errorMessage: SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
        });
    });
});
