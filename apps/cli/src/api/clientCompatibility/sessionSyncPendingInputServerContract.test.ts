import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import {
    createSessionSyncPendingInputServerContractController,
    resolveMachineSessionInputAdmissionCapability,
    resolveMachinePendingResetStartCapability,
    resolveSessionServerCapabilities,
} from './sessionSyncPendingInputServerContract';

const releasedServerFeatures = {
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
    },
    capabilities: {},
};

function currentFeatures(session: Record<string, unknown>) {
    return {
        ...releasedServerFeatures,
        capabilities: { session },
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function createSocket() {
    return {
        connected: true,
        emitWithAck: vi.fn(),
    };
}

describe('Session server capability detection', () => {
    it('advertises reset start only when its owner is installed and the cached Home implements Pending V4', () => {
        const v4 = { status: 'ready' as const, features: FeaturesResponseSchema.parse(currentFeatures({ pendingInput: { protocolVersion: 4 } })) };
        const v3 = { status: 'ready' as const, features: FeaturesResponseSchema.parse(currentFeatures({ pendingInput: { protocolVersion: 3 } })) };
        expect(resolveMachinePendingResetStartCapability(v4, true)).toEqual({ protocolVersions: [1] });
        expect(resolveMachinePendingResetStartCapability(v4, false)).toBeUndefined();
        expect(resolveMachinePendingResetStartCapability(v3, true)).toBeUndefined();
        expect(resolveMachinePendingResetStartCapability(undefined, true)).toBeUndefined();
        expect(resolveMachinePendingResetStartCapability({ status: 'error', reason: 'network' }, true)).toBeUndefined();
    });
    it('publishes target Machine admission only for a cached Pending V3 server', () => {
        expect(resolveMachineSessionInputAdmissionCapability(undefined)).toEqual({ protocolVersions: [1] });
        expect(resolveMachineSessionInputAdmissionCapability({
            status: 'error',
            reason: 'network',
        } as never)).toEqual({ protocolVersions: [1] });
        expect(resolveMachineSessionInputAdmissionCapability({
            status: 'ready',
            features: currentFeatures({ pendingInput: { protocolVersion: 2 } }),
        } as never)).toEqual({ protocolVersions: [1] });
        expect(resolveMachineSessionInputAdmissionCapability({
            status: 'ready',
            features: currentFeatures({ pendingInput: { protocolVersion: 3 } }),
        } as never)).toEqual({ protocolVersions: [1, 2] });
        expect(resolveMachineSessionInputAdmissionCapability({
            status: 'ready',
            features: currentFeatures({ pendingInput: { protocolVersion: 4 } }),
        } as never)).toEqual({ protocolVersions: [1, 2] });
    });
    it('retains the target-aware Pending epoch separately from main support', () => {
        expect(resolveSessionServerCapabilities(currentFeatures({
            pendingInput: { protocolVersion: 3 },
        }))).toMatchObject({ pendingInput: 'v1', pendingInputProtocolVersion: 3 });
        expect(resolveSessionServerCapabilities(currentFeatures({
            pendingInput: { protocolVersion: 2 },
        }))).toMatchObject({ pendingInput: 'v1', pendingInputProtocolVersion: 2 });
    });
    it('detects Runtime Activity, Pending Input, and publisher authority independently', () => {
        expect(resolveSessionServerCapabilities(currentFeatures({
            runtimeActivity: { protocolVersion: 2 },
        }))).toEqual({
            runtimeActivity: 'v2',
            pendingInput: 'unsupported',
            publisherAuthority: 'unsupported',
        });
        expect(resolveSessionServerCapabilities(currentFeatures({
            pendingInput: { protocolVersion: 1 },
            publisherAuthority: { protocolVersion: 1 },
        }))).toEqual({
            runtimeActivity: 'unsupported',
            pendingInput: 'v1',
            pendingInputProtocolVersion: 1,
            publisherAuthority: 'v1',
        });
    });

    it('recognizes the exact released v0.2.1 feature shape as the legacy session contract', () => {
        expect(resolveSessionServerCapabilities(releasedServerFeatures)).toEqual({
            runtimeActivity: 'legacy',
            pendingInput: 'released_server_v0_2_1',
            publisherAuthority: 'unsupported',
        });
    });

    it('uses one header-safe features request and never negotiates through socket ping', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(currentFeatures({
            runtimeActivity: { protocolVersion: 2 },
            pendingInput: { protocolVersion: 1 },
            publisherAuthority: { protocolVersion: 1 },
        })));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example/',
            token: 'token',
            fetchImpl,
        });

        await expect(controller.resolve({
            sessionConnectionEpoch: 7,
            socket,
            machineId: 'machine',
        })).resolves.toEqual({
            mode: 'session_sync_v3_publisher_authority_check_v1',
            pendingInputProtocolVersion: 1,
            runtimeActivity: 'v2',
            pendingInput: 'v1',
            publisherAuthority: 'v1',
            sessionConnectionEpoch: 7,
            socket,
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://server.example/v1/features',
            expect.objectContaining({
                method: 'GET',
                redirect: 'manual',
                headers: { Authorization: 'Bearer token' },
            }),
        );
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it.each([401, 403])('classifies HTTP %s as authentication failure', async (status) => {
        const socket = createSocket();
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, status)),
        });

        await expect(controller.resolve({
            sessionConnectionEpoch: 1,
            socket,
            machineId: 'machine',
        })).resolves.toMatchObject({
            mode: 'auth_failed',
            runtimeActivity: 'indeterminate',
            pendingInput: 'indeterminate',
            publisherAuthority: 'indeterminate',
        });
    });

    it('retries a settled indeterminate result and invalidates without I/O', async () => {
        const socket = createSocket();
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse({}, 503))
            .mockResolvedValueOnce(jsonResponse(currentFeatures({
                runtimeActivity: { protocolVersion: 2 },
                pendingInput: { protocolVersion: 1 },
            })));
        const controller = createSessionSyncPendingInputServerContractController({
            serverUrl: 'https://server.example',
            token: 'token',
            fetchImpl,
        });
        const probe = { sessionConnectionEpoch: 1, socket, machineId: 'machine' };

        await expect(controller.resolve(probe)).resolves.toMatchObject({ mode: 'indeterminate' });
        await expect(controller.resolve(probe)).resolves.toMatchObject({
            mode: 'session_sync_v2_pending_input_v1',
            runtimeActivity: 'v2',
            pendingInput: 'v1',
        });
        fetchImpl.mockClear();
        expect(controller.invalidate({ sessionConnectionEpoch: 1, socket })).toMatchObject({
            mode: 'indeterminate',
            runtimeActivity: 'indeterminate',
            pendingInput: 'indeterminate',
            publisherAuthority: 'indeterminate',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
