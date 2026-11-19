import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS,
    createProviderBrokerRouteGrantSigningInputV1,
    type ProviderBrokerRouteGrantPayloadV1,
    type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { verifyProviderBrokerRouteGrantV1 } from './verifyProviderBrokerRouteGrantV1';

const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const payload: ProviderBrokerRouteGrantPayloadV1 = {
    v: 1, grantId: 'grant', aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 200,
    teamId: 'team', resourceId: 'resource',
    sourceRevision: 'source-revision-7',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    initiator: { accountId: 'requester', machineId: 'worker', endpointId: 'a'.repeat(64) },
    target: { custodianAccountId: 'custodian', machineId: 'broker', endpointId: 'b'.repeat(64) },
    consumer: { kind: 'session', sessionId: 'session' },
    application: {
        agentTargetKey: 'codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses',
        protocol: 'openai-responses',
    },
};
function sign(value = payload): SignedProviderBrokerRouteGrantV1 {
    return { payload: value, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV1(value)), key.secretKey)).toString('base64url') } };
}
const input = {
    authority: sign(), nowMs: 150,
    trustRoots: [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }],
    expected: { teamId: payload.teamId, resourceId: payload.resourceId, sourceRevision: payload.sourceRevision, brokerPlacementFingerprint: payload.brokerPlacementFingerprint, initiator: payload.initiator, target: payload.target, consumer: payload.consumer, application: payload.application },
    authenticatedRemoteEndpointId: payload.initiator.endpointId,
};

describe('verifyProviderBrokerRouteGrantV1', () => {
    it('admits the exact cross-Account authority repeatedly for independent streams', () => {
        expect(verifyProviderBrokerRouteGrantV1(input)).toEqual({ valid: true, authority: input.authority });
        expect(verifyProviderBrokerRouteGrantV1(input)).toEqual({ valid: true, authority: input.authority });
        const run = { kind: 'execution_run', executionRunId: 'run' } as const;
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority: sign({ ...payload, consumer: run, executionRunOccurrenceId: 'occurrence' }), expected: { ...input.expected, consumer: run } }).valid).toBe(true);
    });

    it('rejects a valid signature from another transport-authenticated endpoint', () => {
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authenticatedRemoteEndpointId: 'c'.repeat(64) })).toEqual({ valid: false, reasonCode: 'transport_identity_mismatch' });
    });

    it('rejects changed exact authority even if a Home signed the substituted grant', () => {
        const substitutes: ProviderBrokerRouteGrantPayloadV1[] = [
            { ...payload, resourceId: 'other' }, { ...payload, teamId: 'other' },
            { ...payload, sourceRevision: 'other-source-revision' },
            { ...payload, brokerPlacementFingerprint: 'd'.repeat(64) },
            { ...payload, consumer: { kind: 'session', sessionId: 'other' } },
            { ...payload, initiator: { ...payload.initiator, accountId: 'other' } },
            { ...payload, initiator: { ...payload.initiator, machineId: 'other' } },
            { ...payload, target: { ...payload.target, custodianAccountId: 'other' } },
            { ...payload, target: { ...payload.target, machineId: 'other' } },
            { ...payload, target: { ...payload.target, endpointId: 'c'.repeat(64) } },
        ];
        for (const value of substitutes) expect(verifyProviderBrokerRouteGrantV1({ ...input, authority: sign(value) }).valid).toBe(false);
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority: { ...input.authority, payload: { ...payload, aud: 'happier-daemon-route-grant' } } }).valid).toBe(false);
    });

    it('requires the current Home signing root, valid signature and admission time', () => {
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority: { ...input.authority, signature: { ...input.authority.signature, valueBase64Url: 'A'.repeat(86) } } }).valid).toBe(false);
        expect(verifyProviderBrokerRouteGrantV1({ ...input, trustRoots: [] }).valid).toBe(false);
        expect(verifyProviderBrokerRouteGrantV1({ ...input, nowMs: 200 })).toEqual({ valid: false, reasonCode: 'grant_expired' });
        expect(verifyProviderBrokerRouteGrantV1({ ...input, trustRoots: [{ ...input.trustRoots[0]!, expiresAt: 150 }] }).valid).toBe(false);
    });

    it('admits a fresh Home grant within the signed clock-skew tolerance', () => {
        const issuedAt = 60_000;
        const authority = sign({ ...payload, issuedAt, expiresAt: issuedAt + 60_000 });
        const slowClock = issuedAt - ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS;
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority, nowMs: issuedAt })).toEqual({ valid: true, authority });
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority, nowMs: slowClock - 1 })).toEqual({
            valid: false, reasonCode: 'grant_not_yet_valid',
        });
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority, nowMs: issuedAt - 750 })).toEqual({ valid: true, authority });
        expect(verifyProviderBrokerRouteGrantV1({ ...input, authority, nowMs: slowClock })).toEqual({ valid: true, authority });
    });

    it('retains signature and exact binding checks after a carrier admitted the stream', () => {
        expect(verifyProviderBrokerRouteGrantV1({ ...input, nowMs: 200, enforceExpiry: false })).toEqual({
            valid: true,
            authority: input.authority,
        });
        expect(verifyProviderBrokerRouteGrantV1({
            ...input,
            nowMs: 200,
            enforceExpiry: false,
            authenticatedRemoteEndpointId: 'c'.repeat(64),
        })).toEqual({ valid: false, reasonCode: 'transport_identity_mismatch' });
    });
});
