import { describe, expect, it } from 'vitest';

import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { readCurrentMachineIrohEndpoint, resolveMachineCarrierPreselection } from './resolveMachineCarrierPreselection';

const features = FeaturesResponseSchema.parse({
    features: {
        machines: {
            enabled: true,
            transfer: {
                enabled: true,
                directPeer: { enabled: true },
                serverRouted: { enabled: false },
            },
            peerMediation: { enabled: true },
        },
    },
    capabilities: {},
});

describe('resolveMachineCarrierPreselection', () => {
    it('preserves a required Home fallback on native hosts, including Standard-only mode', () => {
        for (const applicationCarrierEligibility of ['automatic', 'standard_only'] as const) {
            const input = { applicationCarrierEligibility, serverFeatures: features, targetEndpoint: null,
                host: { kind: 'native' as const, lifecycleAvailable: false },
                finiteTransferApplicationSupported: true, irohApplicationSupported: false };
            expect(resolveMachineCarrierPreselection({ ...input, homeRpcFallback: 'required' })).toEqual({ kind: 'server_rpc' });
            expect(resolveMachineCarrierPreselection(input)).toEqual({ kind: 'unavailable' });
            expect(resolveMachineCarrierPreselection({ ...input, homeRpcFallback: 'required',
                finiteTransferApplicationSupported: false })).toEqual({ kind: 'unavailable' });
        }
        expect(resolveMachineCarrierPreselection({ homeRpcFallback: 'required', serverFeatures: features,
            targetEndpoint: { endpointId: 'a'.repeat(64) }, host: { kind: 'native', lifecycleAvailable: true },
            finiteTransferApplicationSupported: true, irohApplicationSupported: true }))
            .toMatchObject({ kind: 'iroh_peer', carrierKind: 'native_http' });
    });
    it('uses the encrypted server route in browser Standard mode', () => {
        const common = {
            applicationCarrierEligibility: 'standard_only' as const,
            serverFeatures: features,
            targetEndpoint: { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
            host: { kind: 'browser' as const },
            finiteTransferApplicationSupported: true,
            irohApplicationSupported: true,
        };
        expect(resolveMachineCarrierPreselection(common)).toEqual({ kind: 'server_rpc' });
    });
    it('uses the encrypted server route when a browser has no usable relay hints', () => {
        for (const targetEndpoint of [null, { endpointId: 'a'.repeat(64) }, { endpointId: 'a'.repeat(64), relayUrls: [] }]) {
            expect(resolveMachineCarrierPreselection({
                serverFeatures: features,
                targetEndpoint,
                host: { kind: 'browser' },
                finiteTransferApplicationSupported: true,
                irohApplicationSupported: true,
            })).toEqual({ kind: 'server_rpc' });
        }
    });
    it('prefers Iroh when both current carrier feature bits and the application route are usable', () => {
        expect(resolveMachineCarrierPreselection({
            serverFeatures: features,
            targetEndpoint: {
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay.example.test'],
            },
            host: { kind: 'browser' },
            finiteTransferApplicationSupported: true,
            irohApplicationSupported: true,
        })).toMatchObject({ kind: 'iroh_peer', carrierKind: 'browser_stream' });
    });
    it('uses the Home when the browser cannot run the Iroh lifecycle', () => {
        expect(resolveMachineCarrierPreselection({
            serverFeatures: features,
            targetEndpoint: { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
            host: { kind: 'browser', lifecycleAvailable: false },
            finiteTransferApplicationSupported: true,
            irohApplicationSupported: true,
        })).toEqual({ kind: 'server_rpc' });
    });
    it('uses the Home when finite Iroh is disabled on an endpoint retained for other applications', () => {
        expect(resolveMachineCarrierPreselection({
            serverFeatures: features,
            targetEndpoint: { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
            host: { kind: 'browser' }, finiteTransferApplicationSupported: true,
            irohApplicationSupported: false,
        })).toEqual({ kind: 'server_rpc' });
    });

    it('does not revive an undeclared daemon through RPC when Iroh is unavailable', () => {
        expect(resolveMachineCarrierPreselection({
            serverFeatures: features,
            targetEndpoint: null,
            host: { kind: 'native', lifecycleAvailable: false },
            finiteTransferApplicationSupported: false,
            irohApplicationSupported: false,
        })).toEqual({ kind: 'unavailable' });
    });

    it('keeps a current Runner unavailable when its Iroh endpoint or host is unavailable', () => {
        for (const targetEndpoint of [null, { endpointId: 'a'.repeat(64) }]) {
            expect(resolveMachineCarrierPreselection({
                serverFeatures: features,
                targetEndpoint,
                host: { kind: 'native', lifecycleAvailable: false },
                finiteTransferApplicationSupported: true,
                irohApplicationSupported: true,
            })).toEqual({ kind: 'unavailable' });
        }
    });

    it('takes current endpoint and hints only from the server-accepted projection', () => {
        const input = {
            capabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'a'.repeat(64) } },
            revision: 2,
            active: true,
            revokedAt: null,
        };
        expect(readCurrentMachineIrohEndpoint(input)).toEqual({ endpointId: 'a'.repeat(64) });
        expect(readCurrentMachineIrohEndpoint({
            ...input,
            capabilities: {
                irohMachineEndpoint: {
                    protocolVersions: [1], endpointId: 'a'.repeat(64), relayUrls: ['https://current.example.test'],
                },
            },
        })).toEqual({ endpointId: 'a'.repeat(64), relayUrls: ['https://current.example.test'] });
        expect(readCurrentMachineIrohEndpoint({ ...input, revision: null })).toBeNull();
        expect(readCurrentMachineIrohEndpoint({ ...input, revokedAt: 1 })).toBeNull();
    });

    it('does not select Iroh from a predecessor-shaped payload that omits peer mediation', () => {
        const predecessorFeatures = FeaturesResponseSchema.parse({
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: false },
                    },
                },
            },
            capabilities: {},
        });

        expect(resolveMachineCarrierPreselection({
            serverFeatures: predecessorFeatures,
            targetEndpoint: {
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay.example.test'],
            },
            host: { kind: 'browser' },
            finiteTransferApplicationSupported: true,
            irohApplicationSupported: true,
        })).toEqual({ kind: 'server_rpc' });
    });

    it('does not select Iroh when peer mediation is explicitly disabled', () => {
        const peerMediationDisabled = FeaturesResponseSchema.parse({
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: false },
                    },
                    peerMediation: { enabled: false },
                },
            },
            capabilities: {},
        });

        expect(resolveMachineCarrierPreselection({
            serverFeatures: peerMediationDisabled,
            targetEndpoint: {
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay.example.test'],
            },
            host: { kind: 'browser' },
            finiteTransferApplicationSupported: true,
            irohApplicationSupported: true,
        })).toEqual({ kind: 'server_rpc' });
    });

    it('fails closed when neither finite-transfer route is proven usable', () => {
        expect(resolveMachineCarrierPreselection({
            serverFeatures: features,
            targetEndpoint: null,
            host: { kind: 'browser' },
            finiteTransferApplicationSupported: false,
            irohApplicationSupported: false,
        })).toEqual({ kind: 'unavailable' });
    });

    it('does not select an Iroh endpoint that has no current finite-transfer application', () => {
        expect(resolveMachineCarrierPreselection({
            serverFeatures: features,
            targetEndpoint: {
                endpointId: 'a'.repeat(64),
                relayUrls: ['https://relay.example.test'],
            },
            host: { kind: 'browser' },
            finiteTransferApplicationSupported: false,
            irohApplicationSupported: false,
        })).toEqual({ kind: 'unavailable' });
    });
});
