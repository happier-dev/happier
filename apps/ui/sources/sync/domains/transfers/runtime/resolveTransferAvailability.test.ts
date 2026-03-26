import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

function createServerFeaturesResponse(partial?: Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>): FeaturesResponse {
    return FeaturesResponseSchema.parse({
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
            ...(partial?.features ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities ?? {}),
        },
    });
}

describe('resolveTransferAvailability', () => {
    it('selects the server-routed stream when session RPC is available and the payload is within the server-routed size limit', async () => {
        const { resolveSessionRelayTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionRelayTransferAvailability({
            serverId: 'server-1',
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 128,
            serverFeatures: createServerFeaturesResponse({
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
                },
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 256,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'selected',
            route: {
                kind: 'server_routed_stream',
                serverId: 'server-1',
            },
        });
    });

    it('fails closed for session relay when session RPC is unavailable', async () => {
        const { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR, resolveSessionRelayTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionRelayTransferAvailability({
            serverId: 'server-1',
            sessionRpcAvailable: false,
            sessionRpcTransferSizeBytes: 128,
            serverFeatures: null,
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

    it('fails closed for session relay when the server transfer policy snapshot is unavailable for a sized transfer', async () => {
        const { SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR, resolveSessionRelayTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionRelayTransferAvailability({
            serverId: 'server-1',
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 128,
            serverFeatures: null,
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

    it('fails closed for session relay when the payload exceeds the server-routed size limit', async () => {
        const { SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR, resolveSessionRelayTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionRelayTransferAvailability({
            serverId: 'server-1',
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 512,
            serverFeatures: createServerFeaturesResponse({
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
                },
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 256,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

    it('fails closed for session relay when server-routed transfer is explicitly disabled', async () => {
        const { SERVER_ROUTED_TRANSFER_DISABLED_ERROR, resolveSessionRelayTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionRelayTransferAvailability({
            serverId: 'server-1',
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 128,
            serverFeatures: createServerFeaturesResponse({
                features: {
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: false,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: SERVER_ROUTED_TRANSFER_DISABLED_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

    it('selects the direct machine RPC route when machine target is available and a server feature snapshot is present', async () => {
        const { resolveSessionFileTransferRouteAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionFileTransferRouteAvailability({
            serverId: 'server-1',
            machineTargetAvailable: true,
            sessionRpcAvailable: false,
            sessionRpcTransferSizeBytes: 128,
            serverFeatures: createServerFeaturesResponse({
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
                },
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 256,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'selected',
            route: {
                kind: 'machine_rpc_direct',
            },
        });
    });

    it('fails closed for session file transfer when the server transfer policy snapshot is unavailable for a sized transfer (even if machine target is available)', async () => {
        const { SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR, resolveSessionFileTransferRouteAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionFileTransferRouteAvailability({
            serverId: 'server-1',
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 128,
            serverFeatures: null,
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: SERVER_TRANSFER_POLICY_UNAVAILABLE_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

    it('fails closed for session file transfer when the payload exceeds the server-routed size limit (even if machine target is available)', async () => {
        const { SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR, resolveSessionFileTransferRouteAvailability } = await import('./resolveTransferAvailability');

        expect(resolveSessionFileTransferRouteAvailability({
            serverId: 'server-1',
            machineTargetAvailable: true,
            sessionRpcAvailable: true,
            sessionRpcTransferSizeBytes: 512,
            serverFeatures: createServerFeaturesResponse({
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
                },
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 256,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: SERVER_ROUTED_FILE_TRANSFER_TOO_LARGE_ERROR,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

    it('returns direct-peer handoff selection details without speculative seam flags', async () => {
        const { resolveMachineTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveMachineTransferAvailability({
            serverFeatures: {
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
                                    enabled: true,
                                },
                                serverRouted: {
                                    enabled: true,
                                },
                            },
                        },
                    },
                    capabilities: {},
                },
            },
            preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
        })).toEqual({
            ok: true,
            negotiatedTransportStrategy: 'direct_peer',
            allowServerRoutedFallback: true,
        });
    });

    it('fails closed for handoff when session handoff is disabled on the selected server', async () => {
        const { resolveMachineTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveMachineTransferAvailability({
            serverFeatures: {
                features: {
                    features: {
                        sessions: {
                            enabled: true,
                            handoff: { enabled: false },
                        },
                    },
                    capabilities: {},
                },
            },
            preferredTransportStrategies: ['direct_peer'],
        })).toEqual({
            ok: false,
            errorCode: 'handoff_disabled',
            errorMessage: 'Session handoff is disabled on the selected server',
        });
    });

    it('fails closed for handoff when all transfer strategies are disabled on the selected server', async () => {
        const { resolveMachineTransferAvailability } = await import('./resolveTransferAvailability');

        expect(resolveMachineTransferAvailability({
            serverFeatures: {
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
                                    enabled: false,
                                },
                                serverRouted: {
                                    enabled: false,
                                },
                            },
                        },
                    },
                    capabilities: {},
                },
            },
            preferredTransportStrategies: ['direct_peer'],
        })).toEqual({
            ok: false,
            errorCode: 'transfer_disabled',
            errorMessage: 'Machine transfer is disabled on the selected server',
        });
    });
});
