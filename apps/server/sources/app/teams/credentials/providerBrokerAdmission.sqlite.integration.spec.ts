import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    DIRECT_ROUTE_GRANT_TTL_MS,
    ProviderConnectionIdSchema,
    type ProviderBrokerOpenRequestV1,
    type ProviderBrokerRequestAdmissionV1,
    type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { computeTeamCredentialSourceMemberKeyV1 } from '@happier-dev/protocol/teams';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import {
    PROVIDER_BROKER_ROUTE_GRANT_TTL_MS,
    admitTeamCredentialProviderBrokerRequest as admitTeamCredentialProviderBrokerRequestOwner,
    authorizeTeamCredentialProviderModelCatalog as authorizeTeamCredentialProviderModelCatalogOwner,
    openRunnerTeamCredentialProviderBroker as openRunnerTeamCredentialProviderBrokerOwner,
    openTeamCredentialProviderBroker as openTeamCredentialProviderBrokerOwner,
} from './providerBrokerAdmission';
import {
    admitSessionTeamCredentialBindingInTx,
    readSessionTeamCredentialBindingInTx,
    writeSessionTeamCredentialBindingsInTx,
} from './sessionBinding';
import { updateTeamCredentialResourceInTx } from './resourceUpdate';
import { resolveTeamCredentialBrokerPlacementFingerprint } from './brokerPlacementResolver';
import { createExecutionRunBrokerCurrentnessResolver } from './executionRunBrokerAuthorityResolver';
import { setTeamCredentialAudienceInTx } from './resourceAudience';
import { readTeamCredentialCatalogInTx, readTeamCredentialResourceAdministrationInTx } from './resourceRead';
import { hashPasswordMaterial } from '@/app/auth/password/passwordMaterialVerifier';
import { deleteMachinePool } from '@/app/machines/pools/machinePoolService';
import type { MachineDaemonPresenceSocketServer } from '@/app/machines/machineDaemonPresence';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc';
import { selectMachinePoolCandidate } from '@happier-dev/protocol/machines/pools';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { setTeamPolicyInTx } from '@/app/teams/policy';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerTeamCredentialProviderBrokerRoutes } from './providerBrokerRoutes';
import { emailPasswordAuthMethodModule } from '@/app/auth/methods/modules/emailPasswordAuthMethodModule';
import { issuePasswordMutationKeyChallengeV1 } from '@/app/auth/keyChallengeV2';
import {
    createPasswordMutationChallengeSigningInputV1,
    encodePasswordCredentialFieldV1,
} from '@happier-dev/protocol';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import * as privacyKit from 'privacy-kit';
import { openAccountConnectionProviderBroker, admitAccountConnectionProviderBroker } from '@/app/providers/providerBrokerAdmission';
import { verifyProviderBrokerRouteGrantSignatureV2 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';

const TEST_AUTHENTICATION = {
    env: process.env,
    authority: 'present_user',
    authenticationEvidence: [],
} as const;

function providerSourceMemberKey(connectionId: string, credentialSlotId: string) {
    return computeTeamCredentialSourceMemberKeyV1({
        kind: 'provider_credential_slot',
        connectionId: ProviderConnectionIdSchema.parse(connectionId),
        credentialSlotId,
    });
}

type OpenInput = Parameters<typeof openTeamCredentialProviderBrokerOwner>[0];
type LegacyOpenInput = Omit<OpenInput, 'readCurrentPresence'>
    & Partial<Pick<OpenInput, 'readCurrentPresence'>>
    & Readonly<{
        initiatorPresence: import('@/app/machines/machineDaemonPresence').MachineDaemonPresenceInventory;
        brokerPresence: import('@/app/machines/machineDaemonPresence').MachineDaemonPresenceInventory;
    }>;

function withCurrentPresence<T extends LegacyOpenInput>(input: T) {
    return {
        ...input,
        // These owner-level fixtures begin with an epoch-zero signed credential.
        // The route regression below supplies the real auth-verified selector.
        authentication: { tokenEpoch: 0, ...input.authentication },
        readCurrentPresence: input.readCurrentPresence ?? (async () => ({
            initiatorPresence: input.initiatorPresence,
            brokerPresence: input.brokerPresence,
        })),
    };
}

function openTeamCredentialProviderBroker(input: LegacyOpenInput) {
    return openTeamCredentialProviderBrokerOwner(withCurrentPresence(input));
}

type RunnerOpenInput = Parameters<typeof openRunnerTeamCredentialProviderBrokerOwner>[0];
function openRunnerTeamCredentialProviderBroker(
    input: Omit<RunnerOpenInput, 'readCurrentPresence'>
        & Partial<Pick<RunnerOpenInput, 'readCurrentPresence'>>
        & Readonly<{
            initiatorPresence: import('@/app/machines/machineDaemonPresence').MachineDaemonPresenceInventory;
            brokerPresence: import('@/app/machines/machineDaemonPresence').MachineDaemonPresenceInventory;
        }>,
) {
    return openRunnerTeamCredentialProviderBrokerOwner(withCurrentPresence(input));
}

type CatalogInput = Parameters<typeof authorizeTeamCredentialProviderModelCatalogOwner>[0];
function authorizeTeamCredentialProviderModelCatalog(
    input: Omit<CatalogInput, 'readCurrentBrokerPresence'> & Partial<Pick<CatalogInput, 'readCurrentBrokerPresence'>> & Readonly<{
        brokerPresence: import('@/app/machines/machineDaemonPresence').MachineDaemonPresenceInventory;
    }>,
) {
    return authorizeTeamCredentialProviderModelCatalogOwner({
        ...input,
        readCurrentBrokerPresence: input.readCurrentBrokerPresence ?? (async () => input.brokerPresence),
    });
}

type RequestAdmissionInput = Parameters<typeof admitTeamCredentialProviderBrokerRequestOwner>[0];
function admitTeamCredentialProviderBrokerRequest(
    input: Omit<RequestAdmissionInput, 'readCurrentBrokerPresence'>
        & Partial<Pick<RequestAdmissionInput, 'readCurrentBrokerPresence'>>
        & Readonly<{ brokerPresence: import('@/app/machines/machineDaemonPresence').MachineDaemonPresenceInventory }>,
) {
    return admitTeamCredentialProviderBrokerRequestOwner({
        ...input,
        readCurrentBrokerPresence: input.readCurrentBrokerPresence ?? (async () => input.brokerPresence),
    });
}

const FIXTURE_APPLICATION = {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'openai-responses',
    protocol: 'openai-responses',
} as const;

function fixtureProviderProjection(connectionId: string, modelIds: readonly string[] = ['model-1']) {
    return {
        status: 'success',
        agentTargetKey: FIXTURE_APPLICATION.agentTargetKey,
        groups: [{
            connectionId, providerName: 'CLIProxyAPI', connectionName: 'Work',
            connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
            sourceAuthority: {
                provider: { identity: FIXTURE_APPLICATION.implementationIdentity, definitionRevision: 1 },
                connectionSecurityFingerprint: `connection-security:v1:${connectionId}`,
            },
            sourceRevision: 'source-revision-1', modelLoadAction: 'available', modelLoadPreflightPolicy: null,
            authorization: { authorized: true }, manualModelPolicy: 'allowed',
            supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
            rows: modelIds.map(modelId => ({
                ref: { agentTargetKey: FIXTURE_APPLICATION.agentTargetKey, providerConnectionId: connectionId, modelId },
                descriptor: { id: modelId, name: modelId }, application: FIXTURE_APPLICATION,
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: {
                    result: { status: 'verified', selectedProtocol: FIXTURE_APPLICATION.protocol, evidence: { sourceUrls: ['https://example.com/provider'], verifiedAt: '2026-09-10' } },
                    compatibilityFingerprint: 'compatibility:v1:current', confirmed: false,
                },
                endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
            })),
        }],
    };
}

/**
 * One requester, one source custodian and their two Machines, with resources
 * and Session selections produced through the canonical owners: the Session's
 * witness is only ever written by `writeSessionTeamCredentialBindingsInTx`, and
 * every signed authority comes from a real broker open.
 */
async function createBrokerFixture(
    label: string,
    options: Readonly<{ requesterPublicKeyHex?: string }> = {},
) {
    const requester = await db.account.create({ data: options.requesterPublicKeyHex
        ? { encryptionMode: 'e2ee', publicKey: options.requesterPublicKeyHex }
        : { encryptionMode: 'plain' } });
    const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
    const team = await db.team.create({ data: { name: `Broker ${label} ${crypto.randomUUID()}` } });
    const requesterMembership = await db.teamMembership.create({
        data: { teamId: team.id, accountId: requester.id, role: 'member' },
    });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
    const worker = await db.machine.create({ data: {
        id: `worker-${label}-${requester.id}`, accountId: requester.id, metadata: '{}', kind: 'persistent', active: true,
        operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: '1'.repeat(64) } },
        operationProtocolCapabilitiesRevision: 1,
    } });
    const broker = await db.machine.create({ data: {
        id: `broker-${label}-${custodian.id}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
        operationProtocolCapabilities: {
            providerBrokerIngress: { protocolVersions: [1] },
            irohMachineEndpoint: { protocolVersions: [1], endpointId: '2'.repeat(64) },
        },
        operationProtocolCapabilitiesRevision: 1,
    } });
    const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
    const workerPresence = { state: 'known' as const, machineIds: new Set([worker.id]) };
    const brokerPresence = { state: 'known' as const, machineIds: new Set([broker.id]) };
    type FixtureResource = Readonly<{ id: string; revision: number; sourceBindingJson: string }>;
    const connectionIdOf = (resource: FixtureResource) =>
        (JSON.parse(resource.sourceBindingJson) as { connectionId: string }).connectionId;
    let requestSequence = 0;
    return {
        requester,
        custodian,
        team,
        broker,
        worker,
        createResource: async (connectionId: string) => await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: connectionId,
            enabled: true,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId,
                connectionSecurityFingerprint: `connection-security:v1:${connectionId}`,
                credentialSlotId: 'apiKey',
            }),
            brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } }),
        createSession: async () => {
            const session = await db.session.create({ data: {
                id: `session-${label}-${requester.id}`,
                tag: `broker-${label}-${requester.id}`,
                accountId: requester.id,
                metadata: '{}',
                active: true,
            } });
            await db.accessKey.create({ data: {
                accountId: requester.id, machineId: worker.id, sessionId: session.id, data: '{}',
            } });
            return session;
        },
        selectForSession: async (
            sessionId: string,
            resource: FixtureResource,
            authentication: OpenInput['authentication'],
        ) => {
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                sessionId,
                accountId: requester.id,
                intents: [{
                    v: 1,
                    slot: { kind: 'provider_model' },
                    resourceId: resource.id,
                    expectedResourceRevision: resource.revision,
                    deliveryMode: 'brokered',
                    teamId: team.id,
                }],
                authentication,
            }))).resolves.toEqual({ ok: true });
        },
        open: async (input: Readonly<{
            resource: FixtureResource;
            authentication: OpenInput['authentication'];
            sessionId?: string;
            consumer?: ProviderBrokerOpenRequestV1['consumer'];
            modelId?: string;
            refreshAuthority?: SignedProviderBrokerRouteGrantV1;
            resolveExecutionRunCurrentness?: OpenInput['resolveExecutionRunCurrentness'];
        }>) => await openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: input.authentication,
            request: {
                v: 1,
                resourceId: input.resource.id,
                expectedResourceRevision: input.resource.revision,
                modelId: input.modelId ?? 'model-1',
                sourceRevision: 'source-revision-1',
                initiatorMachineId: worker.id,
                consumer: input.consumer ?? { kind: 'session', sessionId: input.sessionId! },
                application: FIXTURE_APPLICATION,
                ...(input.refreshAuthority ? { refreshAuthority: input.refreshAuthority } : {}),
            },
            initiatorPresence: workerPresence,
            brokerPresence,
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'fixture-home', secretKey: signingKey.secretKey },
            readProviderProjection: async () => fixtureProviderProjection(connectionIdOf(input.resource), ['model-1', 'model-2']),
            readPoolSourceEligibility: async () => ({ eligibleMachineIds: new Set([broker.id]), reasons: new Map() }),
            ...(input.refreshAuthority
                ? { verifyRefreshAuthority: (candidate: SignedProviderBrokerRouteGrantV1) => candidate.payload.grantId === input.refreshAuthority!.payload.grantId }
                : {}),
            ...(input.resolveExecutionRunCurrentness
                ? { resolveExecutionRunCurrentness: input.resolveExecutionRunCurrentness }
                : {}),
        }),
        admit: async (input: Readonly<{
            authority: SignedProviderBrokerRouteGrantV1;
            resource: FixtureResource;
            requestId: string;
            generation?: boolean;
            modelId?: string;
            resolveExecutionRunCurrentness?: OpenInput['resolveExecutionRunCurrentness'];
        }>) => await admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: {
                v: 1,
                authority: input.authority,
                expectedResourceRevision: input.resource.revision,
                sourceMemberKey: providerSourceMemberKey(connectionIdOf(input.resource), 'apiKey'),
                requestId: `${label}-${input.requestId}`,
                requestFacts: {
                    generation: input.generation ?? false,
                    routeKind: 'openai_responses',
                    modelId: input.modelId ?? 'model-1',
                    reasoningEffort: null,
                },
            },
            observedAt: new Date(Date.UTC(2026, 8, 23, 10, 0, 0, requestSequence += 1)),
            brokerPresence,
            verifyAuthority: candidate => candidate.payload.grantId === input.authority.payload.grantId,
            ...(input.resolveExecutionRunCurrentness
                ? { resolveExecutionRunCurrentness: input.resolveExecutionRunCurrentness }
                : {}),
        }),
        catalog: async (input: Readonly<{
            authority: SignedProviderBrokerRouteGrantV1;
            resource: FixtureResource;
            resolveExecutionRunCurrentness?: OpenInput['resolveExecutionRunCurrentness'];
        }>) =>
            await authorizeTeamCredentialProviderModelCatalog({
                authenticatedBrokerAccountId: custodian.id,
                authority: input.authority,
                expectedResourceRevision: input.resource.revision,
                brokerPresence,
                verifyAuthority: candidate => candidate.payload.grantId === input.authority.payload.grantId,
                ...(input.resolveExecutionRunCurrentness
                    ? { resolveExecutionRunCurrentness: input.resolveExecutionRunCurrentness }
                    : {}),
            }),
    };
}


describe('Team credential Provider broker admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'team-provider-broker-admission-',
            // Auth tokens authenticate the real Account Security route.
            initAuth: true,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                // The Home offers email/password, so a restricted Team can
                // accept it and a credential's evidence of it can be current.
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                // A stable Home audience for the Account Security key challenge.
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_SERVER_IDENTITY_ID: 'srv_broker_admission_home',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'credential-test',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(new Uint8Array(32).fill(42)).toString('base64url'),
            },
        });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('admits a personal connection without Team authority and withdraws it when the exact hub capability disappears', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createMachine = async (id: string, endpointId: string, ingress: readonly number[]) => await db.machine.create({ data: {
            id: `${id}-${account.id}`, accountId: account.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId },
                providerBrokerIngress: { protocolVersions: [...ingress] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const worker = await createMachine('personal-worker', 'a'.repeat(64), [1]);
        const hub = await createMachine('personal-hub', 'b'.repeat(64), [1, 2]);
        const session = await db.session.create({ data: { id: `personal-session-${account.id}`, tag: account.id,
            accountId: account.id, metadata: '{}', active: true } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: worker.id, sessionId: session.id, data: '{}' } });
        const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        const verifyAuthority = (authority: unknown) => verifyProviderBrokerRouteGrantSignatureV2({ authority, nowMs: 100,
            signingCapability: { keyId: 'personal-home', publicKey: Buffer.from(key.publicKey).toString('base64url'), expiresAt: null } });
        const common = { homeId: 'personal-home', actorAccountId: account.id,
            presence: { state: 'known' as const, machineIds: new Set([worker.id, hub.id]) },
            resolveExecutionRunCurrentness: async () => ({ ok: false as const, reasonCode: 'execution_run_not_found' as const }) };
        const opened = await openAccountConnectionProviderBroker({ ...common, nowMs: 100, grantId: 'personal-grant', tokenEpoch: 0,
            signingKey: { keyId: 'personal-home', secretKey: key.secretKey }, verifyRefreshAuthority: verifyAuthority,
            request: { v: 2, source: { kind: 'account_connection', connectionId: ProviderConnectionIdSchema.parse('personal-connection'),
                expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
                expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' },
                initiatorMachineId: worker.id, targetMachineId: hub.id, consumer: { kind: 'session', sessionId: session.id },
                application: FIXTURE_APPLICATION } });
        expect(opened).toMatchObject({ ok: true, authority: { payload: { homeId: 'personal-home', accountId: account.id,
            source: { kind: 'account_connection', connectionId: 'personal-connection' }, target: { machineId: hub.id } } } });
        if (!opened.ok) throw new Error('personal open refused');
        expect(verifyAuthority(opened.authority)).toBe(true);
        await expect(admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
            request: { v: 2, authority: opened.authority } })).resolves.toEqual({ ok: true });
        await db.machine.update({ where: { id: hub.id }, data: { operationProtocolCapabilities: {
            irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) }, providerBrokerIngress: { protocolVersions: [1] },
        }, operationProtocolCapabilitiesRevision: 2 } });
        await expect(admitAccountConnectionProviderBroker({ ...common, verifyAuthority,
            request: { v: 2, authority: opened.authority } })).resolves.toEqual({ ok: false, reasonCode: 'update_required' });
    });

    it('uses the native direct TCP tunnel admission window for new broker streams', () => {
        expect(PROVIDER_BROKER_ROUTE_GRANT_TTL_MS)
            .toBe(DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel);
    });

    it('projects current target direct and relay hints with the signed endpoint identity', async () => {
        const fixture = await createBrokerFixture('target-descriptor');
        const resource = await fixture.createResource('connection-target-descriptor');
        const session = await fixture.createSession();
        await fixture.selectForSession(session.id, resource, TEST_AUTHENTICATION);
        const endpoint = {
            endpointId: '2'.repeat(64),
            directAddresses: ['10.0.0.2:7777'],
            relayUrls: ['https://target-relay.example.test/'],
        };
        await db.machine.update({ where: { id: fixture.broker.id }, data: {
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], ...endpoint },
            },
            operationProtocolCapabilitiesRevision: 7,
        } });
        const result = await fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION });
        expect(result).toMatchObject({
            ok: true,
            authority: { payload: { target: { endpointId: endpoint.endpointId } } },
            target: { endpointId: endpoint.endpointId, endpointRevision: 7, endpoint },
        });
    });

    it.each(['account', 'terminal'] as const)('ends broker authority when its exact %s credential is revoked', async kind => {
        const fixture = await createBrokerFixture(`credential-${kind}`);
        const resource = await fixture.createResource(`connection-credential-${kind}`);
        const session = await fixture.createSession();
        await fixture.selectForSession(session.id, resource, TEST_AUTHENTICATION);
        const token = await auth.createToken(fixture.requester.id, undefined, {
            kind, authority: kind === 'account' ? 'present_user' : 'account_automation',
        });
        const custodianToken = await auth.createToken(fixture.custodian.id, undefined, {
            kind: 'terminal', authority: 'account_automation',
        });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        // Only daemon RPC and socket transport are substituted; authentication,
        // route admission, signing and request currentness remain real.
        app.decorate('forwardRpcForUser', async () => ({ ok: true, result: fixtureProviderProjection(`connection-credential-${kind}`) }));
        app.decorate('machineDaemonPresence', { in: () => ({ fetchSockets: async () => [
            { data: { clientType: 'machine-scoped', userId: fixture.requester.id, machineId: fixture.worker.id } },
            { data: { clientType: 'machine-scoped', userId: fixture.custodian.id, machineId: fixture.broker.id } },
        ] }) });
        registerTeamCredentialProviderBrokerRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/teams/credential-resources/broker/open',
                headers: { authorization: `Bearer ${token}` }, payload: {
                    v: 1, resourceId: resource.id, expectedResourceRevision: resource.revision,
                    modelId: 'model-1', sourceRevision: 'source-revision-1', initiatorMachineId: fixture.worker.id,
                    consumer: { kind: 'session', sessionId: session.id }, application: FIXTURE_APPLICATION,
                } });
            expect(response.statusCode).toBe(200);
            const opened = response.json<Awaited<ReturnType<typeof fixture.open>>>();
            if (!opened.ok) throw new Error(`expected credential-bound open: ${opened.reasonCode}`);
            const admit = async (requestId: string) => {
                const result = await app.inject({
                    method: 'POST', url: '/v1/teams/credential-resources/broker/admit',
                    headers: { authorization: `Bearer ${custodianToken}` }, payload: {
                        v: 1, authority: opened.authority, expectedResourceRevision: resource.revision,
                        sourceMemberKey: providerSourceMemberKey(`connection-credential-${kind}`, 'apiKey'),
                        requestId, requestFacts: {
                            generation: false, routeKind: 'openai_responses', modelId: 'model-1', reasoningEffort: null,
                        },
                    },
                });
                expect(result.statusCode).toBe(200);
                return result.json();
            };
            await expect(admit('before-revoke'))
                .resolves.toMatchObject({ ok: true });
            await auth.signOutEverywhere(fixture.requester.id);
            const usageBefore = await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } });
            expect(usageBefore).toBe(1);
            await expect(admit('after-revoke'))
                .resolves.toEqual({ ok: false, reasonCode: 'operation_not_current' });
            await expect(fixture.catalog({ authority: opened.authority, resource }))
                .resolves.toEqual({ ok: false, reasonCode: 'operation_not_current' });
            expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(usageBefore);
        } finally {
            await app.close();
        }
    });

    it.each(['machine-to-pool', 'pool-to-pool', 'pool-to-machine'] as const)(
        'ends established Session and Run authority on resource relocation %s, not on policy or Pool-member edits',
        async (relocation) => {
            const fixture = await createBrokerFixture(relocation);
            const pools = await Promise.all(['original', 'replacement'].map(name => db.machinePool.create({ data: {
                id: crypto.randomUUID(), accountId: fixture.custodian.id, name,
                members: { create: { machineId: fixture.broker.id, priorityTier: 0, enabled: true } },
            } })));
            let resource = await fixture.createResource(`connection-${relocation}`);
            if (relocation !== 'machine-to-pool') {
                resource = await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
                    brokerMachineId: null, brokerPoolId: pools[0].id,
                } });
            }
            const session = await fixture.createSession();
            await fixture.selectForSession(session.id, resource, TEST_AUTHENTICATION);
            const resolveRun: NonNullable<OpenInput['resolveExecutionRunCurrentness']> = async () => ({
                ok: true, parentSessionId: session.id, occurrenceId: 'placement-run-occurrence',
                intent: 'agent', runtimeState: 'active_turn',
                teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' },
            });
            const sessionOpen = await fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION });
            const runOpen = await fixture.open({ resource, consumer: { kind: 'execution_run', executionRunId: 'placement-run' },
                authentication: TEST_AUTHENTICATION, resolveExecutionRunCurrentness: resolveRun });
            if (!sessionOpen.ok || !runOpen.ok) throw new Error('expected initial broker opens');

            // Revisions and selection membership are not ongoing operation authority.
            resource = await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
                displayName: 'Updated policy presentation', revision: { increment: 1 },
            } });
            await db.machinePoolMember.deleteMany({ where: { poolId: pools[0].id } });
            await expect(fixture.admit({ authority: sessionOpen.authority, resource, requestId: 'same-placement' }))
                .resolves.toMatchObject({ ok: true });
            await expect(fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION,
                refreshAuthority: sessionOpen.authority })).resolves.toMatchObject({ ok: true });
            await expect(fixture.admit({ authority: runOpen.authority, resource, requestId: 'same-placement-run',
                resolveExecutionRunCurrentness: resolveRun })).resolves.toMatchObject({ ok: true });
            await expect(fixture.catalog({ authority: runOpen.authority, resource,
                resolveExecutionRunCurrentness: resolveRun })).resolves.toMatchObject({ ok: true });
            await expect(fixture.open({ resource, consumer: runOpen.authority.payload.consumer,
                authentication: TEST_AUTHENTICATION, refreshAuthority: runOpen.authority,
                resolveExecutionRunCurrentness: resolveRun })).resolves.toMatchObject({ ok: true });

            resource = await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
                brokerMachineId: relocation === 'pool-to-machine' ? fixture.broker.id : null,
                brokerPoolId: relocation === 'pool-to-machine' ? null : pools[1].id,
                revision: { increment: 1 },
            } });
            const usageBefore = await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } });
            await expect(fixture.admit({ authority: sessionOpen.authority, resource, requestId: 'relocated-session' }))
                .resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
            await expect(fixture.admit({ authority: runOpen.authority, resource, requestId: 'relocated-run',
                resolveExecutionRunCurrentness: resolveRun })).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
            await expect(fixture.catalog({ authority: sessionOpen.authority, resource }))
                .resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
            await expect(fixture.catalog({ authority: runOpen.authority, resource,
                resolveExecutionRunCurrentness: resolveRun })).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
            await expect(fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION,
                refreshAuthority: sessionOpen.authority })).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
            await expect(fixture.open({ resource, consumer: runOpen.authority.payload.consumer,
                authentication: TEST_AUTHENTICATION, refreshAuthority: runOpen.authority,
                resolveExecutionRunCurrentness: resolveRun })).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
            expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(usageBefore);
            await expect(fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION }))
                .resolves.toMatchObject({ ok: true });
        },
    );

    it('connects current Session, resource, source and exact Machines to one pre-forward usage admission', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Broker admission' } });
        const requesterMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const workerEndpointId = 'a'.repeat(64);
        const brokerEndpointId = 'b'.repeat(64);
        const worker = await db.machine.create({ data: {
            id: `worker-${requester.id}`, accountId: requester.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: workerEndpointId } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const broker = await db.machine.create({ data: {
            id: `broker-${custodian.id}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: brokerEndpointId },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Shared provider',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId: 'connection-1',
                connectionSecurityFingerprint: 'connection-security:v1:1',
                credentialSlotId: 'apiKey',
            }),
            brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        const session = await db.session.create({ data: {
            id: `session-${requester.id}`,
            tag: `broker-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            active: true,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id,
            machineId: worker.id,
            sessionId: session.id,
            data: '{}',
        } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [{
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                deliveryMode: 'brokered',
                teamId: team.id,
            }],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        await expect(applySessionTurnMutation({
            actorUserId: requester.id,
            authentication: TEST_AUTHENTICATION,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: 'begin-turn-1',
                turnId: 'turn-1',
                action: 'begin',
                observedAt: 1,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const canonicalApplication = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'openai-responses',
            protocol: 'openai-responses',
        } as const;
        const projection = (stale = false) => ({
            status: 'success',
            agentTargetKey: canonicalApplication.agentTargetKey,
            groups: [{
                connectionId: 'connection-1', providerName: 'CLIProxyAPI', connectionName: 'Work',
                connectionRole: 'named', connectionDisplayNameMode: 'custom', connectionRevision: 1,
                sourceAuthority: {
                    provider: { identity: canonicalApplication.implementationIdentity, definitionRevision: 1 },
                    connectionSecurityFingerprint: 'connection-security:v1:1',
                },
                sourceRevision: 'source-revision-1', modelLoadAction: 'available', modelLoadPreflightPolicy: null,
                authorization: { authorized: true }, manualModelPolicy: 'allowed',
                supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
                rows: [{
                    ref: { agentTargetKey: canonicalApplication.agentTargetKey, providerConnectionId: 'connection-1', modelId: 'model-1' },
                    descriptor: { id: 'model-1', name: 'Model 1' }, application: canonicalApplication,
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                    compatibility: {
                        result: { status: 'verified', selectedProtocol: canonicalApplication.protocol, evidence: { sourceUrls: ['https://example.com/provider'], verifiedAt: '2026-09-10' } },
                        compatibilityFingerprint: 'compatibility:v1:current', confirmed: false,
                    },
                    endpointHealth: 'not_checked', catalog: { stale }, loadState: 'unknown', visibility: 'visible',
                }],
            }],
        });
        expect(() => DaemonProviderModelProjectionResponseV1Schema.parse(projection())).not.toThrow();
        const openRequest = {
            v: 1 as const,
            resourceId: resource.id,
            expectedResourceRevision: resource.revision,
            modelId: 'model-1',
            sourceRevision: 'source-revision-1',
            initiatorMachineId: worker.id,
            consumer: { kind: 'session' as const, sessionId: session.id },
            application: canonicalApplication,
        };
        const tryOpen = (request: ProviderBrokerOpenRequestV1, response: unknown) => openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            // Deliberately invalid: any path that reaches signing fails the test.
            signingKey: { keyId: 'must-not-sign', secretKey: new Uint8Array() },
            readProviderProjection: async () => response,
        });
        const connectedServiceSlot = {
            kind: 'connected_service_purpose' as const,
            purpose: {
                consumer: { pluginId: 'example.plugin', localId: 'consumer' },
                purpose: 'search',
            },
        };
        // The Session selects this resource for a connected-service purpose
        // slot instead of its model slot, through the canonical writer.
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [
                { v: 1, slot: { kind: 'provider_model' }, resourceId: null },
                {
                    v: 1,
                    slot: connectedServiceSlot,
                    resourceId: resource.id,
                    expectedResourceRevision: resource.revision,
                    deliveryMode: 'brokered',
                    teamId: team.id,
                },
            ],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        let wrongSlotProjectionReads = 0;
        await expect(openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request: openRequest,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'must-not-sign', secretKey: new Uint8Array() },
            readProviderProjection: async () => {
                wrongSlotProjectionReads += 1;
                return projection();
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        // An attached Run is not authorized through its parent's witness at all
        // (`PLAN.md` §2.3): "authorizes an attached Run against its own
        // selection" below owns that contract.
        expect(wrongSlotProjectionReads).toBe(0);
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [{ v: 1, slot: connectedServiceSlot, resourceId: null }, {
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                deliveryMode: 'brokered',
                teamId: team.id,
            }],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        await expect(tryOpen({
            ...openRequest,
            consumer: { kind: 'execution_run', executionRunId: 'run-without-home-authority' },
        }, projection())).resolves.toEqual({ ok: false, reasonCode: 'execution_run_authority_unavailable' });
        await expect(tryOpen({ ...openRequest, expectedResourceRevision: resource.revision + 1 }, projection())).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
        await expect(tryOpen({ ...openRequest, modelId: 'forged' }, projection())).resolves.toEqual({ ok: false, reasonCode: 'resource_unavailable' });
        await expect(tryOpen({ ...openRequest, sourceRevision: 'forged' }, projection())).resolves.toEqual({ ok: false, reasonCode: 'resource_unavailable' });
        await expect(tryOpen({ ...openRequest, application: { ...canonicalApplication, endpointTemplateId: 'forged' } }, projection())).resolves.toEqual({ ok: false, reasonCode: 'resource_unavailable' });
        await expect(tryOpen(openRequest, projection(true))).resolves.toEqual({ ok: false, reasonCode: 'resource_unavailable' });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);

        const currentnessSigningKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
        await db.session.update({ where: { id: session.id }, data: { active: false } });
        let inactiveProjectionReads = 0;
        await expect(openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: TEST_AUTHENTICATION,
            request: openRequest,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'currentness-home', secretKey: currentnessSigningKey.secretKey },
            readProviderProjection: async () => {
                inactiveProjectionReads += 1;
                return projection();
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'session_not_active' });
        expect(inactiveProjectionReads).toBe(0);

        await db.session.update({ where: { id: session.id }, data: { active: true } });
        let brokerConnectedAtFinalObservation = true;
        await expect(openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: TEST_AUTHENTICATION,
            request: openRequest,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            readCurrentPresence: async () => ({
                initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
                brokerPresence: {
                    state: 'known',
                    machineIds: new Set(brokerConnectedAtFinalObservation ? [broker.id] : []),
                },
            }),
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'currentness-home', secretKey: currentnessSigningKey.secretKey },
            readProviderProjection: async () => {
                brokerConnectedAtFinalObservation = false;
                return projection();
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });

        const detachedSigningKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
        await db.session.update({ where: { id: session.id }, data: { active: false } });
        const detachedOpen = await openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request: {
                ...openRequest,
                consumer: { kind: 'execution_run', executionRunId: 'detached-run-current' },
            },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'detached-run-home', secretKey: detachedSigningKey.secretKey },
            resolveExecutionRunCurrentness: async () => ({
                ok: true,
                parentSessionId: null,
                occurrenceId: 'detached-occurrence-current',
                intent: 'agent',
                runtimeState: 'idle',
                teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
            }),
            readProviderProjection: async () => projection(),
        });
        if (!detachedOpen.ok) throw new Error(`expected detached Run broker open: ${detachedOpen.reasonCode}`);
        await db.session.update({ where: { id: session.id }, data: { active: true } });
        expect(detachedOpen.authority.payload).toMatchObject({
            consumer: { kind: 'execution_run', executionRunId: 'detached-run-current' },
            executionRunOccurrenceId: 'detached-occurrence-current',
        });
        const resolveDetachedRun = async () => ({
            ok: true as const,
            parentSessionId: null,
            occurrenceId: 'detached-occurrence-current',
            intent: 'agent' as const,
            runtimeState: 'idle' as const,
            teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
        });
        await expect(authorizeTeamCredentialProviderModelCatalog({
            authenticatedBrokerAccountId: custodian.id,
            authority: detachedOpen.authority,
            expectedResourceRevision: resource.revision,
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === detachedOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: resolveDetachedRun,
        })).resolves.toEqual({ ok: true });
        const authorizeDetachedCatalog = () => authorizeTeamCredentialProviderModelCatalog({
            authenticatedBrokerAccountId: custodian.id,
            authority: detachedOpen.authority,
            expectedResourceRevision: resource.revision,
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === detachedOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: resolveDetachedRun,
        });
        await db.machine.update({ where: { id: worker.id }, data: { revokedAt: new Date(1) } });
        await expect(authorizeDetachedCatalog()).resolves.toEqual({ ok: false, reasonCode: 'operation_not_current' });
        await db.machine.update({ where: { id: worker.id }, data: { revokedAt: null } });
        await db.teamMembership.update({ where: { id: requesterMembership.id }, data: { status: 'suspended' } });
        await expect(authorizeDetachedCatalog()).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await db.teamMembership.update({ where: { id: requesterMembership.id }, data: { status: 'active' } });
        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { sessionUsePolicy: 'team_context_required' },
        });
        await expect(authorizeDetachedCatalog()).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { sessionUsePolicy: 'personal_allowed' },
        });
        const detachedRequest = (requestId: string, generation: boolean): ProviderBrokerRequestAdmissionV1 => ({
            v: 1,
            authority: detachedOpen.authority,
            expectedResourceRevision: resource.revision,
            sourceMemberKey: providerSourceMemberKey('connection-1', 'apiKey'),
            requestId,
            requestFacts: {
                generation,
                routeKind: 'openai_responses',
                modelId: 'model-1',
                reasoningEffort: null,
            },
        });
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: detachedRequest('detached-catalog-request', false),
            observedAt: new Date('2026-09-09T09:26:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === detachedOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: resolveDetachedRun,
        })).resolves.toMatchObject({
            ok: true,
            operation: { kind: 'execution_run', executionRunId: 'detached-run-current' },
            // Admitted non-generation work (token counting) is accounted on the
            // private broker exactly as it is on the external path.
            usageEventId: expect.any(String),
        });
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: detachedRequest('detached-idle-generation', true),
            observedAt: new Date('2026-09-09T09:27:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === detachedOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: resolveDetachedRun,
        })).resolves.toEqual({ ok: false, reasonCode: 'operation_not_current' });
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: detachedRequest('detached-active-generation', true),
            observedAt: new Date('2026-09-09T09:28:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === detachedOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: async () => ({
                ...await resolveDetachedRun(),
                runtimeState: 'active_turn',
                teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
            }),
        })).resolves.toMatchObject({
            ok: true,
            operation: { kind: 'execution_run', executionRunId: 'detached-run-current' },
            usageEventId: expect.any(String),
        });
        expect(await db.usageEvent.findFirst({
            where: { teamCredentialResourceId: resource.id, externalKey: 'detached-active-generation' },
            select: { accountId: true, sessionId: true },
        })).toEqual({ accountId: requester.id, sessionId: null });
        expect(await db.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId
            FROM UsageEvent
            WHERE teamCredentialResourceId = ${resource.id}
              AND externalKey = 'detached-active-generation'
        `).toEqual([{ executionRunId: 'detached-run-current' }]);
        await db.usageEvent.deleteMany({
            where: { teamCredentialResourceId: resource.id, externalKey: 'detached-active-generation' },
        });

        const runSigningKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
        await expect(openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: TEST_AUTHENTICATION,
            request: {
                ...openRequest,
                consumer: { kind: 'execution_run', executionRunId: 'run-session-stops-during-projection' },
            },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'run-home', secretKey: runSigningKey.secretKey },
            resolveExecutionRunCurrentness: async () => ({
                ok: true,
                parentSessionId: session.id,
                occurrenceId: 'occurrence-session-stops',
                intent: 'agent',
                runtimeState: 'active_turn',
                teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
            }),
            readProviderProjection: async () => {
                await db.session.update({ where: { id: session.id }, data: { active: false } });
                return projection();
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'session_not_active' });
        await db.session.update({ where: { id: session.id }, data: { active: true } });

        const runOpen = await openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request: {
                ...openRequest,
                consumer: { kind: 'execution_run', executionRunId: 'run-current' },
            },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'run-home', secretKey: runSigningKey.secretKey },
            resolveExecutionRunCurrentness: async () => ({
                ok: true,
                parentSessionId: session.id,
                occurrenceId: 'occurrence-current',
                intent: 'agent',
                runtimeState: 'active_turn',
                teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
            }),
            readProviderProjection: async () => projection(),
        });
        if (!runOpen.ok) throw new Error(`expected Run broker open: ${runOpen.reasonCode}`);
        expect(runOpen.authority.payload).toMatchObject({
            consumer: { kind: 'execution_run', executionRunId: 'run-current' },
            executionRunOccurrenceId: 'occurrence-current',
        });
        await expect(authorizeTeamCredentialProviderModelCatalog({
            authenticatedBrokerAccountId: custodian.id,
            authority: runOpen.authority,
            expectedResourceRevision: resource.revision,
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === runOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: async ({ expectedOccurrenceId }) => expectedOccurrenceId === 'occurrence-current'
                ? { ok: true, parentSessionId: session.id, occurrenceId: expectedOccurrenceId, intent: 'agent', runtimeState: 'idle', teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const } }
                : { ok: false, reasonCode: 'operation_not_current' },
        })).resolves.toEqual({ ok: true });
        const runRequest: ProviderBrokerRequestAdmissionV1 = {
            v: 1,
            authority: runOpen.authority,
            expectedResourceRevision: resource.revision,
            sourceMemberKey: providerSourceMemberKey('connection-1', 'apiKey'),
            requestId: 'run-request-1',
            requestFacts: {
                generation: true,
                routeKind: 'openai_responses',
                modelId: 'model-1',
                reasoningEffort: null,
            },
        };
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: runRequest,
            observedAt: new Date('2026-09-09T09:29:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === runOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: async () => ({
                ok: true,
                parentSessionId: 'wrong-parent-session',
                occurrenceId: 'occurrence-current',
                intent: 'agent',
                runtimeState: 'active_turn',
                teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
            }),
        })).resolves.toEqual({ ok: false, reasonCode: 'operation_not_current' });
        // Only the earlier admitted token-count request is accounted; the refused
        // admission above adds nothing.
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);
        let announceAdmissionCurrentness!: () => void;
        let releaseAdmissionCurrentness!: () => void;
        const admissionCurrentnessStarted = new Promise<void>(resolve => { announceAdmissionCurrentness = resolve; });
        const admissionCurrentnessReleased = new Promise<void>(resolve => { releaseAdmissionCurrentness = resolve; });
        const pendingRunAdmission = admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: runRequest,
            observedAt: new Date('2026-09-09T09:30:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === runOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: async ({ expectedOccurrenceId }) => {
                announceAdmissionCurrentness();
                await admissionCurrentnessReleased;
                return expectedOccurrenceId === 'occurrence-current'
                    ? {
                        ok: true,
                        parentSessionId: session.id,
                        occurrenceId: expectedOccurrenceId,
                        intent: 'agent',
                        runtimeState: 'active_turn',
                        teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const },
                        activeTurnId: 'run-local-turn-1',
                    }
                    : { ok: false, reasonCode: 'operation_not_current' };
            },
        });
        await admissionCurrentnessStarted;
        expect(await db.usageEvent.count({
            where: { teamCredentialResourceId: resource.id, externalKey: runRequest.requestId },
        })).toBe(0);
        releaseAdmissionCurrentness();
        await expect(pendingRunAdmission).resolves.toMatchObject({
            ok: true,
            operation: { kind: 'execution_run', executionRunId: 'run-current' },
            usageEventId: expect.any(String),
        });
        expect(await db.usageEvent.findFirst({
            where: { teamCredentialResourceId: resource.id, externalKey: runRequest.requestId },
            select: {
                sessionId: true,
                turnId: true,
                brokerMachineId: true,
                teamCredentialSourceCredentialId: true,
            },
        })).toEqual({
            sessionId: session.id,
            turnId: 'run-local-turn-1',
            brokerMachineId: broker.id,
            teamCredentialSourceCredentialId: runRequest.sourceMemberKey,
        });
        expect(await db.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId
            FROM UsageEvent
            WHERE teamCredentialResourceId = ${resource.id}
              AND externalKey = ${runRequest.requestId}
        `).toEqual([{ executionRunId: 'run-current' }]);
        await db.usageEvent.deleteMany({ where: { teamCredentialResourceId: resource.id, externalKey: 'run-request-1' } });
        // The admitted token-count request earlier in this test is accounted too.
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);
        await db.usageEvent.deleteMany({ where: { teamCredentialResourceId: resource.id } });

        let announceDisconnectCurrentness!: () => void;
        let releaseDisconnectCurrentness!: () => void;
        const disconnectCurrentnessStarted = new Promise<void>(resolve => { announceDisconnectCurrentness = resolve; });
        const disconnectCurrentnessReleased = new Promise<void>(resolve => { releaseDisconnectCurrentness = resolve; });
        const disconnectedRequestId = 'run-request-broker-disconnected';
        const disconnectedAdmission = admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: { ...runRequest, requestId: disconnectedRequestId },
            observedAt: new Date('2026-09-09T09:31:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            readCurrentBrokerPresence: async () => ({ state: 'known', machineIds: new Set() }),
            verifyAuthority: candidate => candidate.payload.grantId === runOpen.authority.payload.grantId,
            resolveExecutionRunCurrentness: async ({ expectedOccurrenceId }) => {
                announceDisconnectCurrentness();
                await disconnectCurrentnessReleased;
                return expectedOccurrenceId === 'occurrence-current'
                    ? { ok: true, parentSessionId: session.id, occurrenceId: expectedOccurrenceId, intent: 'agent', runtimeState: 'active_turn', teamCredentialProviderModel: { resourceId: resource.id, deliveryMode: 'brokered' as const } }
                    : { ok: false, reasonCode: 'operation_not_current' };
            },
        });
        await disconnectCurrentnessStarted;
        expect(await db.usageEvent.count({ where: { externalKey: disconnectedRequestId } })).toBe(0);
        releaseDisconnectCurrentness();
        await expect(disconnectedAdmission).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });
        expect(await db.usageEvent.count({ where: { externalKey: disconnectedRequestId } })).toBe(0);

        const authority: SignedProviderBrokerRouteGrantV1 = {
            payload: {
                v: 1,
                grantId: 'grant-1',
                aud: 'happier-provider-broker-route-v1',
                issuedAt: 1,
                expiresAt: 2,
                teamId: team.id,
                resourceId: resource.id,
                sourceRevision: 'source-revision-1',
                brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource)!,
                initiatorTokenEpoch: requester.tokenEpoch,
                initiator: { accountId: requester.id, machineId: worker.id, endpointId: workerEndpointId },
                target: { custodianAccountId: custodian.id, machineId: broker.id, endpointId: brokerEndpointId },
                consumer: { kind: 'session', sessionId: session.id },
                application: {
                    agentTargetKey: 'codex',
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'openai-responses',
                    protocol: 'openai-responses',
                },
            },
            signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) },
        };
        const request: ProviderBrokerRequestAdmissionV1 = {
            v: 1,
            authority,
            expectedResourceRevision: 1,
            sourceMemberKey: providerSourceMemberKey('connection-1', 'apiKey'),
            requestId: 'request-1',
            requestFacts: {
                generation: true,
                routeKind: 'openai_responses',
                modelId: 'model-1',
                reasoningEffort: null,
            },
        };
        const admit = () => admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request,
            observedAt: new Date('2026-09-09T10:00:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        });

        await expect(authorizeTeamCredentialProviderModelCatalog({
            authenticatedBrokerAccountId: custodian.id,
            authority,
            expectedResourceRevision: resource.revision,
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toEqual({ ok: true });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);

        // The Session selects this resource for a connected-service purpose
        // slot instead of its model slot, through the canonical writer.
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [
                { v: 1, slot: { kind: 'provider_model' }, resourceId: null },
                {
                    v: 1,
                    slot: connectedServiceSlot,
                    resourceId: resource.id,
                    expectedResourceRevision: resource.revision,
                    deliveryMode: 'brokered',
                    teamId: team.id,
                },
            ],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        await expect(authorizeTeamCredentialProviderModelCatalog({
            authenticatedBrokerAccountId: custodian.id,
            authority,
            expectedResourceRevision: resource.revision,
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: { ...request, requestId: 'request-connected-service-slot-substitution' },
            observedAt: new Date('2026-09-09T09:58:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [{ v: 1, slot: connectedServiceSlot, resourceId: null }, {
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                deliveryMode: 'brokered',
                teamId: team.id,
            }],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });

        // The model is a request fact the broker's request-policy owner decides
        // (L10/PLAN.md:438); the signed application's protocol is identity.
        for (const [requestId, requestFacts] of [
            ['request-protocol-substitution', { ...request.requestFacts, routeKind: 'anthropic_messages' as const }],
        ] as const) {
            await expect(admitTeamCredentialProviderBrokerRequest({
                authenticatedBrokerAccountId: custodian.id,
                request: { ...request, requestId, requestFacts },
                observedAt: new Date('2026-09-09T09:59:00.000Z'),
                brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
                verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
            })).resolves.toEqual({ ok: false, reasonCode: 'invalid_request' });
        }
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(0);

        await db.teamCredentialUsageLimit.create({ data: {
            resourceId: resource.id,
            subjectKind: 'resource',
            subjectId: '',
            period: 'day',
            metric: 'inference_requests',
            maximum: '1',
            createdAt: new Date('2026-09-09T09:00:00.000Z'),
        } });

        const firstAdmission = await admit();
        if (!firstAdmission.ok) throw new Error(`unexpected admission failure: ${firstAdmission.reasonCode}`);
        expect(firstAdmission).toMatchObject({
            ok: true,
            resourceId: resource.id,
            brokerMachineId: broker.id,
            operation: { kind: 'session', sessionId: session.id },
            usageEventId: expect.any(String),
        });
        await expect(admit()).resolves.toEqual({ ok: false, reasonCode: 'duplicate_request' });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: { ...request, requestId: 'request-2' },
            // A prior admission in the same millisecond is still recorded
            // usage; timestamp equality cannot create a second allowance.
            observedAt: new Date('2026-09-09T10:00:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toMatchObject({ ok: false, reasonCode: 'team_credential_usage_limit' });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);

        await db.machine.update({
            where: { id: worker.id },
            data: {
                operationProtocolCapabilities: {
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: 'e'.repeat(64) },
                },
                operationProtocolCapabilitiesRevision: { increment: 1 },
            },
        });
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: { ...request, requestId: 'request-worker-endpoint-rotated' },
            observedAt: new Date('2026-09-09T10:00:30.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toEqual({ ok: false, reasonCode: 'operation_not_current' });
        await db.machine.update({
            where: { id: worker.id },
            data: {
                operationProtocolCapabilities: {
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: workerEndpointId },
                },
                operationProtocolCapabilitiesRevision: { increment: 1 },
            },
        });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);
        // Team-restriction re-qualification on an existing stream is owned by
        // "re-qualifies the credential that opened an operation on every
        // request" below, which uses the real Team policy and factor owners.

        // Clearing the Session's selection through the canonical writer ends
        // the operation on its next request.
        const selectProviderModel = async (resourceId: string | null, expectedResourceRevision: number) =>
            await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                sessionId: session.id,
                accountId: requester.id,
                intents: [resourceId === null
                    ? { v: 1, slot: { kind: 'provider_model' }, resourceId: null }
                    : {
                        v: 1,
                        slot: { kind: 'provider_model' },
                        resourceId,
                        expectedResourceRevision,
                        deliveryMode: 'brokered',
                        teamId: team.id,
                    }],
                authentication: TEST_AUTHENTICATION,
            }));
        await expect(selectProviderModel(null, resource.revision)).resolves.toEqual({ ok: true });
        await expect(admit()).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(1);
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId: 'turn-1' } },
            select: {
                usageActorAccountId: true,
                teamCredentialResourceId: true,
                credentialDeliveryMode: true,
            },
        })).resolves.toEqual({
            usageActorAccountId: requester.id,
            teamCredentialResourceId: resource.id,
            credentialDeliveryMode: 'brokered',
        });

        // Revision-as-policy continuity (a stale request revision is refused,
        // the accepted witness admits at the current revision) is owned by
        // "keeps an established Session operation usable across a harmless
        // policy edit made by the real resource owner".
    });

    it('rechecks the exact Session-use policy on every broker request', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Broker session policy ${crypto.randomUUID()}` } });
        const requesterMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const workerEndpointId = 'c'.repeat(64);
        const brokerEndpointId = 'd'.repeat(64);
        const worker = await db.machine.create({ data: {
            id: `worker-policy-${requester.id}`, accountId: requester.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: workerEndpointId } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const broker = await db.machine.create({ data: {
            id: `broker-policy-${custodian.id}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: brokerEndpointId },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Team-context provider',
            enabled: true,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'team_context_required',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId: 'connection-policy',
                connectionSecurityFingerprint: 'connection-security:v1:policy',
                credentialSlotId: 'apiKey',
            }),
            brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        const session = await db.session.create({ data: {
            id: `session-policy-${requester.id}`,
            tag: `broker-policy-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            active: true,
            primaryTeamId: team.id,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id,
            machineId: worker.id,
            sessionId: session.id,
            data: '{}',
        } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [{
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                deliveryMode: 'brokered',
                teamId: team.id,
            }],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        await expect(applySessionTurnMutation({
            actorUserId: requester.id,
            authentication: TEST_AUTHENTICATION,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: 'begin-policy-turn-1',
                turnId: 'turn-1',
                action: 'begin',
                observedAt: 1,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: null } });
        const authority: SignedProviderBrokerRouteGrantV1 = {
            payload: {
                v: 1,
                grantId: `grant-policy-${requester.id}`,
                aud: 'happier-provider-broker-route-v1',
                issuedAt: 1,
                expiresAt: 2,
                teamId: team.id,
                resourceId: resource.id,
                sourceRevision: 'source-revision-1',
                brokerPlacementFingerprint: resolveTeamCredentialBrokerPlacementFingerprint(resource)!,
                initiatorTokenEpoch: requester.tokenEpoch,
                initiator: { accountId: requester.id, machineId: worker.id, endpointId: workerEndpointId },
                target: { custodianAccountId: custodian.id, machineId: broker.id, endpointId: brokerEndpointId },
                consumer: { kind: 'session', sessionId: session.id },
                application: {
                    agentTargetKey: 'codex',
                    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'openai-responses',
                    protocol: 'openai-responses',
                },
            },
            signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) },
        };
        const request: ProviderBrokerRequestAdmissionV1 = {
            v: 1,
            authority,
            expectedResourceRevision: resource.revision,
            sourceMemberKey: providerSourceMemberKey('connection-policy', 'apiKey'),
            requestId: `request-policy-${requester.id}`,
            requestFacts: { generation: false, routeKind: 'openai_responses', modelId: 'model-1', reasoningEffort: null },
        };
        // The Session binding witness exists and entitlement passes, but the
        // live Session no longer carries the required Team context.
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request,
            observedAt: new Date('2026-09-09T11:00:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        // Restoring the required Team context re-admits the same witness.
        await db.session.update({ where: { id: session.id }, data: { primaryTeamId: team.id } });
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request,
            observedAt: new Date('2026-09-09T11:00:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        })).resolves.toMatchObject({ ok: true, resourceId: resource.id });
    });

    it('keeps an established Session operation usable across a harmless policy edit made by the real resource owner', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Broker policy edit ${crypto.randomUUID()}` } });
        const requesterMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const workerEndpointId = 'e'.repeat(64);
        const brokerEndpointId = 'f'.repeat(64);
        const worker = await db.machine.create({ data: {
            id: `worker-revision-${requester.id}`, accountId: requester.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: workerEndpointId } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const broker = await db.machine.create({ data: {
            id: `broker-revision-${custodian.id}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: brokerEndpointId },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Policy-edited provider',
            enabled: true,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: 'provider_connection',
                connectionId: 'connection-revision',
                // The fingerprint the real Provider projection publishes for
                // this connection, so the real open can match its source.
                connectionSecurityFingerprint: 'connection-security:v1:connection-revision',
                credentialSlotId: 'apiKey',
            }),
            // The canonical persisted shape (`TeamCredentialRequestPolicyV1Schema`
            // is strict and unversioned), so the real update owner can read it.
            requestPolicyJson: JSON.stringify({ allowedModelIds: ['model-1'], allowedProtocolKinds: null, reasoningEffort: null }),
            brokerMachineId: broker.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        const session = await db.session.create({ data: {
            id: `session-revision-${requester.id}`,
            tag: `broker-revision-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            active: true,
            primaryTeamId: team.id,
            latestTurnId: 'turn-1',
            latestTurnStatus: 'in_progress',
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id,
            machineId: worker.id,
            sessionId: session.id,
            data: '{}',
        } });
        // The Session accepts the selection through the canonical writer, which
        // derives its witness server-side.
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [{
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                deliveryMode: 'brokered',
                teamId: team.id,
            }],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        // The signed claim comes from a real broker open against the resource
        // as it was. It names the operation, never the mutable revision
        // (`04-private-iroh-broker-transport.md:272`).
        const opened = await openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: TEST_AUTHENTICATION,
            request: {
                v: 1,
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                modelId: 'model-1',
                sourceRevision: 'source-revision-1',
                initiatorMachineId: worker.id,
                consumer: { kind: 'session', sessionId: session.id },
                application: FIXTURE_APPLICATION,
            },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            nowMs: 1,
            grantId: `grant-revision-${requester.id}`,
            signingKey: {
                keyId: 'fixture-home',
                secretKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43)).secretKey,
            },
            readProviderProjection: async () => fixtureProviderProjection('connection-revision'),
        });
        if (!opened.ok) throw new Error(`expected the broker open to succeed: ${opened.reasonCode}`);
        const authority = opened.authority;
        expect(authority.payload).not.toHaveProperty('expectedResourceRevision');
        const requestAt = (resourceRevision: number, requestId: string): ProviderBrokerRequestAdmissionV1 => ({
            v: 1,
            authority,
            expectedResourceRevision: resourceRevision,
            sourceMemberKey: providerSourceMemberKey('connection-revision', 'apiKey'),
            requestId,
            requestFacts: { generation: false, routeKind: 'openai_responses', modelId: 'model-1', reasoningEffort: null },
        });
        const admit = async (request: ProviderBrokerRequestAdmissionV1) => await admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request,
            observedAt: new Date('2026-09-09T11:00:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([broker.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === authority.payload.grantId,
        });
        await expect(admit(requestAt(resource.revision, `request-revision-1-${requester.id}`)))
            .resolves.toMatchObject({ ok: true, resourceId: resource.id });
        // The custodian (a Team owner) tightens the Session-use policy to the
        // Team context this Session already has — an authority edit that
        // advances the revision but still allows this use. Nothing about the
        // operation's identity changed, and no production writer advances the
        // Session's witness: the edit goes through the real resource owner only.
        const edited = await inTx(tx => updateTeamCredentialResourceInTx(tx, {
            actorAccountId: custodian.id,
            authentication: { authenticationAuthority: 'present_user', authenticationEvidence: [] },
            patch: {
                resourceId: resource.id,
                expectedRevision: resource.revision,
                sessionUsePolicy: 'team_context_required',
            },
        }));
        if (!edited.ok) throw new Error(`expected the policy edit to apply: ${edited.error}`);
        expect(edited.revision).toBe(resource.revision + 1);
        await expect(admit(requestAt(edited.revision, `request-revision-2-${requester.id}`)))
            .resolves.toMatchObject({ ok: true, resourceId: resource.id });
        // The same Session still passes its per-turn witness check at the
        // canonical Session admission, without re-selecting the resource.
        await expect(inTx(tx => admitSessionTeamCredentialBindingInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            slot: { kind: 'provider_model' },
            deliveryMode: 'brokered',
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toMatchObject({ ok: true, binding: { resourceRevision: edited.revision } });
        // The request still has to present the resource as it is now.
        await expect(admit(requestAt(resource.revision, `request-revision-3-${requester.id}`)))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
        // A credential-identity change is still an end of this claim.
        await expect(admit({
            ...requestAt(edited.revision, `request-revision-4-${requester.id}`),
            sourceMemberKey: providerSourceMemberKey('connection-revision', 'other-slot'),
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
        // So is losing access, removed through the real audience owner.
        await expect(inTx(tx => setTeamCredentialAudienceInTx(tx, {
            actorAccountId: custodian.id,
            input: {
                resourceId: resource.id,
                expectedRevision: edited.revision,
                allMembersDeliveryMode: null,
                groupGrants: [],
                memberGrants: [],
            },
            authentication: { authenticationAuthority: 'present_user', authenticationEvidence: [] },
        }))).resolves.toMatchObject({ ok: true });
        await expect(admit(requestAt(edited.revision, `request-revision-5-${requester.id}`)))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
    });

    it('selects a source-eligible Pool member once and keeps that exact Machine authoritative after membership edits', async () => {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: `Pool broker ${crypto.randomUUID()}` } });
        const requesterMembership = await db.teamMembership.create({
            data: { teamId: team.id, accountId: requester.id, role: 'member' },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
        const workerEndpointId = '1'.repeat(64);
        const primaryEndpointId = '2'.repeat(64);
        const fallbackEndpointId = '3'.repeat(64);
        const worker = await db.machine.create({ data: {
            id: `pool-worker-${requester.id}`, accountId: requester.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: workerEndpointId } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const brokerCapabilities = (endpointId: string) => ({
            providerBrokerIngress: { protocolVersions: [1] },
            irohMachineEndpoint: { protocolVersions: [1], endpointId },
        });
        const primary = await db.machine.create({ data: {
            id: `pool-primary-${custodian.id}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: brokerCapabilities(primaryEndpointId),
            operationProtocolCapabilitiesRevision: 1,
        } });
        const fallback = await db.machine.create({ data: {
            id: `pool-fallback-${custodian.id}`, accountId: custodian.id, metadata: '{}', kind: 'persistent', active: true,
            operationProtocolCapabilities: brokerCapabilities(fallbackEndpointId),
            operationProtocolCapabilitiesRevision: 1,
        } });
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: custodian.id,
            name: 'Broker locations',
            members: { create: [
                { machineId: primary.id, priorityTier: 0, enabled: true },
                { machineId: fallback.id, priorityTier: 1, enabled: true },
            ] },
        } });
        const source = {
            v: 1 as const,
            kind: 'provider_connection' as const,
            connectionId: 'pool-connection',
            connectionSecurityFingerprint: 'connection-security:v1:pool',
            credentialSlotId: 'apiKey',
        };
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id,
            custodianAccountId: custodian.id,
            displayName: 'Pool provider',
            enabled: true,
            revision: 1,
            disclosureCeiling: 'brokered_only',
            sessionUsePolicy: 'personal_allowed',
            sourceBindingJson: JSON.stringify(source),
            brokerPoolId: pool.id,
            memberGrants: { create: { teamMembershipId: requesterMembership.id, deliveryMode: 'brokered' } },
        } });
        const session = await db.session.create({ data: {
            id: `pool-session-${requester.id}`,
            tag: `pool-session-${requester.id}`,
            accountId: requester.id,
            metadata: '{}',
            active: true,
        } });
        await db.accessKey.create({ data: {
            accountId: requester.id,
            machineId: worker.id,
            sessionId: session.id,
            data: '{}',
        } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id,
            accountId: requester.id,
            intents: [{
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: resource.id,
                expectedResourceRevision: resource.revision,
                deliveryMode: 'brokered',
                teamId: team.id,
            }],
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true });
        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'openai-responses',
            protocol: 'openai-responses' as const,
        };
        const request: ProviderBrokerOpenRequestV1 = {
            v: 1,
            resourceId: resource.id,
            expectedResourceRevision: resource.revision,
            modelId: 'model-1',
            sourceRevision: 'source-revision-1',
            initiatorMachineId: worker.id,
            consumer: { kind: 'session', sessionId: session.id },
            application,
        };
        const projection = {
            status: 'success',
            agentTargetKey: application.agentTargetKey,
            groups: [{
                connectionId: source.connectionId,
                providerName: 'Provider', connectionName: 'Connection', connectionRole: 'default',
                connectionDisplayNameMode: 'automatic', connectionRevision: 1,
                sourceAuthority: {
                    provider: { identity: application.implementationIdentity, definitionRevision: 1 },
                    connectionSecurityFingerprint: source.connectionSecurityFingerprint,
                },
                sourceRevision: request.sourceRevision, modelLoadAction: 'available', modelLoadPreflightPolicy: null,
                authorization: { authorized: true }, manualModelPolicy: 'catalog-only',
                supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
                rows: [{
                    ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: source.connectionId, modelId: request.modelId },
                    descriptor: { id: request.modelId, name: 'Model 1' }, application,
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                    compatibility: {
                        result: { status: 'verified', selectedProtocol: application.protocol, evidence: { sourceUrls: ['https://example.com/provider'], verifiedAt: '2026-09-11' } },
                        compatibilityFingerprint: 'compatibility:v1:pool', confirmed: false,
                    },
                    endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
                }],
            }],
        };
        const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
        expect(() => DaemonProviderModelProjectionResponseV1Schema.parse(projection)).not.toThrow();

        await db.machinePoolMember.update({
            where: { poolId_machineId: { poolId: pool.id, machineId: fallback.id } },
            data: { priorityTier: 0 },
        });
        const ordinarySessionSelection = selectMachinePoolCandidate({
            purpose: 'session',
            members: [primary.id, fallback.id].map(machineId => ({ machineId, priorityTier: 0, enabled: true })),
            availableMachineIds: new Set([primary.id, fallback.id]),
            requestKey: [resource.id, 'session', session.id].join('\u0000'),
        });
        if (!ordinarySessionSelection) throw new Error('Expected ordinary Session Pool placement');
        const reviewedRunnerMachineId = ordinarySessionSelection.machineId === primary.id ? fallback.id : primary.id;
        const activationId = crypto.randomUUID();
        const homeServerIdentityId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        const installationPublicKeyBytes = new Uint8Array(32).fill(37);
        const installationPublicKey = Buffer.from(installationPublicKeyBytes).toString('base64url');
        await db.machine.update({
            where: { id: worker.id },
            data: {
                kind: 'ephemeral_session_runner',
                installationId,
                installationPublicKey: installationPublicKeyBytes,
            },
        });
        const runnerSelection = {
            v: 1 as const,
            request: {
                v: 1 as const,
                selection: {
                    kind: 'team_credential_provider_model' as const,
                    resourceId: resource.id,
                    teamId: team.id,
                    expectedResourceRevision: resource.revision,
                    deliveryMode: 'brokered' as const,
                    agentTargetKey: application.agentTargetKey,
                    modelId: request.modelId,
                },
                application,
                sourceRevision: request.sourceRevision,
                plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            },
            binding: {
                v: 1 as const,
                resourceId: resource.id,
                brokerMachineId: reviewedRunnerMachineId,
                revision: resource.revision,
                application,
                sourceRevision: request.sourceRevision,
            },
        };
        await db.ephemeralRunnerActivation.create({ data: {
            id: activationId,
            creatorAccountId: requester.id,
            creatorTokenEpoch: requester.tokenEpoch,
            draftId: crypto.randomUUID(),
            sessionId: session.id,
            machineId: worker.id,
            state: 'materialized',
            workspacePolicy: 'choose_on_endpoint',
            homeServerIdentityId,
            activationSigningPublicKey: Buffer.alloc(32, 11).toString('base64url'),
            authoringCommitment: Buffer.alloc(32, 12).toString('base64url'),
            artifact: {},
            endpointFactsRecipient: {},
            authenticationEvidence: {
                v: 1,
                evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
            credentialSelection: runnerSelection,
            review: {
                sealedLaunchManifest: 'sealed-runner-manifest',
                authoringCommitment: Buffer.alloc(32, 12).toString('base64url'),
                launchManifestCommitment: Buffer.alloc(32, 13).toString('base64url'),
                endpointFactsProof: {
                    activationSignature: Buffer.alloc(64, 14).toString('base64url'),
                    installationSignature: Buffer.alloc(64, 15).toString('base64url'),
                },
                agentTargetKey: application.agentTargetKey,
                machineContentKeyBinding: null,
                credentialSelectionBinding: runnerSelection.binding,
                displayFacts: {
                    v: 1,
                    homeId: homeServerIdentityId,
                    homeName: 'Runner Home',
                    requesterId: requester.id,
                    requesterName: 'Runner Creator',
                    teamId: team.id,
                    teamName: 'Runner Team',
                },
            },
        } });
        const runnerPrincipal = {
            kind: 'ephemeral_session_runner' as const,
            authority: 'session_runtime' as const,
            accountId: requester.id,
            activationId,
            sessionId: session.id,
            machineId: worker.id,
            installationId,
            installationPublicKey,
            creatorTokenEpoch: requester.tokenEpoch,
        };
        await db.machinePoolMember.delete({
            where: { poolId_machineId: { poolId: pool.id, machineId: reviewedRunnerMachineId } },
        });
        await expect(openRunnerTeamCredentialProviderBroker({
            principal: runnerPrincipal,
            actorAccountId: requester.id,
            authentication: {
                env: process.env,
                authority: 'account_automation',
                authenticationEvidence: [],
                sessionRuntimePrincipal: runnerPrincipal,
            },
            request: { ...request, modelId: 'forged-model' },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([primary.id, fallback.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'runner-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async () => {
                throw new Error('forged Runner open must fail before Pool selection');
            },
            readProviderProjection: async () => {
                throw new Error('forged Runner open must fail before provider projection');
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        const runnerOpen = await openRunnerTeamCredentialProviderBroker({
            principal: runnerPrincipal,
            actorAccountId: requester.id,
            authentication: {
                env: process.env,
                authority: 'account_automation',
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
                sessionRuntimePrincipal: runnerPrincipal,
            },
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([primary.id, fallback.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'runner-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async () => {
                throw new Error('reviewed Runner selection must not enumerate or rerank its Pool');
            },
            readProviderProjection: async input => {
                expect(input.brokerMachineId).toBe(reviewedRunnerMachineId);
                return projection;
            },
        });
        if (!runnerOpen.ok) throw new Error(`expected reviewed Runner broker open: ${runnerOpen.reasonCode}`);
        expect(runnerOpen.target.brokerMachineId).toBe(reviewedRunnerMachineId);
        expect(runnerOpen.target.brokerMachineId).not.toBe(ordinarySessionSelection.machineId);
        const admitRunner = (requestId: string) => admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: {
                v: 1,
                authority: runnerOpen.authority,
                expectedResourceRevision: resource.revision,
                sourceMemberKey: providerSourceMemberKey(source.connectionId, source.credentialSlotId),
                requestId,
                requestFacts: {
                    generation: false,
                    routeKind: 'openai_responses',
                    modelId: request.modelId,
                    reasoningEffort: null,
                },
            },
            observedAt: new Date(1),
            brokerPresence: { state: 'known', machineIds: new Set([reviewedRunnerMachineId]) },
            verifyAuthority: candidate => candidate.payload.grantId === runnerOpen.authority.payload.grantId,
        });
        await expect(admitRunner('runner-current')).resolves.toMatchObject({ ok: true });
        await db.account.update({ where: { id: requester.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(admitRunner('runner-creator-epoch-revoked')).resolves.toEqual({
            ok: false,
            reasonCode: 'operation_not_current',
        });
        await db.account.update({ where: { id: requester.id }, data: { tokenEpoch: requester.tokenEpoch } });
        await db.machinePoolMember.create({ data: {
            poolId: pool.id,
            machineId: reviewedRunnerMachineId,
            priorityTier: 0,
            enabled: true,
        } });

        const members = [primary.id, fallback.id].map(machineId => ({ machineId, priorityTier: 0, enabled: true }));
        const availableMachineIds = new Set([primary.id, fallback.id]);
        const runByMachineId = new Map<string, string>();
        for (let index = 0; runByMachineId.size < 2 && index < 1_000; index += 1) {
            const executionRunId = `pool-run-${index}`;
            const selected = selectMachinePoolCandidate({
                purpose: 'session',
                members,
                availableMachineIds,
                requestKey: [resource.id, 'execution_run', executionRunId].join('\u0000'),
            });
            if (selected) runByMachineId.set(selected.machineId, executionRunId);
        }
        expect(runByMachineId.size).toBe(2);
        for (const [expectedMachineId, executionRunId] of runByMachineId) {
            const runOpen = await openTeamCredentialProviderBroker({
                actorAccountId: requester.id,
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
                request: { ...request, consumer: { kind: 'execution_run', executionRunId } },
                initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
                brokerPresence: { state: 'known', machineIds: availableMachineIds },
                nowMs: 1,
                grantId: crypto.randomUUID(),
                signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
                resolveExecutionRunCurrentness: async () => ({
                    ok: true,
                    parentSessionId: session.id,
                    occurrenceId: `occurrence-${executionRunId}`,
                    intent: 'agent',
                    runtimeState: 'active_turn',
                    teamCredentialProviderModel: { resourceId: request.resourceId, deliveryMode: 'brokered' as const },
                }),
                readPoolSourceEligibility: async () => ({ eligibleMachineIds: availableMachineIds, reasons: new Map() }),
                readProviderProjection: async () => projection,
            });
            if (!runOpen.ok) throw new Error(`expected Execution Run Pool broker open: ${runOpen.reasonCode}`);
            expect(runOpen.target.brokerMachineId).toBe(expectedMachineId);
            expect(runOpen.authority.payload).toMatchObject({
                consumer: { kind: 'execution_run', executionRunId },
                executionRunOccurrenceId: `occurrence-${executionRunId}`,
            });
        }

        const slowTarget = [...runByMachineId.entries()][0];
        if (!slowTarget) throw new Error('expected a Pool target for the slow RPC topology test');
        const [slowExpectedMachineId, slowExecutionRunId] = slowTarget;
        const previousTransactionTimeout = process.env.HAPPIER_DB_TX_TIMEOUT_MS;
        const previousTransactionRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_TIMEOUT_MS = '1000';
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        let slowCurrentnessCalls = 0;
        let slowEligibilityCalls = 0;
        let slowProjectionCalls = 0;
        const delayBeyondTransactionTimeout = () => new Promise<void>(resolve => setTimeout(resolve, 1_250));
        try {
            const slowOpen = await openTeamCredentialProviderBroker({
                actorAccountId: requester.id,
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
                request: { ...request, consumer: { kind: 'execution_run', executionRunId: slowExecutionRunId } },
                initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
                brokerPresence: { state: 'known', machineIds: availableMachineIds },
                nowMs: 1,
                grantId: crypto.randomUUID(),
                signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
                resolveExecutionRunCurrentness: async () => {
                    slowCurrentnessCalls += 1;
                    await delayBeyondTransactionTimeout();
                    return {
                        ok: true,
                        parentSessionId: session.id,
                        occurrenceId: `slow-occurrence-${slowExecutionRunId}`,
                        intent: 'agent',
                        runtimeState: 'active_turn',
                        teamCredentialProviderModel: { resourceId: request.resourceId, deliveryMode: 'brokered' as const },
                    };
                },
                readPoolSourceEligibility: async () => {
                    slowEligibilityCalls += 1;
                    await delayBeyondTransactionTimeout();
                    return { eligibleMachineIds: new Set([slowExpectedMachineId]), reasons: new Map() };
                },
                readProviderProjection: async () => {
                    slowProjectionCalls += 1;
                    await delayBeyondTransactionTimeout();
                    return projection;
                },
            });
            if (!slowOpen.ok) throw new Error(`expected slow RPC broker open: ${slowOpen.reasonCode}`);
            expect(slowOpen.target.brokerMachineId).toBe(slowExpectedMachineId);
            expect(slowOpen.authority.payload.executionRunOccurrenceId).toBe(`slow-occurrence-${slowExecutionRunId}`);
            expect({ slowCurrentnessCalls, slowEligibilityCalls, slowProjectionCalls }).toEqual({
                slowCurrentnessCalls: 2,
                slowEligibilityCalls: 1,
                slowProjectionCalls: 1,
            });
        } finally {
            if (previousTransactionTimeout === undefined) delete process.env.HAPPIER_DB_TX_TIMEOUT_MS;
            else process.env.HAPPIER_DB_TX_TIMEOUT_MS = previousTransactionTimeout;
            if (previousTransactionRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousTransactionRetries;
        }

        const eligibilityCalls: unknown[] = [];
        let announceEligibility!: () => void;
        let releaseEligibility!: () => void;
        const eligibilityStarted = new Promise<void>((resolve) => { announceEligibility = resolve; });
        const eligibilityReleased = new Promise<void>((resolve) => { releaseEligibility = resolve; });
        const racingOpen = openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([primary.id, fallback.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async () => {
                announceEligibility();
                await eligibilityReleased;
                return { eligibleMachineIds: new Set([fallback.id]), reasons: new Map() };
            },
            readProviderProjection: async () => projection,
        });
        await eligibilityStarted;
        await db.machinePoolMember.update({
            where: { poolId_machineId: { poolId: pool.id, machineId: fallback.id } },
            data: { enabled: false },
        });
        releaseEligibility();
        await expect(racingOpen).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });
        await db.machinePoolMember.update({
            where: { poolId_machineId: { poolId: pool.id, machineId: fallback.id } },
            data: { enabled: true },
        });

        const projectionRacePresence = new Set([primary.id, fallback.id]);
        await expect(openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: projectionRacePresence },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async () => ({
                eligibleMachineIds: new Set([fallback.id]),
                reasons: new Map(),
            }),
            readProviderProjection: async () => {
                projectionRacePresence.delete(fallback.id);
                return projection;
            },
        })).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });

        let announceEndpointProjection!: () => void;
        let releaseEndpointProjection!: () => void;
        const endpointProjectionStarted = new Promise<void>(resolve => { announceEndpointProjection = resolve; });
        const endpointProjectionReleased = new Promise<void>(resolve => { releaseEndpointProjection = resolve; });
        const endpointRotationRace = openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: TEST_AUTHENTICATION,
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([primary.id, fallback.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async () => ({
                eligibleMachineIds: new Set([fallback.id]),
                reasons: new Map(),
            }),
            readProviderProjection: async () => {
                announceEndpointProjection();
                await endpointProjectionReleased;
                return projection;
            },
        });
        await endpointProjectionStarted;
        await db.machine.update({
            where: { id: fallback.id },
            data: {
                operationProtocolCapabilities: brokerCapabilities('6'.repeat(64)),
                operationProtocolCapabilitiesRevision: { increment: 1 },
            },
        });
        releaseEndpointProjection();
        await expect(endpointRotationRace).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });
        await db.machine.update({
            where: { id: fallback.id },
            data: {
                operationProtocolCapabilities: brokerCapabilities(fallbackEndpointId),
                operationProtocolCapabilitiesRevision: { increment: 1 },
            },
        });

        let announcePersistedProjection!: () => void;
        let releasePersistedProjection!: () => void;
        const persistedProjectionStarted = new Promise<void>((resolve) => { announcePersistedProjection = resolve; });
        const persistedProjectionReleased = new Promise<void>((resolve) => { releasePersistedProjection = resolve; });
        const persistedProjectionRace = openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([primary.id, fallback.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async () => ({
                eligibleMachineIds: new Set([fallback.id]),
                reasons: new Map(),
            }),
            readProviderProjection: async () => {
                announcePersistedProjection();
                await persistedProjectionReleased;
                return projection;
            },
        });
        await persistedProjectionStarted;
        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { revision: { increment: 1 } },
        });
        releasePersistedProjection();
        await expect(persistedProjectionRace).resolves.toEqual({ ok: false, reasonCode: 'resource_changed' });
        await db.teamCredentialResource.update({
            where: { id: resource.id },
            data: { revision: resource.revision },
        });

        const opened = await openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request,
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([primary.id, fallback.id]) },
            nowMs: 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            readPoolSourceEligibility: async input => {
                eligibilityCalls.push(input);
                return {
                    eligibleMachineIds: new Set([fallback.id]),
                    reasons: new Map([[primary.id, 'model_unavailable']]),
                };
            },
            readProviderProjection: async input => {
                expect(input.brokerMachineId).toBe(fallback.id);
                return projection;
            },
        });
        if (!opened.ok) throw new Error(`expected Pool broker open: ${opened.reasonCode}`);
        expect(opened).toMatchObject({
            ok: true,
            target: { custodianAccountId: custodian.id, brokerMachineId: fallback.id, endpointId: fallbackEndpointId },
        });
        expect(eligibilityCalls).toEqual([expect.objectContaining({
            custodianAccountId: custodian.id,
            machineIds: expect.arrayContaining([primary.id, fallback.id]),
            teamId: team.id,
            resourceId: resource.id,
            resourceRevision: resource.revision,
            source,
            application,
            modelId: request.modelId,
            sourceRevision: request.sourceRevision,
            signal: expect.any(AbortSignal),
        })]);

        // Pool membership is selection input for a new open, not an ongoing ACL:
        // emptying the Pool entirely must leave this established operation — its
        // relayed requests and its renewal alike — on the exact Machine its open
        // selected, and only that Machine's own revocation may end it.
        await db.machinePoolMember.delete({ where: { poolId_machineId: { poolId: pool.id, machineId: fallback.id } } });
        await db.machinePoolMember.delete({ where: { poolId_machineId: { poolId: pool.id, machineId: primary.id } } });
        const admissionRequest: ProviderBrokerRequestAdmissionV1 = {
            v: 1,
            authority: opened.authority,
            expectedResourceRevision: resource.revision,
            sourceMemberKey: providerSourceMemberKey(source.connectionId, source.credentialSlotId),
            requestId: crypto.randomUUID(),
            requestFacts: { generation: false, routeKind: 'openai_responses', modelId: request.modelId, reasoningEffort: null },
        };
        await expect(admitTeamCredentialProviderBrokerRequest({
            authenticatedBrokerAccountId: custodian.id,
            request: admissionRequest,
            observedAt: new Date('2026-09-11T10:00:00.000Z'),
            brokerPresence: { state: 'known', machineIds: new Set([fallback.id]) },
            verifyAuthority: candidate => candidate.payload.grantId === opened.authority.payload.grantId,
        })).resolves.toMatchObject({ ok: true, brokerMachineId: fallback.id });

        const refreshed = await openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request: { ...request, refreshAuthority: opened.authority },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([fallback.id]) },
            nowMs: opened.authority.payload.expiresAt + 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            verifyRefreshAuthority: candidate => candidate.payload.grantId === opened.authority.payload.grantId,
            readPoolSourceEligibility: async () => {
                throw new Error('refresh_must_not_rerank_pool');
            },
            readProviderProjection: async input => {
                expect(input.brokerMachineId).toBe(fallback.id);
                return projection;
            },
        });
        if (!refreshed.ok) throw new Error(`expected pinned Pool broker refresh: ${refreshed.reasonCode}`);
        expect(refreshed.authority.payload.grantId).not.toBe(opened.authority.payload.grantId);
        expect(refreshed.authority.payload.expiresAt).toBeGreaterThan(opened.authority.payload.expiresAt);
        expect(refreshed.target.brokerMachineId).toBe(fallback.id);

        await db.machine.update({ where: { id: fallback.id }, data: { revokedAt: new Date() } });
        await expect(openTeamCredentialProviderBroker({
            actorAccountId: requester.id,
            authentication: { env: process.env, authority: 'present_user', authenticationEvidence: [] },
            request: { ...request, refreshAuthority: refreshed.authority },
            initiatorPresence: { state: 'known', machineIds: new Set([worker.id]) },
            brokerPresence: { state: 'known', machineIds: new Set([fallback.id]) },
            nowMs: refreshed.authority.payload.expiresAt + 1,
            grantId: crypto.randomUUID(),
            signingKey: { keyId: 'test-home', secretKey: signingKey.secretKey },
            verifyRefreshAuthority: () => true,
            readPoolSourceEligibility: async () => {
                throw new Error('revoked refresh must not rerank pool');
            },
            readProviderProjection: async () => projection,
        })).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });
        await db.machine.update({ where: { id: fallback.id }, data: { revokedAt: null } });

        const beforeDeleteChanges = await db.accountChange.count({
            where: { accountId: requester.id, entityId: 'teams' },
        });
        const poolIo: MachineDaemonPresenceSocketServer = { in: () => ({ fetchSockets: async () => [] }) };
        await expect(deleteMachinePool({
            accountId: custodian.id,
            input: { poolId: pool.id, expectedRevision: pool.revision },
            io: poolIo,
        })).resolves.toEqual({ ok: true, value: { poolId: pool.id, deleted: true } });
        await expect(db.teamCredentialResource.findUniqueOrThrow({
            where: { id: resource.id },
            select: { brokerMachineId: true, brokerPoolId: true, revision: true },
        })).resolves.toEqual({ brokerMachineId: null, brokerPoolId: null, revision: resource.revision + 1 });
        expect(await db.accountChange.count({
            where: { accountId: requester.id, entityId: 'teams' },
        })).toBeGreaterThan(beforeDeleteChanges);
        // Deleting the Pool removes the resource's broker placement, which ends
        // the established operation because the resource names no broker any
        // more — not because its policy revision moved. A request presenting the
        // current revision is refused for the same reason.
        for (const [requestId, expectedResourceRevision] of [
            [crypto.randomUUID(), resource.revision],
            [crypto.randomUUID(), resource.revision + 1],
        ] as const) {
            await expect(admitTeamCredentialProviderBrokerRequest({
                authenticatedBrokerAccountId: custodian.id,
                request: { ...admissionRequest, requestId, expectedResourceRevision },
                observedAt: new Date('2026-09-11T10:01:00.000Z'),
                brokerPresence: { state: 'known', machineIds: new Set([fallback.id]) },
                verifyAuthority: candidate => candidate.payload.grantId === opened.authority.payload.grantId,
            })).resolves.toEqual({ ok: false, reasonCode: 'broker_unavailable' });
        }
    });

    it('re-qualifies the credential that opened an operation on every request, so revocation ends the next request on the existing stream', async () => {
        // The requester is a keyed Account, so it keeps a login route after it
        // removes its password through the real Account Security route below.
        const requesterSigning = tweetnacl.sign.keyPair();
        const fixture = await createBrokerFixture('requalify', {
            requesterPublicKeyHex: privacyKit.encodeHex(new Uint8Array(requesterSigning.publicKey)),
        });
        const resource = await fixture.createResource('connection-requalify');
        const session = await fixture.createSession();
        const passwordEvidence = [{ kind: 'home_method', methodId: 'email_password' }] as const;
        // Both Accounts hold a native email/password factor, so a credential
        // that authenticated with it carries current `email_password` evidence.
        const requesterEmail = `requester-${fixture.requester.id}@example.test`;
        await db.accountIdentity.create({ data: {
            accountId: fixture.requester.id, provider: 'email', providerUserId: requesterEmail, profile: {},
        } });
        await db.accountEmail.create({ data: {
            accountId: fixture.requester.id, normalizedEmail: requesterEmail, address: requesterEmail,
        } });
        const field = (length: number) => encodePasswordCredentialFieldV1(new Uint8Array(length));
        await db.accountPasswordCredential.create({ data: { accountId: fixture.requester.id, credential: {
            v: 1,
            kind: 'e2ee_password_envelope',
            authVerifier: { v: 1, hash: await hashPasswordMaterial(new Uint8Array(32)) },
            envelope: {
                v: 1,
                accountSigningPublicKey: encodePasswordCredentialFieldV1(new Uint8Array(requesterSigning.publicKey)),
                kdf: { algorithm: 'argon2id13', salt: field(16), opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
                cipher: { algorithm: 'aes256gcm', nonce: field(12), ciphertext: field(48) },
            },
        } } });
        await db.accountIdentity.create({ data: {
            accountId: fixture.custodian.id,
            provider: 'email',
            providerUserId: `custodian-${fixture.custodian.id}@example.test`,
            profile: {},
        } });
        await db.accountPasswordCredential.create({ data: { accountId: fixture.custodian.id, credential: {
            v: 1,
            kind: 'plain_password_hash',
            hash: await hashPasswordMaterial(new TextEncoder().encode('custodian password factor')),
        } } });
        // The requester's password-authenticated credential, and the evidence
        // the Home verified on it.
        const requesterToken = await auth.createToken(fixture.requester.id, undefined, {
            kind: 'account',
            authority: 'present_user',
            authenticationEvidence: [...passwordEvidence],
        });
        const withPassword = {
            env: process.env,
            authority: 'present_user',
            authenticationEvidence: passwordEvidence,
        } as const;
        await fixture.selectForSession(session.id, resource, TEST_AUTHENTICATION);

        // Two credentials of the same Account open two operations while the
        // Team still inherits the Home's methods.
        const unqualifiedOpen = await fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION });
        const qualifiedOpen = await fixture.open({ resource, sessionId: session.id, authentication: withPassword });
        if (!unqualifiedOpen.ok || !qualifiedOpen.ok) throw new Error('expected both broker opens');
        expect(unqualifiedOpen.authority.payload.verifiedCredentialEvidence).toBeUndefined();
        expect(qualifiedOpen.authority.payload.verifiedCredentialEvidence).toEqual({
            v: 1,
            evidence: passwordEvidence,
        });
        const usage = () => db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } });
        await expect(fixture.admit({ authority: unqualifiedOpen.authority, resource, requestId: 'unqualified-1' }))
            .resolves.toMatchObject({ ok: true, operation: { kind: 'session', sessionId: session.id } });
        await expect(fixture.admit({ authority: qualifiedOpen.authority, resource, requestId: 'qualified-1' }))
            .resolves.toMatchObject({ ok: true, operation: { kind: 'session', sessionId: session.id } });
        expect(await usage()).toBe(2);

        // The Team owner restricts the Team to email/password through the real
        // Team policy owner. Each existing stream keeps its signed authority;
        // its next request re-qualifies the exact credential that opened it.
        // The Account holding a password does not qualify the credential that
        // never presented it.
        await expect(inTx(tx => setTeamPolicyInTx(tx, {
            actorAccountId: fixture.custodian.id,
            teamId: fixture.team.id,
            previousAuthenticationPolicy: null,
            authenticationPolicy: {
                v: 1,
                mode: 'restricted',
                accepted: [{ kind: 'home_method', methodId: 'email_password' }],
            },
            authentication: { authenticationAuthority: 'present_user', authenticationEvidence: [...passwordEvidence] },
        }))).resolves.toMatchObject({ ok: true });
        await expect(fixture.admit({ authority: unqualifiedOpen.authority, resource, requestId: 'unqualified-2' }))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await expect(fixture.catalog({ authority: unqualifiedOpen.authority, resource }))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await expect(fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION }))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await expect(fixture.admit({ authority: qualifiedOpen.authority, resource, requestId: 'qualified-2' }))
            .resolves.toMatchObject({ ok: true });
        await expect(fixture.catalog({ authority: qualifiedOpen.authority, resource }))
            .resolves.toEqual({ ok: true });
        expect(await usage()).toBe(3);

        // The requester removes the qualifying password factor through the
        // real Account Security route. The qualified stream's very next request
        // is refused — before any usage is recorded or anything is forwarded —
        // although the stream and its signed authority are unchanged.
        const challenge = await issuePasswordMutationKeyChallengeV1({ env: process.env, mutation: {
            v: 1, action: 'remove', accountId: fixture.requester.id, expectedCredentialRevision: 1,
            normalizedNativeEmail: requesterEmail, newCredentialDigest: null,
        } });
        if (!challenge) throw new Error('password mutation challenge unavailable');
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        emailPasswordAuthMethodModule.registerRoutes(app);
        await app.ready();
        try {
            const removed = await app.inject({
                method: 'POST',
                url: '/v1/account/password/remove',
                headers: { authorization: `Bearer ${requesterToken}` },
                payload: {
                    v: 1,
                    kind: 'e2ee',
                    expectedCredentialRevision: 1,
                    proof: {
                        challengeId: challenge.challengeId,
                        publicKey: privacyKit.encodeBase64(new Uint8Array(requesterSigning.publicKey)),
                        signature: privacyKit.encodeBase64(new Uint8Array(tweetnacl.sign.detached(
                            createPasswordMutationChallengeSigningInputV1(challenge),
                            requesterSigning.secretKey,
                        ))),
                    },
                },
            });
            expect(removed.statusCode, removed.body).toBe(200);
        } finally {
            await app.close();
        }
        await expect(fixture.admit({ authority: qualifiedOpen.authority, resource, requestId: 'qualified-3' }))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        await expect(fixture.catalog({ authority: qualifiedOpen.authority, resource }))
            .resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect(await usage()).toBe(3);
    });

    it('authorizes an attached Run against its own selection, never its parent Session selection', async () => {
        const fixture = await createBrokerFixture('attached-run');
        const parentResource = await fixture.createResource('connection-parent-a');
        const runResource = await fixture.createResource('connection-run-b');
        const laterParentResource = await fixture.createResource('connection-parent-c');
        const session = await fixture.createSession();
        await fixture.selectForSession(session.id, parentResource, TEST_AUTHENTICATION);
        let runCurrent = true;
        const resolveRun: NonNullable<OpenInput['resolveExecutionRunCurrentness']> = async () => runCurrent
            ? {
                ok: true,
                parentSessionId: session.id,
                occurrenceId: 'run-b-occurrence',
                intent: 'agent',
                runtimeState: 'active_turn',
                teamCredentialProviderModel: { resourceId: runResource.id, deliveryMode: 'brokered' as const },
                activeTurnId: 'run-b-turn',
            }
            : { ok: false, reasonCode: 'execution_run_terminal' };

        // The Run independently selected B while its parent Session uses A.
        const opened = await fixture.open({
            resource: runResource,
            consumer: { kind: 'execution_run', executionRunId: 'run-b' },
            authentication: TEST_AUTHENTICATION,
            resolveExecutionRunCurrentness: resolveRun,
        });
        if (!opened.ok) throw new Error(`expected the attached Run to open its own selection: ${opened.reasonCode}`);
        await expect(fixture.admit({
            authority: opened.authority,
            resource: runResource,
            requestId: 'run-b-1',
            generation: true,
            resolveExecutionRunCurrentness: resolveRun,
        })).resolves.toMatchObject({ ok: true, operation: { kind: 'execution_run', executionRunId: 'run-b' } });

        // The parent later switches A → C. The Run keeps its own selection, and
        // its parent's accepted selection is never rewritten to B.
        await fixture.selectForSession(session.id, laterParentResource, TEST_AUTHENTICATION);
        await expect(fixture.admit({
            authority: opened.authority,
            resource: runResource,
            requestId: 'run-b-2',
            generation: true,
            resolveExecutionRunCurrentness: resolveRun,
        })).resolves.toMatchObject({ ok: true, operation: { kind: 'execution_run', executionRunId: 'run-b' } });
        await expect(inTx(tx => readSessionTeamCredentialBindingInTx(tx, {
            sessionId: session.id,
            slot: { kind: 'provider_model' },
            deliveryMode: 'brokered',
        }))).resolves.toMatchObject({ resourceId: laterParentResource.id });

        // The Run's own authority still ends: once it is terminal, its next
        // request is refused before usage.
        runCurrent = false;
        await expect(fixture.admit({
            authority: opened.authority,
            resource: runResource,
            requestId: 'run-b-3',
            generation: true,
            resolveExecutionRunCurrentness: resolveRun,
        })).resolves.toEqual({ ok: false, reasonCode: 'execution_run_terminal' });
        runCurrent = true;
        // So does losing the grant to B, whatever the parent selected; the
        // grant is removed through the real audience owner.
        await expect(inTx(tx => setTeamCredentialAudienceInTx(tx, {
            actorAccountId: fixture.custodian.id,
            input: {
                resourceId: runResource.id,
                expectedRevision: runResource.revision,
                allMembersDeliveryMode: null,
                groupGrants: [],
                memberGrants: [],
            },
            authentication: { authenticationAuthority: 'present_user', authenticationEvidence: [] },
        }))).resolves.toMatchObject({ ok: true });
        await expect(fixture.admit({
            authority: opened.authority,
            resource: runResource,
            requestId: 'run-b-4',
            generation: true,
            resolveExecutionRunCurrentness: resolveRun,
        })).resolves.toEqual({ ok: false, reasonCode: 'resource_forbidden' });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: runResource.id } })).toBe(2);
    });

    it('serves every model its resource allows on one signed open: the model is a request fact, never signed', async () => {
        // L10/04:270 — "Do not add model ids ... those are current request/
        // placement facts and signing copies would go stale." The model policy
        // itself is the broker's one request-policy owner (PLAN.md:438 "Home
        // does not become another model/effort/cap evaluator").
        const fixture = await createBrokerFixture('model-request-fact');
        const resource = await fixture.createResource('connection-models');
        const session = await fixture.createSession();
        await fixture.selectForSession(session.id, resource, TEST_AUTHENTICATION);
        const opened = await fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION });
        if (!opened.ok) throw new Error(`expected the broker open to succeed: ${opened.reasonCode}`);
        expect(opened.authority.payload).not.toHaveProperty('modelId');

        // One stream's requests name different models; each is admitted on the
        // same signed operation.
        for (const modelId of ['model-1', 'model-2']) {
            await expect(fixture.admit({ authority: opened.authority, resource, requestId: `request-${modelId}`, modelId }))
                .resolves.toMatchObject({ ok: true, resourceId: resource.id });
        }
        // The Session later selects model-2 of the same resource: renewing the
        // carrier presents the claim it holds, and the Home re-signs it.
        const renewed = await fixture.open({
            resource,
            sessionId: session.id,
            authentication: TEST_AUTHENTICATION,
            modelId: 'model-2',
            refreshAuthority: opened.authority,
        });
        expect(renewed).toMatchObject({ ok: true, target: { brokerMachineId: opened.target.brokerMachineId } });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: resource.id } })).toBe(2);
    });

    it('admits an attached Run only on the selection its own Run owner attests, or its parent Session selection when it inherits', async () => {
        // L10/PLAN §2.3 — "one open ... per independently owned Execution Run
        // binding"; L10/01 principle 3 — the Run mutation owns its own intent.
        const fixture = await createBrokerFixture('run-owner-selection');
        const parentResource = await fixture.createResource('connection-owner-parent');
        const runResource = await fixture.createResource('connection-owner-run');
        const otherResource = await fixture.createResource('connection-owner-other');
        const session = await fixture.createSession();
        await fixture.selectForSession(session.id, parentResource, TEST_AUTHENTICATION);
        let attested: Readonly<{ resourceId: string; deliveryMode: 'brokered' | 'direct' }> | null = {
            resourceId: runResource.id,
            deliveryMode: 'brokered',
        };
        // The real Home resolver; only the worker daemon RPC is the boundary.
        const resolveRun = createExecutionRunBrokerCurrentnessResolver({
            app: {
                forwardRpcForUser: async ({ params }: Readonly<{ params: Record<string, unknown> }>) => ({
                    ok: true as const,
                    result: {
                        status: 'current',
                        requestNonce: params.requestNonce,
                        serverIdentityId: params.serverIdentityId,
                        requestingAccountId: params.requestingAccountId,
                        workerMachineId: params.workerMachineId,
                        executionRunId: params.executionRunId,
                        occurrenceId: 'run-owner-occurrence',
                        parentSessionId: session.id,
                        intent: 'agent',
                        runtimeState: 'active_turn',
                        activeTurnId: 'run-owner-turn',
                        teamCredentialProviderModel: attested,
                    },
                }),
            } as never,
            resolveServerIdentityId: async () => 'srv_home_run_owner',
            createNonce: () => crypto.randomUUID(),
        });
        const openFor = async (resource: typeof runResource) => await fixture.open({
            resource,
            consumer: { kind: 'execution_run', executionRunId: 'run-owner' },
            authentication: TEST_AUTHENTICATION,
            resolveExecutionRunCurrentness: resolveRun,
        });

        const opened = await openFor(runResource);
        if (!opened.ok) throw new Error(`expected the Run to open its own selection: ${opened.reasonCode}`);
        await expect(fixture.admit({
            authority: opened.authority,
            resource: runResource,
            requestId: 'run-owner-1',
            generation: true,
            resolveExecutionRunCurrentness: resolveRun,
        })).resolves.toMatchObject({ ok: true, operation: { kind: 'execution_run', executionRunId: 'run-owner' } });
        // Another resource the requester is entitled to is not this Run's
        // selection, and neither is its parent Session's.
        await expect(openFor(otherResource)).resolves.toMatchObject({ ok: false });
        await expect(openFor(parentResource)).resolves.toMatchObject({ ok: false });
        // A Run whose own selection moved off this resource loses the claim on
        // its next request.
        attested = { resourceId: otherResource.id, deliveryMode: 'brokered' };
        await expect(fixture.admit({
            authority: opened.authority,
            resource: runResource,
            requestId: 'run-owner-2',
            generation: true,
            resolveExecutionRunCurrentness: resolveRun,
        })).resolves.toMatchObject({ ok: false });
        // A direct selection is not a brokered one.
        attested = { resourceId: runResource.id, deliveryMode: 'direct' };
        await expect(openFor(runResource)).resolves.toMatchObject({ ok: false });
        // A Run that selected nothing inherits its parent Session's accepted
        // selection, and only that.
        attested = null;
        await expect(openFor(parentResource)).resolves.toMatchObject({ ok: true });
        await expect(openFor(runResource)).resolves.toMatchObject({ ok: false });
        expect(await db.usageEvent.count({ where: { teamCredentialResourceId: runResource.id } })).toBe(1);
    });

    it('serves a source its custodian shares only with Bob: the broker reads its own resource, never a recipient catalog', async () => {
        // The custodian (a Team owner) offers its source to the requester only
        // and never grants itself recipient rights.
        const fixture = await createBrokerFixture('source-only-bob');
        const resource = await fixture.createResource('connection-source-only-bob');
        const session = await fixture.createSession();
        const custodianAuthentication = { authenticationAuthority: 'present_user', authenticationEvidence: [] } as const;

        // Source ownership is not recipient entitlement: the custodian's
        // recipient catalog does not list the resource...
        const custodianCatalog = await inTx(tx => readTeamCredentialCatalogInTx(tx, {
            teamId: fixture.team.id,
            actorAccountId: fixture.custodian.id,
            authentication: custodianAuthentication,
        }));
        if (!custodianCatalog.ok) throw new Error(`expected the custodian catalog read: ${custodianCatalog.error}`);
        expect(custodianCatalog.page.resources.map(entry => entry.id)).not.toContain(resource.id);
        // ...although Bob's recipient catalog does.
        const recipientCatalog = await inTx(tx => readTeamCredentialCatalogInTx(tx, {
            teamId: fixture.team.id,
            actorAccountId: fixture.requester.id,
            authentication: custodianAuthentication,
        }));
        if (!recipientCatalog.ok) throw new Error(`expected the recipient catalog read: ${recipientCatalog.error}`);
        expect(recipientCatalog.page.resources.map(entry => entry.id)).toContain(resource.id);
        // ...while the resource read its broker uses (`teams.credentials.get`)
        // gives the custodian its own source, from which the broker projects
        // the canonical source catalog.
        const administration = await inTx(tx => readTeamCredentialResourceAdministrationInTx(tx, {
            resourceId: resource.id,
            actorAccountId: fixture.custodian.id,
            authentication: custodianAuthentication,
        }));
        if (!administration.ok) throw new Error(`expected the custodian resource read: ${administration.error}`);
        expect(administration.resource).toMatchObject({
            id: resource.id,
            revision: resource.revision,
            source: JSON.parse(resource.sourceBindingJson),
        });

        // Bob, the only recipient, opens and is admitted per request by the Home.
        await fixture.selectForSession(session.id, resource, TEST_AUTHENTICATION);
        const opened = await fixture.open({ resource, sessionId: session.id, authentication: TEST_AUTHENTICATION });
        if (!opened.ok) throw new Error(`expected Bob's broker open: ${opened.reasonCode}`);
        await expect(fixture.catalog({ authority: opened.authority, resource })).resolves.toEqual({ ok: true });
        await expect(fixture.admit({ authority: opened.authority, resource, requestId: 'bob-1' }))
            .resolves.toMatchObject({ ok: true, resourceId: resource.id });
    });
});
