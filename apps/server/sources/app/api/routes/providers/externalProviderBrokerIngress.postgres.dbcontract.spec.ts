import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createServiceAccountTokenIdentityFields } from '@/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { createTeamCredentialExternalApiKeyInTx } from '@/app/teams/credentials/externalApiKey';
import {
    admitTeamCredentialExternalProviderRequestInTx,
    authorizeTeamCredentialExternalProviderModelCatalogInTx,
} from '@/app/teams/credentials/externalProviderBrokerAdmission';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDbMaintenanceClient } from '@/storage/prisma';
import { recordDriverStatements } from '@/testkit/driverStatements';
import { plainPrivateLabel, storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';

import { registerExternalProviderApiRoutes, type ExternalProviderBrokerDispatch } from './registerExternalProviderApiRoutes';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('external Provider Pool open cost', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    it('probes each Pool Machine once per successful catalog, first inference and established inference open', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: {
            name: 'External open cost', memberships: { create: { accountId: custodian.id, role: 'owner' } },
        } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
        const account = { service: { pluginId: 'example.connected-accounts', localId: 'service' }, accountId: 'external-cost-source' };
        const credential = await db.serviceAccountToken.create({ data: {
            accountId: custodian.id,
            ...createServiceAccountTokenIdentityFields({ ref: account, authenticationModeId: 'api-key' }),
            token: Buffer.from('constructed-test-token'),
            metadata: { v: 4, storage: 'stored_envelope_v1', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', values: {} },
        } });
        const machines = [randomUUID(), randomUUID()];
        await db.machine.createMany({ data: machines.map(id => ({
            id, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        })) });
        const pool = await db.machinePool.create({ data: {
            id: randomUUID(), accountId: custodian.id, name: storedPlainPrivateLabel('Broker Pool'),
            members: { create: machines.map((machineId, priorityTier) => ({ machineId, priorityTier, enabled: true })) },
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: custodian.id, displayName: storedPlainPrivateLabel('External source'),
            disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', brokerPoolId: pool.id,
            sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account', target: { kind: 'account', account },
                credentialIncarnation: credential.id }),
            memberGrants: { create: { teamMembershipId: member.id, deliveryMode: 'brokered' } },
        } });
        const key = await inTx(tx => createTeamCredentialExternalApiKeyInTx(tx, {
            authentication: { env: process.env, authenticationAuthority: 'present_user', authenticationEvidence: [] },
            actorAccountId: custodian.id, resourceId: resource.id, teamMembershipId: member.id,
            keyId: randomUUID(), label: plainPrivateLabel('External open cost'), expiresAt: null,
        }));
        if (!key.ok) throw new Error(key.error);

        const statements: string[] = [];
        const counted = await createDbMaintenanceClient('postgres', undefined, {
            onDriverStatement: recordDriverStatements(event => statements.push(event.query)),
        });
        const originalTransaction = db.$transaction;
        const readEligibility = vi.fn(async ({ machineIds }: { machineIds: readonly string[] }) => ({
            eligibleMachineIds: new Set(machineIds),
        }));
        const dispatch = vi.fn<ExternalProviderBrokerDispatch>(async () => ({
            ok: true, statusCode: 200, headers: {}, body: (async function* () { yield Buffer.from('{}'); })(),
        }));
        const entitlementReads = () => statements.filter(sql => /"TeamCredentialMemberGrant"/u.test(sql)).length;
        const app = Fastify();
        try {
            await counted.$connect();
            db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
                return Reflect.apply(counted.$transaction, counted, args);
            } });
            registerExternalProviderApiRoutes(app as never, {
                env: {
                    ...process.env,
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                    HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: '1',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                    HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'route-grant-key',
                    HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: privacyKit
                        .encodeBase64(new Uint8Array(32).fill(9), 'base64url').replace(/=+$/u, ''),
                },
                dispatch,
                readCurrentBrokerPresence: async () => ({ state: 'known', machineIds: new Set(machines) }),
                readPoolSourceEligibility: readEligibility,
            });
            const headers = { authorization: `Bearer ${key.token}` };
            const catalog = { method: 'GET', url: '/api/provider-broker/v1/models', headers } as const;
            const inference = { method: 'POST', url: '/api/provider-broker/v1/chat/completions', headers,
                payload: { model: 'model-1', messages: [] } } as const;
            const counts = [];
            for (const [stage, request, uniqueMachines] of [
                ['catalog', catalog, 2], ['first inference', inference, 2], ['established inference', inference, 1],
            ] as const) {
                statements.length = 0;
                readEligibility.mockClear();
                const result = await app.inject(request);
                expect(result.statusCode, result.body).toBe(200);
                const probedIds = readEligibility.mock.calls.flatMap(([input]) => input.machineIds);
                counts.push({
                    stage,
                    statements: statements.length,
                    transactions: statements.filter(sql => /^BEGIN\b/iu.test(sql)).length,
                    eligibilityCalls: readEligibility.mock.calls.length,
                    duplicateProbes: probedIds.length - new Set(probedIds).size,
                    entitlementReads: entitlementReads(),
                });
                expect(new Set(probedIds).size).toBe(uniqueMachines);
            }
            console.info('External broker ingress per-request cost', JSON.stringify(counts));
            const opened = dispatch.mock.calls[1]![0];
            const operationRequest = {
                v: 1,
                binding: {
                    v: 1, kind: 'external_api_key', teamId: opened.request.teamId, resourceId: opened.request.resourceId,
                    requestId: opened.request.requestId, externalApiKeyId: opened.request.caller.keyId,
                    assignedAccountId: opened.request.caller.assignedAccountId,
                    assignedTeamMembershipId: opened.request.caller.assignedTeamMembershipId,
                    operationId: opened.target.operationId,
                    brokerPlacementFingerprint: opened.target.brokerPlacementFingerprint,
                },
                brokerMachineId: opened.target.brokerMachineId,
                expectedResourceRevision: resource.revision,
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'cliproxyapi-openai-chat',
                    protocol: 'openai-chat',
                },
            };
            const laterCall = { authenticatedBrokerAccountId: custodian.id, observedAt: new Date() };
            statements.length = 0;
            await expect(inTx(tx => admitTeamCredentialExternalProviderRequestInTx(tx, {
                ...laterCall, request: { ...operationRequest,
                    requestFacts: { routeKind: 'openai_chat_completions', modelId: 'model-1', generation: true, reasoningEffort: null } },
            }))).resolves.toMatchObject({ ok: true, usageEventId: expect.any(String) });
            const inferenceEntitlementReads = entitlementReads();
            statements.length = 0;
            await expect(inTx(tx => authorizeTeamCredentialExternalProviderModelCatalogInTx(tx, {
                ...laterCall, request: operationRequest,
            }))).resolves.toEqual({ ok: true });
            const catalogEntitlementReads = entitlementReads();
            const observed = {
                open: counts.map(({ stage, transactions, eligibilityCalls, duplicateProbes, entitlementReads }) => ({
                    stage, transactions, eligibilityCalls, duplicateProbes, entitlementReads,
                })),
                later: { inferenceEntitlementReads, catalogEntitlementReads },
            };
            console.info('External broker entitlement reads', JSON.stringify(observed));
            expect(observed).toEqual({
                open: [
                    { stage: 'catalog', transactions: 4, eligibilityCalls: 1, duplicateProbes: 0, entitlementReads: 1 },
                    { stage: 'first inference', transactions: 4, eligibilityCalls: 1, duplicateProbes: 0, entitlementReads: 1 },
                    { stage: 'established inference', transactions: 3, eligibilityCalls: 1, duplicateProbes: 0, entitlementReads: 1 },
                ],
                later: { inferenceEntitlementReads: 0, catalogEntitlementReads: 0 },
            });
        } finally {
            db.$transaction = originalTransaction;
            await app.close();
            await counted.$disconnect();
        }
    });
});
