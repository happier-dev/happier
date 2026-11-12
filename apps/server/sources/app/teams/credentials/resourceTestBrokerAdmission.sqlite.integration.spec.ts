import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    computeTeamCredentialSourceMemberKeyV1,
    TeamCredentialSourceBindingV1Schema,
    type TeamCredentialResourceTestAdmissionV1,
} from '@happier-dev/protocol/teams';
import {
    encodePasswordCredentialFieldV1,
    type AccountPasswordCredentialV1,
    type ProviderBrokerResourceTestRelayBindingV1,
} from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { admitTeamCredentialResourceTestRequestInTx } from './resourceTestBrokerAdmission';
import { mintProviderBrokerRelayAuthorizationV2 } from '@/app/machines/peer/mediation/tunnel';
import { createTeamCredentialResourceTestBrokerDispatcher } from '@/app/api/routes/providers/externalProviderBrokerDispatcher';

describe('Team credential resource-test broker admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'team-resource-test-admission-',
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            },
        });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('rechecks the persisted resource and records one brokered request without a fake Session or external key', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Resource test' } });
        const actorMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: actor.id, role: 'admin' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const broker = await db.machine.create({ data: {
            id: `broker-${custodian.id}`,
            accountId: custodian.id,
            metadata: '{}',
            kind: 'persistent',
            active: true,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const source = TeamCredentialSourceBindingV1Schema.parse({
            v: 1,
            kind: 'provider_connection',
            connectionId: 'connection-1',
            connectionSecurityFingerprint: 'connection-security:v1:1',
            credentialSlotId: 'apiKey',
        });
        if (source.kind !== 'provider_connection') throw new Error('expected provider-connection test source');
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Saved provider',
            enabled: true,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify(source),
            brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: actorMembership.id, deliveryMode: 'brokered' } },
        } });
        const application = {
            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'openai-responses',
            protocol: 'openai-responses',
        } as const;
        const requestFacts = {
            generation: true,
            routeKind: 'openai_responses' as const,
            modelId: 'model-1',
            reasoningEffort: null,
        };
        const binding: ProviderBrokerResourceTestRelayBindingV1 = {
            v: 1,
            kind: 'resource_test',
            teamId: team.id,
            resourceId: resource.id,
            requestId: 'resource-test-1',
            actorAccountId: actor.id,
            expectedResourceRevision: resource.revision,
            application,
            source,
        };
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const relayAuthorizationTrustRoots = [{
            keyId: 'resource-test-key',
            publicKeyBase64Url: Buffer.from(signing.publicKey).toString('base64url'),
        }];
        const signRequest = (
            signedBinding: ProviderBrokerResourceTestRelayBindingV1,
            brokerMachineId = broker.id,
        ): TeamCredentialResourceTestAdmissionV1 => {
            const minted = mintProviderBrokerRelayAuthorizationV2({
                accountId: custodian.id,
                targetMachineId: brokerMachineId,
                relaySocketId: 'resource-test-relay-socket',
                binding: signedBinding,
                tunnelId: `resource-test-${signedBinding.requestId}`,
                nowMs: Date.parse('2026-09-10T09:59:00.000Z'),
                ttlMs: 3_600_000,
                serverGateEnabled: true,
                serverCaps: {
                    maxBytes: 1_048_576,
                    maxFrameBytes: 65_536,
                    maxIdleMs: 30_000,
                    maxDurationMs: 60_000,
                },
                signingKey: { keyId: 'resource-test-key', secretKey: signing.secretKey },
            });
            if (!minted.ok) throw new Error(minted.reasonCode);
            return {
                v: 1,
                binding: signedBinding,
                brokerMachineId,
                relayAuthorization: minted.relayAuthorization,
                requestFacts,
            };
        };
        const request = signRequest(binding);
        const admitRequest = (candidate: unknown, observedAt: Date) => inTx(tx =>
            admitTeamCredentialResourceTestRequestInTx(tx, {
                authenticatedBrokerAccountId: custodian.id,
                request: candidate,
                observedAt,
                relayAuthorizationTrustRoots,
            }));
        const admit = () => admitRequest(request, new Date('2026-09-10T10:00:00.000Z'));

        const unsignedRequest = {
            v: 1,
            binding: { ...binding, requestId: 'resource-test-without-relay-authorization' },
            brokerMachineId: broker.id,
            requestFacts,
        };
        await expect(admitRequest(
            unsignedRequest,
            new Date('2026-09-10T09:59:59.000Z'),
        )).resolves.toEqual({ ok: false, reasonCode: 'invalid_request' });

        const first = await admit();
        expect(first).toMatchObject({
            ok: true,
            resourceRevision: 0,
            resourceId: resource.id,
            brokerMachineId: broker.id,
            operation: { kind: 'resource_test', actorAccountId: actor.id },
            usageEventId: expect.any(String),
        });
        await expect(admit()).resolves.toEqual({ ok: false, reasonCode: 'duplicate_request' });
        expect(await db.usageEvent.findMany({ where: { teamCredentialResourceId: resource.id } })).toMatchObject([{
            accountId: actor.id,
            sessionId: null,
            teamCredentialActorAccountId: actor.id,
            teamCredentialExternalApiKeyId: null,
            brokerMachineId: broker.id,
            credentialDeliveryMode: 'brokered',
            teamCredentialSourceCredentialId: computeTeamCredentialSourceMemberKeyV1({
                kind: 'provider_credential_slot',
                connectionId: source.connectionId,
                credentialSlotId: 'apiKey',
            }),
            requestCount: 1,
        }]);

        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: custodian.id,
            name: 'Resource test pool',
            members: { create: { machineId: broker.id, priorityTier: 0, enabled: true } },
        } });
        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { revision: 2, brokerMachineId: null, brokerPoolId: pool.id },
        });
        const poolRequest = signRequest({
            ...request.binding,
            requestId: 'resource-test-pool',
            expectedResourceRevision: 2,
        });
        await expect(inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: custodian.id,
            request: poolRequest,
            observedAt: new Date('2026-09-10T10:00:30.000Z'),
            relayAuthorizationTrustRoots,
        }))).resolves.toMatchObject({ ok: true, brokerMachineId: broker.id });

        // Selection was already established before this per-request admission.
        // Pool membership governs a future choice; it is not an ongoing ACL for
        // the exact target carried by the resource-test binding.
        await db.machinePoolMember.delete({ where: {
            poolId_machineId: { poolId: pool.id, machineId: broker.id },
        } });
        await expect(inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: custodian.id,
            request: signRequest({ ...poolRequest.binding, requestId: 'resource-test-pool-pinned' }),
            observedAt: new Date('2026-09-10T10:00:45.000Z'),
            relayAuthorizationTrustRoots,
        }))).resolves.toMatchObject({ ok: true, brokerMachineId: broker.id });

        await db.accountPasswordCredential.create({
            data: {
                accountId: actor.id,
                revision: 1,
                credential: {
                    v: 1,
                    kind: 'plain_password_hash',
                    hash: {
                        v: 1,
                        algorithm: 'scrypt',
                        parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
                        salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(4)),
                        digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(8)),
                    },
                } satisfies AccountPasswordCredentialV1,
            },
        });
        await db.accountIdentity.create({
            data: {
                accountId: actor.id,
                provider: 'email',
                providerUserId: `${actor.id}@resource-test.invalid`,
                profile: {},
            },
        });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'email_password' }],
        } } });
        const restrictedRequest = signRequest({
            ...request.binding,
            requestId: 'resource-test-restricted',
            expectedResourceRevision: 2,
            verifiedCredentialEvidence: {
                v: 1,
                evidence: [{ kind: 'home_method', methodId: 'email_password' }],
            },
        });
        const {
            verifiedCredentialEvidence: _restrictedEvidence,
            ...restrictedBindingWithoutEvidence
        } = restrictedRequest.binding;
        const restrictedAdmission = await inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: custodian.id,
            request: restrictedRequest,
            observedAt: new Date('2026-09-10T10:01:00.000Z'),
            relayAuthorizationTrustRoots,
        }));
        expect(restrictedAdmission).toMatchObject({ ok: true, resourceId: resource.id });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(4);
        await db.machinePoolMember.create({ data: {
            poolId: pool.id,
            machineId: broker.id,
            priorityTier: 0,
            enabled: true,
        } });
        const dispatch = createTeamCredentialResourceTestBrokerDispatcher({
            enabled: () => false,
            env: {},
            createRelayTransport: vi.fn(() => {
                throw new Error('disabled carrier must not open transport');
            }),
        });
        const dispatchRequest = {
            v: 1 as const,
            kind: 'resource_test' as const,
            requestId: 'dispatcher-checkpoint',
            teamId: team.id,
            resourceId: resource.id,
            route: 'responses' as const,
            method: 'POST' as const,
            pathAndQuery: '/v1/responses',
            bodyBase64: 'e30=',
        };
        const dispatchInput = {
            actorAccountId: actor.id,
            resourceId: resource.id,
            expectedResourceRevision: 2,
            brokerMachineId: broker.id,
            application,
            source,
            verifiedCredentialEvidence: restrictedRequest.binding.verifiedCredentialEvidence?.evidence,
            request: dispatchRequest,
            signal: new AbortController().signal,
        };
        await expect(dispatch(dispatchInput)).resolves.toEqual({
            ok: false,
            error: 'broker_unavailable',
            failureDetail: { code: 'broker_unavailable', stage: 'feature' },
        });
        await expect(dispatch({
            ...dispatchInput,
            verifiedCredentialEvidence: undefined,
        })).resolves.toEqual({ ok: false, error: 'policy_denied' });
        await expect(inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: custodian.id,
            request: signRequest({
                ...restrictedBindingWithoutEvidence,
                requestId: 'resource-test-restricted-absent',
            }),
            observedAt: new Date('2026-09-10T10:01:01.000Z'),
            relayAuthorizationTrustRoots,
        }))).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        for (const tamperedBinding of [
            { ...restrictedRequest.binding, teamId: 'wrong-team' },
            { ...restrictedRequest.binding, resourceId: 'wrong-resource' },
            { ...restrictedRequest.binding, expectedResourceRevision: 3 },
            { ...restrictedRequest.binding, actorAccountId: custodian.id },
            { ...restrictedRequest.binding, verifiedCredentialEvidence: undefined },
            { ...restrictedRequest.binding, application: {
                ...application, endpointTemplateId: 'other-endpoint',
            } },
            {
                ...restrictedRequest.binding,
                source: TeamCredentialSourceBindingV1Schema.parse({
                    ...source,
                    credentialSlotId: 'other-slot',
                }),
            },
        ] satisfies ProviderBrokerResourceTestRelayBindingV1[]) {
            await expect(inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
                authenticatedBrokerAccountId: custodian.id,
                request: { ...restrictedRequest, binding: tamperedBinding },
                observedAt: new Date('2026-09-10T10:01:02.000Z'),
                relayAuthorizationTrustRoots,
            }))).resolves.toEqual({ ok: false, reasonCode: 'invalid_request' });
        }
        await expect(admitRequest(
            { ...restrictedRequest, brokerMachineId: 'other-broker' },
            new Date('2026-09-10T10:01:02.000Z'),
        )).resolves.toEqual({ ok: false, reasonCode: 'invalid_request' });
        await expect(inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: actor.id,
            request: restrictedRequest,
            observedAt: new Date('2026-09-10T10:01:02.000Z'),
            relayAuthorizationTrustRoots,
        }))).resolves.toEqual({ ok: false, reasonCode: 'invalid_request' });
        await expect(admitRequest({
            ...restrictedRequest,
            relayAuthorization: {
                ...restrictedRequest.relayAuthorization,
                signature: {
                    ...restrictedRequest.relayAuthorization.signature,
                    valueBase64Url: 'AA',
                },
            },
        }, new Date('2026-09-10T10:01:02.000Z'))).resolves.toEqual({
            ok: false,
            reasonCode: 'invalid_request',
        });
        await db.accountPasswordCredential.delete({ where: { accountId: actor.id } });
        await expect(inTx(tx => admitTeamCredentialResourceTestRequestInTx(tx, {
            authenticatedBrokerAccountId: custodian.id,
            request: {
                ...restrictedRequest,
                ...signRequest({ ...restrictedRequest.binding, requestId: 'resource-test-stale-evidence' }),
            },
            observedAt: new Date('2026-09-10T10:01:03.000Z'),
            relayAuthorizationTrustRoots,
        }))).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await db.teamMembership.delete({ where: { id: (await db.teamMembership.findFirstOrThrow({
            where: { teamId: team.id, accountId: custodian.id },
            select: { id: true },
        })).id } });
        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { brokerMachineId: broker.id, brokerPoolId: null },
        });
        await expect(dispatch({
            ...dispatchInput,
            actorAccountId: custodian.id,
            verifiedCredentialEvidence: undefined,
        })).resolves.toEqual({
            ok: false,
            error: 'broker_unavailable',
            failureDetail: { code: 'broker_unavailable', stage: 'feature' },
        });
        await expect(admitRequest(signRequest({
            ...restrictedBindingWithoutEvidence,
            requestId: 'resource-test-departed-source-owner',
            actorAccountId: custodian.id,
        }), new Date('2026-09-10T10:01:04.000Z'))).resolves.toMatchObject({ ok: true });
        const unrelated = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: unrelated.id, role: 'member' } });
        await expect(dispatch({
            ...dispatchInput,
            actorAccountId: unrelated.id,
            verifiedCredentialEvidence: undefined,
        })).resolves.toEqual({ ok: false, error: 'policy_denied' });
        await expect(admitRequest(signRequest({
            ...restrictedBindingWithoutEvidence,
            requestId: 'resource-test-unrelated-member',
            actorAccountId: unrelated.id,
        }), new Date('2026-09-10T10:01:05.000Z'))).resolves.toEqual({
            ok: false,
            reasonCode: 'operation_not_current',
        });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(5);
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: null } });

        await db.teamCredentialResource.update({ where: { id: resource.id }, data: { revision: 3 } });
        await expect(admit()).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
    });
});
