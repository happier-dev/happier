import { describe, expect, it } from 'vitest';

import type { FeaturesResponse } from '@happier-dev/protocol';

import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
    SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
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
            reasonCode: 'transfer_too_large',
            errorMessage: SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
        });
    });

    it('returns the same size-limit error when machine rpc would bypass the shared transfer policy', () => {
        expect(resolveAppSessionTransferAvailability({
            machineTargetAvailable: true,
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
            reasonCode: 'transfer_too_large',
            errorMessage: SESSION_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
        });
    });

    it('returns a canonical disabled error when server-routed transfer is explicitly disabled', () => {
        expect(resolveAppSessionTransferAvailability({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            serverFeatures: createServerFeatures({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
            errorMessage: SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
        });
    });

    it('returns the same disabled error when machine rpc would bypass disabled transfer policy', () => {
        expect(resolveAppSessionTransferAvailability({
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            serverFeatures: createServerFeatures({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: false,
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
            errorMessage: SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
        });
    });

    it('returns a canonical policy-unavailable error when transfer size is known but server features are unavailable', () => {
        expect(resolveAppSessionTransferAvailability({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 5,
            serverFeatures: null,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_policy_unavailable',
            errorMessage: SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
        });
    });
});
