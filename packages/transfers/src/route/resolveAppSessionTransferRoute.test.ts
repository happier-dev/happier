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
    it('does not select machine_rpc_direct when the server feature snapshot is unavailable', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            serverFeatures: null,
        })).toEqual({
            kind: 'selected',
            route: 'server_routed_stream',
        });
    });

    it('selects machine rpc when a direct machine target is available and transfer is explicitly enabled', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            serverFeatures: createServerFeatures(),
        })).toEqual({
            kind: 'selected',
            route: 'machine_rpc_direct',
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

    it('fails closed when the server feature snapshot is unavailable for a sized transfer', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            serverFeatures: null,
            sessionRpcTransferSizeBytes: 5,
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_policy_unavailable',
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
            reasonCode: 'transfer_too_large',
        });
    });

    it('fails closed when machine rpc would bypass the selected transfer size policy', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: true,
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
            reasonCode: 'transfer_too_large',
        });
    });

    it('fails closed when server-routed transfer is explicitly disabled by server features', () => {
        expect(resolveAppSessionTransferRoute({
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
        });
    });

    it('fails closed when machine rpc would bypass disabled transfer policy', () => {
        expect(resolveAppSessionTransferRoute({
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
        });
    });

    it('fails closed when machines.transfer enabled bit is missing (treat missing as disabled)', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            serverFeatures: createServerFeatures({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
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
        });
    });

    it('fails closed when machines.transfer.serverRouted enabled bit is missing (treat missing as disabled)', () => {
        expect(resolveAppSessionTransferRoute({
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            serverFeatures: createServerFeatures({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            serverRouted: {},
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            reasonCode: 'transfer_disabled',
        });
    });
});
