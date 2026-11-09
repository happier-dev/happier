import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { resolveSessionFileTransferAvailability } from './resolveSessionFileTransferAvailability';

const features = FeaturesResponseSchema.parse({
    features: {
        machines: {
            enabled: true,
            transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } },
            peerMediation: { enabled: true },
        },
    },
    capabilities: {},
});
const predecessorState = {
    // 0.2 21977798f704992bc2db3a48cc98c43aeae220c5, api/types.ts and
    // daemon/startDaemon.ts: the RPC registrar exposes bulk transfers without
    // publishing a transfer capability in daemon state.
    status: 'running',
    startedWithCliVersion: '0.2.11',
} as const;
const declaredTransferState = {
    transfer: {
        supported: { import: true, export: true },
        listenerClasses: {
            loopback_http: { enabled: true, configured: true, active: false },
            tailscale_serve_https: { enabled: false, configured: false, active: false },
        },
        lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
    },
} as const;

describe('resolveSessionFileTransferAvailability', () => {
    it('projects the Home route selected for a declared browser without Iroh hints or enabled peer mediation', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true, machineTargetAvailable: true,
            serverFeatures: FeaturesResponseSchema.parse({ features: { machines: { enabled: true,
                transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: false } },
                peerMediation: { enabled: false } } }, capabilities: {} }),
            machineCarrierHost: { kind: 'browser' }, machineDaemonState: declaredTransferState,
        });
        expect(result.available).toBe(true);
        expect(result.decision).toMatchObject({ kind: 'selected', preferredRouteKind: 'machine_rpc_server' });
    });
    it('uses the same Iroh-first preselection as execution', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'browser' },
            machineOperationProtocolCapabilities: {
                irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
            },
            machineOperationProtocolCapabilitiesRevision: 1,
            machineDaemonState: {
                ...declaredTransferState,
                peerMediation: { iroh: { endpoint: { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] } } },
            },
        });

        expect(result.available).toBe(true);
        expect(result.decision).toMatchObject({ kind: 'selected', preferredRouteKind: 'iroh_peer' });
    });

    it('keeps transfer controls unavailable for a daemon without a current transfer declaration', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'native', lifecycleAvailable: false },
            machineDaemonState: predecessorState,
        });

        expect(result.available).toBe(false);
        expect(result.decision).toBeNull();
    });

    it('keeps a current Runner attachment route unavailable when Iroh is unavailable', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'native', lifecycleAvailable: false },
            machineDaemonState: null,
            machineKind: 'ephemeral_session_runner',
            machineOperationProtocolCapabilities: {
                finiteTransferRpc: { protocolVersions: [1] },
            },
            machineOperationProtocolCapabilitiesRevision: 1,
            machineActive: true,
            machineRevokedAt: null,
        });

        expect(result.available).toBe(false);
        expect(result.decision).toBeNull();
    });

    it('makes a current Runner transfer available through its Iroh endpoint without daemon state', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'native', lifecycleAvailable: true },
            machineDaemonState: null,
            machineKind: 'ephemeral_session_runner',
            machineOperationProtocolCapabilities: {
                finiteTransferRpc: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) },
            },
            machineOperationProtocolCapabilitiesRevision: 1,
            machineActive: true,
            machineRevokedAt: null,
        });
        expect(result.available).toBe(true);
        expect(result.decision).toMatchObject({ kind: 'selected', preferredRouteKind: 'iroh_peer' });
    });

    it('does not let an endpoint or operation projection override an unsupported daemon transfer declaration', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'browser' },
            machineKind: 'persistent',
            machineOperationProtocolCapabilities: {
                finiteTransferRpc: { protocolVersions: [1] },
            },
            machineOperationProtocolCapabilitiesRevision: 1,
            machineActive: true,
            machineRevokedAt: null,
            machineDaemonState: {
                transfer: {
                    ...declaredTransferState.transfer,
                    supported: { import: false, export: false },
                },
                peerMediation: {
                    iroh: {
                        endpoint: {
                            endpointId: 'a'.repeat(64),
                            relayUrls: ['https://relay.example.test'],
                        },
                    },
                },
            },
        });

        expect(result.available).toBe(false);
        expect(result.decision).toBeNull();
    });

    it('fails closed when route viability is not established', () => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'browser' },
            machineDaemonState: predecessorState,
        });

        expect(result.available).toBe(false);
        expect(result.decision?.kind).not.toBe('selected');
    });

    it.each([
        null,
        {},
        { ...predecessorState, transfer: null },
        { ...predecessorState, transfer: {} },
        { ...predecessorState, transfer: { ...declaredTransferState.transfer, supported: { import: false, export: false } } },
    ])('does not reinterpret missing state or an invalid/unsupported declaration as a predecessor (%j)', (machineDaemonState) => {
        const result = resolveSessionFileTransferAvailability({
            sessionAvailable: true,
            machineTargetAvailable: true,
            serverFeatures: features,
            machineCarrierHost: { kind: 'browser' },
            machineDaemonState,
        });

        expect(result.available).toBe(false);
    });
});
