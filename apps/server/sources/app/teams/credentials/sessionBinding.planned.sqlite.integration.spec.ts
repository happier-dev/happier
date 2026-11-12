import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as teamCredentialAccessOwner from "./resourceAccess";
import { createPlannedSessionTeamCredentialFixture as fixture, createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION, TEST_TEAM_AUTHENTICATION } from "./sessionBinding.testkit";
import { encodeSessionTeamCredentialSlotKeyV1 } from "@happier-dev/protocol/teams";
import { SessionTeamCredentialBindingMetadataPatchV1Schema } from "@happier-dev/protocol/teams/credentials/sessionBindingV1";
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1 } from "@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    admitSessionTeamCredentialBindingInTx,
    grantRequiredTeamVisibilityAndValidateBindingInTx,
    resolvePlannedRunnerCredentialSelectionBindingInTx,
    validatePlannedSessionTeamCredentialResourceInTx,
    validateExistingSessionTeamCredentialResourceInTx,
    writeSessionTeamCredentialBindingsInTx,
    readAcceptedSessionTeamCredentialProviderModelBindingInTx,
    stampSessionTeamCredentialNativeDeliveryInTx,
    completeSessionTeamCredentialNativeDeliveryInTx,
    submitSessionTeamCredentialNativeDeliveryInTx,
    readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx,
} from "./sessionBinding";
import { readSessionTeamCredentialNativeSelectionInTx } from './nativeDeliveryRead';
import { deleteTeamCredentialResourceInTx } from './resourceDelete';
import { projectTeamCredentialResourceSummaryInTx, readTeamCredentialCatalogInTx } from './resourceRead';
import { projectTeamCredentialCatalogBrokerReadiness } from './brokerReadiness';
import { projectTeamCredentialCatalogModels } from './catalogModels';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import {
    applySessionTurnMutation,
    updateSessionMetadataEnvelopeTuple,
} from "@/app/session/sessionWriteService";
import { recordUsageEvent } from "@/app/usage/usageWriteService";
import { deleteMachinePool } from "@/app/machines/pools/machinePoolService";
import type { MachineDaemonPresenceSocketServer } from "@/app/machines/machineDaemonPresence";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionAccessGrantRoutes } from "@/app/api/routes/session/registerSessionAccessGrantRoutes";
import { readManagedCredentialDeliveryAuthorityInTx, readManagedNativeCredentialBindingForGuestInTx } from '@/app/machines/managed/credentialDeliveryAdmission';
import { suspendTeamMemberForActorInTx, reactivateTeamMemberForActorInTx } from '@/app/teams/memberships/memberAdministration';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { computeTeamCredentialNativeBindingReadDigestV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import tweetnacl from 'tweetnacl';
import type { FastifyRequest } from 'fastify';
import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import { createManagedPolicyCensusProofV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { deleteSessionTree } from '@/app/session/delete/deleteSessionTree';

async function submitAndCompleteNativeDelivery(input: Parameters<typeof completeSessionTeamCredentialNativeDeliveryInTx>[1]) {
    const submitted = await inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, input));
    if (!submitted.ok) return submitted;
    const selected = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, input));
    if (!selected.ok) throw new Error('Expected submitted native selection');
    const cohort = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
        accountId: input.accountId, request: { ...input, managedId: selected.binding.managedId },
        authentication: input.authentication,
    }));
    if (!cohort.ok) throw new Error('Expected qualified submitted native cohort');
    const completion = { ...input, appliedPolicy: {
        ownedBindingKeys: cohort.ownedBindings.map(row => row.safeFacet.bindingKey),
        desiredBindingKeys: cohort.desiredBindings.map(row => row.safeFacet.bindingKey),
    } };
    return inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, completion));
}

describe("planned Session Team credential selection (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-planned-team-credential-selection-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
                HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}`,
            },
        });
    }, 180_000);

    afterAll(async () => { await harness?.close(); });

    it.each(['session', 'resource', 'binding'] as const)('publishes one managed policy invalidation when a native %s disappears', async removed => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const where = { accountId: f.custodian.id, kind: 'account', entityId: f.row.id };
        const before = await db.accountChange.findFirst({ where });
        if (removed === 'session') await inTx(tx => deleteSessionTree(tx, { sessionId: f.session.id,
            sessionUpdatedAt: new Date(), actorAccountId: f.creator.id, reason: 'user_request' }));
        else if (removed === 'resource') await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, {
            actorAccountId: f.custodian.id, resourceId: f.credential.id,
            expectedRevision: f.credential.revision, authentication: TEST_TEAM_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        else await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }],
            authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        expect(await db.sessionTeamCredentialBinding.count({ where: { nativeManagedId: f.row.id } })).toBe(0);
        const after = await db.accountChange.findFirst({ where });
        expect(after?.hint).toEqual({ managedMachinePolicy: true, machineId: f.controller.id });
        expect(after?.cursor).toBeGreaterThan(before?.cursor ?? 0);
    });

    it('does not wake the native controller when resource deletion loses its revision check', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
        const where = { accountId: f.custodian.id, kind: 'account', entityId: f.row.id };
        const before = await db.accountChange.findFirst({ where });
        await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            resourceId: f.credential.id, expectedRevision: f.credential.revision + 1,
            authentication: TEST_TEAM_AUTHENTICATION }))).resolves.toEqual({ ok: false, error: 'resource_changed' });
        expect(await db.accountChange.findFirst({ where })).toEqual(before);
        expect(await db.sessionTeamCredentialBinding.count({ where: { nativeManagedId: f.row.id } })).toBe(1);
    });

    it('projects a controller-owned current native policy without a target binding and refuses a foreign signer', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected native source');
        await expect(submitAndCompleteNativeDelivery({ sessionId: f.session.id, accountId: f.creator.id,
            bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
            expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
            requestId: crypto.randomUUID(), operation: 'install', outcome: 'confirmed', authentication: TEST_AUTHENTICATION }))
            .resolves.toEqual({ ok: true });
        const keys = tweetnacl.sign.keyPair();
        await db.machine.update({ where: { id: f.controller.id }, data: { installationPublicKey: new Uint8Array(keys.publicKey) } });
        const controller = { machineId: f.controller.id, installationId: f.controller.installationId! };
        const body = { homeId: f.homeId, controller, managedId: f.row.id, includeNativeCredentialBindings: true,
            proof: createManagedPolicyCensusProofV1({ homeId: f.homeId, controller,
                custodianAccountId: f.custodian.id, privateKey: keys.secretKey }) };
        const app = createAuthenticatedTestApp();
        registerManagedMachineRoutes(app);
        const read = (accountId = f.custodian.id) => app.inject({ method: 'POST',
            url: '/v1/machines/managed/controller/policies', headers: { 'x-test-user-id': accountId }, payload: body });
        try {
            const present = await read();
            expect(present.statusCode, present.body).toBe(200);
            expect(present.json()).toMatchObject({ nativeCredentialPolicies: [{ managedId: f.row.id,
                bindings: [{ safeFacet: prepared.binding.safeFacet }], desiredBindingKeys: [prepared.binding.safeFacet.bindingKey] }] });
            expect((await read(f.stranger.id)).statusCode).toBe(403);
            // Exercise the FK cascade, independently of the step-6 deletion UI.
            await db.session.delete({ where: { id: f.session.id } });
            const empty = await read();
            expect(empty.statusCode, empty.body).toBe(200);
            expect(empty.json()).toMatchObject({ nativeCredentialPolicies: [{ managedId: f.row.id,
                bindings: [], desiredBindingKeys: [] }] });
        } finally { await app.close(); }
    });

    it.each(['guest-revoked', 'guest-re-enrolled', 'controller-reinstalled'] as const)(
        'withdraws stale native rules at the row-free boundary while targeted admission refuses: %s', async drift => {
        const f = await createNativeSessionTeamCredentialFixture();
        expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected native source');
        const request = { managedId: f.row.id, sessionId: f.session.id, bindingKey: prepared.binding.safeFacet.bindingKey,
            operation: 'install' as const };
        expect(await submitAndCompleteNativeDelivery({ ...request, accountId: f.creator.id,
            expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
            expectedProviderTicket: f.nativeSource.providerTicket, requestId: crypto.randomUUID(),
            outcome: 'confirmed', authentication: TEST_AUTHENTICATION })).toEqual({ ok: true });
        if (drift === 'guest-revoked') {
            await db.machine.update({ where: { id: f.guest.id }, data: { revokedAt: new Date() } });
        } else if (drift === 'guest-re-enrolled') {
            const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.creator.id,
                installationId: crypto.randomUUID(), metadata: f.guest.metadata, dataEncryptionKey: f.guest.dataEncryptionKey } });
            await db.managedMachine.update({ where: { id: f.row.id }, data: { enrolledMachineId: guest.id } });
        } else {
            const installationId = crypto.randomUUID();
            await db.machine.update({ where: { id: f.controller.id }, data: { installationId } });
            await db.managedMachine.update({ where: { id: f.row.id }, data: { controllerInstallationId: installationId } });
            await db.pluginMachineMaterialization.updateMany({ where: { machineId: f.controller.id },
                data: { materializationId: installationId } });
        }
        expect(await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
            accountId: f.custodian.id, request: { managedId: f.row.id }, authentication: TEST_AUTHENTICATION })))
            .toMatchObject({ ok: true, desiredBindings: [] });
        expect(await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
            accountId: f.creator.id, request, authentication: TEST_AUTHENTICATION })))
            .toEqual({ ok: false, code: 'resource_changed' });
        expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id } })).toBe(1);
    });

    it('admits a new enrolment without deleting the stale Session and keeps stale rules census-owned', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        if (f.intent.resourceId === null) throw new Error('Expected native selection');
        const intent = f.intent;
        const prepare = async (sessionId: string, executionMachineId: string) => {
            expect(await inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId, accountId: f.creator.id,
                intents: [{ ...intent, providerModelSelection: { ...intent.providerModelSelection, executionMachineId } }],
                authentication: TEST_AUTHENTICATION }))).toEqual({ ok: true });
            const result = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
            if (!result.ok) throw new Error('Expected prepared native source');
            return { sessionId, accountId: f.creator.id, bindingKey: result.binding.safeFacet.bindingKey,
                homeId: f.homeId, managedId: f.row.id, expectedResourceRevision: f.credential.revision,
                expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
                operation: 'install' as const, requestId: crypto.randomUUID(), authentication: TEST_AUTHENTICATION };
        };
        const stale = await prepare(f.session.id, f.guest.id);
        expect(await submitAndCompleteNativeDelivery({ ...stale, outcome: 'confirmed' })).toEqual({ ok: true });
        const guest = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.creator.id,
            installationId: crypto.randomUUID(), metadata: f.guest.metadata, dataEncryptionKey: f.guest.dataEncryptionKey } });
        await db.managedMachine.update({ where: { id: f.row.id }, data: { enrolledMachineId: guest.id } });
        const session = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true } });
        const fresh = await prepare(session.id, guest.id);
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
            machineId: guest.id, sessionId: session.id, data: 'new-enrolment-session-access' }))).toMatchObject({ ok: true });
        const authority = (actorAccountId: string, request = fresh) => inTx(tx => readManagedCredentialDeliveryAuthorityInTx(tx, {
            actorAccountId, machineId: f.controller.id, request, authentication: TEST_AUTHENTICATION }));
        expect(await authority(f.stranger.id)).toBeNull();
        expect(await authority(f.creator.id, stale)).toBeNull();
        expect(await authority(f.creator.id)).not.toBeNull();
        const census = (accountId: string, request: Parameters<typeof readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx>[1]['request']) =>
            inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
                accountId, request, authentication: TEST_AUTHENTICATION }));
        expect(await census(f.stranger.id, fresh)).toEqual({ ok: false, code: 'resource_changed' });
        expect(await census(f.stranger.id, { managedId: f.row.id })).toEqual({ ok: false, code: 'resource_changed' });
        const targeted = await census(f.creator.id, fresh);
        if (!targeted.ok) throw new Error('Expected new enrolment admission');
        expect(targeted.desiredBindings.map(row => row.safeFacet.bindingKey)).toEqual([fresh.bindingKey]);
        expect(targeted.ownedBindings.map(row => row.safeFacet.bindingKey)).toEqual(expect.arrayContaining([stale.bindingKey, fresh.bindingKey]));
        expect(await inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, fresh))).toEqual({ ok: true, submitted: true });
        const current = await census(f.custodian.id, { managedId: f.row.id });
        if (!current.ok) throw new Error('Expected controller-owned census');
        expect(current.desiredBindings.map(row => row.safeFacet.bindingKey)).toEqual([fresh.bindingKey]);
        expect(current.ownedBindings.map(row => row.safeFacet.bindingKey)).toEqual(expect.arrayContaining([stale.bindingKey, fresh.bindingKey]));
        const appliedPolicy = { ownedBindingKeys: current.ownedBindings.map(row => row.safeFacet.bindingKey),
            desiredBindingKeys: [fresh.bindingKey] };
        // A stale identity can be removed by this apply, never reactivated.
        expect(await inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { ...fresh, outcome: 'confirmed',
            appliedPolicy: { ...appliedPolicy, desiredBindingKeys: [stale.bindingKey, fresh.bindingKey] } })))
            .toEqual({ ok: false, code: 'action_outcome_unknown' });
        expect(await submitAndCompleteNativeDelivery({ ...fresh, requestId: crypto.randomUUID(), outcome: 'confirmed' }))
            .toEqual({ ok: false, code: 'resource_changed' });
        expect(await submitAndCompleteNativeDelivery({ ...fresh, requestId: crypto.randomUUID(),
            operation: 'release', outcome: 'confirmed' })).toEqual({ ok: true });
        const recovered = await prepare(session.id, guest.id);
        expect(await submitAndCompleteNativeDelivery({ ...recovered, outcome: 'confirmed' })).toEqual({ ok: true });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toMatchObject({ ok: true, binding: { installation: 'prepared' } });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: session.id })))
            .toMatchObject({ ok: true, binding: { installation: 'confirmed' } });
        expect(await db.session.count({ where: { id: { in: [f.session.id, session.id] } } })).toBe(2);
        expect(await authority(f.creator.id, recovered)).not.toBeNull();
        expect(await authority(f.creator.id, stale)).toBeNull();
    });

    it('reads legacy and normalized dormant consent through the same administration and recipient owners', async () => {
        const f = await fixture('personal_allowed');
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: { disclosureCeiling: 'direct_allowed' } });
        const read = async () => ({
            administration: await inTx(tx => projectTeamCredentialResourceSummaryInTx(tx, f.resource.id, f.custodian.id)),
            recipient: await inTx(tx => readTeamCredentialCatalogInTx(tx, { teamId: f.team.id, actorAccountId: f.creator.id,
                authentication: { authenticationAuthority: 'present_user' } })),
        });
        const legacy = await read();
        expect(legacy.administration).toMatchObject({ ok: true, resource: {
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            memberGrants: [{ allowedRoutes: ['brokered'] }],
        } });
        expect(legacy.recipient).toMatchObject({ ok: true, page: { resources: [{
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] }, allowedRoutes: ['brokered'],
            mayBroker: true, mayReceiveDirect: false,
        }] } });
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: {
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ['brokered', 'direct'] }, experimentalBindingConfirmations: [] }),
        } });
        await db.teamCredentialMemberGrant.updateMany({ where: { resourceId: f.resource.id }, data: { deliveryMode: '["brokered"]' } });
        const normalized = await read();
        expect(normalized.administration).toMatchObject({ ok: true, resource: {
            deliveryPolicy: { preferredAllowedModes: ['brokered', 'direct'] },
            memberGrants: [{ allowedRoutes: ['brokered'] }],
        } });
        expect(normalized.recipient).toEqual(legacy.recipient);
    });

    it("admits a native resource without inventing broker or direct rights", async () => {
        const f = await fixture('personal_allowed');
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: {
            brokerMachineId: null,
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ['vendor-native'] }, experimentalBindingConfirmations: [] }),
        } });
        await db.teamCredentialMemberGrant.updateMany({ where: { resourceId: f.resource.id }, data: { deliveryMode: '["vendor-native"]' } });
        const session = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await expect(inTx(tx => validateExistingSessionTeamCredentialResourceInTx(tx, {
            sessionId: session.id, accountId: f.creator.id, resourceId: f.resource.id,
            expectedResourceRevision: f.resource.revision, deliveryMode: 'vendor-native', authentication: TEST_AUTHENTICATION,
        }))).resolves.toMatchObject({ ok: true, entitlement: { allowedRoutes: ['vendor-native'], mayBroker: false, mayReceiveDirect: false } });
    });

    it('qualifies only the exact managed guest once per catalog batch and never borrows broker liveness', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.teamCredentialResource.create({ data: { teamId: f.team.id, custodianAccountId: f.custodian.id,
            displayName: 'Second shared gateway', sessionUsePolicy: 'personal_allowed',
            disclosureCeiling: f.credential.disclosureCeiling, sourceBindingJson: f.credential.sourceBindingJson,
            memberGrants: { create: { teamMembershipId: f.membership.id, deliveryMode: '["vendor-native"]' } } } });
        const app = createAuthenticatedTestApp();
        let supported = true;
        let checkCount = 0;
        let sourceCount = 0;
        // Only the controller network boundary is substituted. Resource,
        // audience, exact target/declaration and projection owners stay real.
        app.forwardRpcForUser = async (request: Parameters<Fastify['forwardRpcForUser']>[0]) => {
            expect(request.userId).toBe(f.custodian.id);
            expect(request.method.startsWith(`${f.controller.id}:`)).toBe(true);
            if (request.method.endsWith('machines.provisioners.check')) {
                checkCount += 1;
                return { ok: true, result: { available: true,
                    nativeCredentialDelivery: { status: supported ? 'supported' : 'unsupported' } } };
            }
            sourceCount += 1;
            expect(request.params).toMatchObject({ machineId: f.controller.id, sourceCatalog: true,
                nativeSource: { expectedResourceRevision: 0 } });
            return { ok: true, result: f.sourceResponse };
        };
        const read = async (executionMachineId?: string) => {
            const result = await inTx(tx => readTeamCredentialCatalogInTx(tx, { teamId: f.team.id,
                actorAccountId: f.creator.id, application: f.application, executionMachineId,
                authentication: { authenticationAuthority: 'present_user' } }));
            if (!result.ok) throw new Error('Expected qualified Team catalog');
            return projectTeamCredentialCatalogModels(app, await projectTeamCredentialCatalogBrokerReadiness(app, result), f.application);
        };
        try {
            const qualified = await read(f.guest.id);
            expect(qualified.resources).toHaveLength(2);
            expect(qualified.resources.every(resource => resource.readiness.kind === 'available'
                && resource.mayBroker === false && resource.mayReceiveDirect === false
                && resource.providerModels.some(model => model.selection.deliveryMode === 'vendor-native'
                    && model.nativeSource?.providerTicket === f.nativeSource.providerTicket))).toBe(true);
            expect(checkCount).toBe(1);
            expect(sourceCount).toBe(2);
            expect(JSON.stringify(qualified)).not.toContain('authorizationTicket');
            expect(JSON.stringify(qualified)).not.toContain('selectedSecretBindingId');
            const unqualified = await read();
            expect(unqualified.resources.every(resource => resource.providerModels.length === 0)).toBe(true);
            expect(unqualified.resources.every(resource => resource.deliveryUnavailableReason === 'provider_credential_transport_unavailable')).toBe(true);
            expect(checkCount).toBe(1);
            expect(sourceCount).toBe(2);
            supported = false;
            const unsupported = await read(f.guest.id);
            expect(unsupported.resources.every(resource => resource.providerModels.length === 0)).toBe(true);
            expect(unsupported.resources.every(resource => resource.deliveryUnavailableReason === 'provider_credential_transport_unavailable')).toBe(true);
            expect(checkCount).toBe(2);
            expect(sourceCount).toBe(2);
        } finally { await app.close(); }
    });

    it("retains the accepted native model and source on the exact managed guest without granting controller access", async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        const write = (intents: unknown, accountId = f.creator.id) => inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: f.session.id, accountId, intents, authentication: TEST_AUTHENTICATION,
        }));
        await expect(write([f.intent])).resolves.toEqual({ ok: true });
        const accepted = await inTx(tx => readAcceptedSessionTeamCredentialProviderModelBindingInTx(tx, f.session.id));
        expect(accepted).toMatchObject({ deliveryMode: 'vendor-native', providerModelSelection: {
            application: f.application, executionMachineId: f.guest.id, nativeSource: f.nativeSource,
        }, nativeDelivery: { managedId: f.row.id, sourceRevision: f.nativeSource.sourceRevision,
            providerTicket: f.nativeSource.providerTicket } });
        expect(JSON.stringify(accepted)).not.toContain('authorizationTicket');
        expect(JSON.stringify(accepted)).not.toContain('placeholder"');
        await expect(write([f.intent], f.stranger.id)).resolves.toEqual({ ok: false, reason: 'session_owner_mismatch' });
        if (f.intent.resourceId === null) throw new Error('Expected a selected resource');
        await expect(write([{ ...f.intent, providerModelSelection: { ...f.intent.providerModelSelection,
            executionMachineId: f.controller.id } }])).resolves.toEqual({ ok: false, reason: 'invalid_input' });
    });

    it('refuses native delivery to an Account-controlled managed guest that has no controller daemon', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        // Native credential apply is a controller daemon effect; an Account-owned
        // row carries no controller, so there is no native delivery target.
        await db.managedMachine.update({ where: { id: f.row.id },
            data: { controllerMachineId: null, controllerInstallationId: null } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: false, reason: 'invalid_input' });
        expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id } })).toBe(0);
    });

    it('stamps only the accepted current source and settles its confirmed release', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const pending = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        expect(pending).toMatchObject({ ok: true, binding: { installation: 'prepared', delivery: null } });
        const stamp = (response: unknown) => inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, {
            sessionId: f.session.id, accountId: f.creator.id, response, authentication: TEST_AUTHENTICATION,
        }));
        const response = f.sourceResponse;
        await expect(stamp({ ...response, groups: response.status === 'success' ? response.groups.map(group => ({ ...group,
            sourceRevision: 'source-changed' })) : [] })).resolves.toEqual({ ok: false, code: 'resource_changed' });
        await expect(stamp({ ...response, groups: response.status === 'success' ? response.groups.map(group => ({ ...group,
            rows: group.rows.map(row => ({ ...row, ...(row.nativeSource ? { nativeSource: { ...row.nativeSource,
                authorizationTicket: { ...row.nativeSource.authorizationTicket, grantFingerprint: 'not-the-accepted-grant' },
            } } : {}) })),
        })) : [] })).resolves.toEqual({ ok: false, code: 'resource_changed' });
        const prepared = await stamp(response);
        expect(prepared).toMatchObject({ ok: true, binding: { installation: 'prepared', delivery: {
            providerAuthorizationTicket: f.authorizationTicket, model: { descriptor: { id: 'shared-model' } },
        } } });
        if (!prepared.ok) throw new Error('Expected prepared native source');
        const current = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        if (!current.ok || !current.stored.model) throw new Error('Expected stored native model');
        // Retained development records came from the same stamp owner with
        // now-obsolete Team consent presentation attached to the model.
        await db.sessionTeamCredentialBinding.updateMany({ where: { sessionId: f.session.id,
            slotKind: 'provider_model:vendor-native' }, data: { nativeDeliveryJson: JSON.stringify({ ...current.stored,
                model: { ...current.stored.model,
                    confirmationSource: { connectionId: f.authorizationTicket.connectionId, catalogSourceKey: 's'.repeat(43) },
                    experimentalBindingConfirmations: [{ v: 1, connectionId: f.authorizationTicket.connectionId,
                        sourceRevision: f.nativeSource.sourceRevision, agentTargetKey: f.application.agentTargetKey,
                        modelId: 'shared-model', compatibilityFingerprint: 'compatibility:v1:retained', confirmedAt: 1 }],
                },
            }) } });
        const retained = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        expect(retained).toMatchObject({ ok: true, binding: { safeFacet: prepared.binding.safeFacet } });
        if (!retained.ok) throw new Error('Expected retained native selection');
        expect(retained.stored.model).not.toHaveProperty('confirmationSource');
        expect(retained.stored.model).not.toHaveProperty('experimentalBindingConfirmations');
        const comparison = { sessionId: f.session.id, accountId: f.creator.id,
            bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
            expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
            authentication: TEST_AUTHENTICATION };
        const complete = (operation: 'install' | 'release', outcome: 'confirmed' | 'unknown' | 'refused') =>
            submitAndCompleteNativeDelivery({ ...comparison, requestId: crypto.randomUUID(), operation, outcome });
        await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { ...comparison,
            expectedProviderTicket: 'a'.repeat(43), requestId: crypto.randomUUID(), operation: 'install', outcome: 'confirmed' })))
            .resolves.toEqual({ ok: false, code: 'resource_changed' });
        await expect(complete('install', 'confirmed')).resolves.toEqual({ ok: true });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toMatchObject({ ok: true, binding: { installation: 'confirmed', safeFacet: prepared.binding.safeFacet } });
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false, revision: { increment: 1 } } });
        await expect(complete('install', 'confirmed')).resolves.toEqual({ ok: false, code: 'resource_changed' });
        await expect(complete('release', 'confirmed')).resolves.toEqual({ ok: true });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toEqual({ ok: false, code: 'resource_unavailable' });
    });

    it('preserves Team credential refusals on managed control and intent routes until exact release', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.managedMachine.update({ where: { id: f.row.id }, data: {
            creationState: 'active', desired: 'start', desiredWhen: 'now',
        } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected prepared native source');
        const binding = { sessionId: f.session.id, accountId: f.creator.id,
            bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
            expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
            authentication: TEST_AUTHENTICATION };
        await expect(submitAndCompleteNativeDelivery({ ...binding, requestId: crypto.randomUUID(),
            operation: 'install', outcome: 'confirmed' })).resolves.toEqual({ ok: true });

        const requestId = crypto.randomUUID();
        const app = createAuthenticatedTestApp();
        // Only verified HTTP authentication is supplied at the boundary;
        // routes, managed admission, retained binding and publication stay real.
        app.addHook('preHandler', async (request: FastifyRequest) => {
            request.externalActionExecutionAuthorized = true;
            request.externalActionExecutionMachineId = f.controller.id;
            request.externalActionExecutionCustodianAccountId = f.custodian.id;
            request.externalActionExecutionRequestId = requestId;
            request.externalActionEffectActionId = 'machines.managed.delete';
        });
        registerManagedMachineRoutes(app);
        const admission = { action: 'machines.managed.delete', requestId,
            input: { homeId: f.homeId, managedId: f.row.id, when: 'now', intent: 'delete',
                expectedRevision: 0, reviewedDependencies: true } };
        const currentness = { homeId: f.homeId, managedId: f.row.id,
            controller: { machineId: f.controller.id, installationId: f.controller.installationId! },
            requestId: f.row.admittedActionRequestId, expectedIntentRevision: 0 };
        const post = (path: string, payload: unknown) => app.inject({ method: 'POST',
            url: `/v1/machines/managed/controller/${path}`, headers: { 'x-test-user-id': f.custodian.id }, payload });
        try {
            for (const [path, payload] of [['admit-control', admission], ['submit-intent', currentness]] as const) {
                const refusal = await post(path, payload);
                expect.soft(refusal.statusCode, path).toBe(409);
                expect.soft(refusal.json(), path).toEqual({ code: 'credential_unavailable' });
            }
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: f.row.id } }))
                .toMatchObject({ intentRevision: 0, admittedActionRequestId: f.row.admittedActionRequestId });
            await expect(submitAndCompleteNativeDelivery({ ...binding, requestId: crypto.randomUUID(),
                operation: 'release', outcome: 'confirmed' })).resolves.toEqual({ ok: true });
            const accepted = await post('admit-control', admission);
            expect(accepted.statusCode, accepted.body).toBe(200);
            const submitted = await post('submit-intent', { ...currentness, requestId, expectedIntentRevision: 1 });
            expect(submitted.statusCode, submitted.body).toBe(200);
            expect(submitted.json()).toMatchObject({ submitted: true, machine: { id: f.row.id, intentRevision: 1 } });
        } finally { await app.close(); }
    });

    it('never accepts an outcome without the exact previously submitted ordinary Action', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected prepared native source');
        await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
            expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
            expectedProviderTicket: f.nativeSource.providerTicket, requestId: crypto.randomUUID(),
            operation: 'install', outcome: 'confirmed', authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: false, code: 'resource_changed' });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toMatchObject({ ok: true, binding: { installation: 'prepared' } });
    });

    it('waits for the submitted Action outcome before the next whole-policy install', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        const prepare = async (sessionId: string) => {
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId,
                accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
            const result = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
            if (!result.ok) throw new Error('Expected prepared native source');
            return { sessionId, accountId: f.creator.id, bindingKey: result.binding.safeFacet.bindingKey,
                expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
                expectedProviderTicket: f.nativeSource.providerTicket, operation: 'install' as const,
                requestId: crypto.randomUUID(), authentication: TEST_AUTHENTICATION };
        };
        const first = await prepare(f.session.id);
        const sibling = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const second = await prepare(sibling.id);
        const submit = (request: typeof first) => inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, request));
        await expect(submit(first)).resolves.toEqual({ ok: true, submitted: true });
        // An exact retry keeps the incumbent claim. Another install waits
        // until that Action reports its outcome.
        await expect(submit(first)).resolves.toEqual({ ok: true, submitted: false });
        await expect(submitAndCompleteNativeDelivery({ ...second, outcome: 'confirmed' }))
            .resolves.toEqual({ ok: false, code: 'resource_changed' });
        await expect(submitAndCompleteNativeDelivery({ ...first, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
        await expect(submitAndCompleteNativeDelivery({ ...second, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
        for (const patch of [{ requestId: crypto.randomUUID() }, { operation: 'release' as const }, { accountId: f.stranger.id }]) {
            await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { ...first, ...patch, outcome: 'refused' })))
                .resolves.toEqual({ ok: false, code: 'resource_changed' });
        }
        const settled = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        expect(settled).toMatchObject({ ok: true, binding: { installation: 'confirmed' } });
        expect(settled.ok && settled.binding.submission).toBeUndefined();
        const unrelated = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: unrelated.session.id,
            accountId: unrelated.creator.id, intents: [unrelated.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const other = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: unrelated.session.id,
            accountId: unrelated.creator.id, response: unrelated.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!other.ok) throw new Error('Expected unrelated prepared native source');
        await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, { ...first, sessionId: unrelated.session.id,
            accountId: unrelated.creator.id, bindingKey: other.binding.safeFacet.bindingKey,
            expectedResourceRevision: unrelated.credential.revision, expectedSourceRevision: unrelated.nativeSource.sourceRevision,
            expectedProviderTicket: unrelated.nativeSource.providerTicket }))).resolves.toEqual({ ok: true, submitted: true });
        await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, { ...first, outcome: 'refused' })))
            .resolves.toEqual({ ok: false, code: 'resource_changed' });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toMatchObject({ ok: true, binding: { installation: 'confirmed' } });
        await expect(submit(second)).resolves.toEqual({ ok: true, submitted: true });
        await expect(submitAndCompleteNativeDelivery({ ...second, outcome: 'confirmed' }))
            .resolves.toEqual({ ok: true });
    });

    it('refuses another install after an unknown outcome and recovers through confirmed release', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected prepared native source');
        const complete = (operation: 'install' | 'release', outcome: 'confirmed' | 'unknown') =>
            submitAndCompleteNativeDelivery({ sessionId: f.session.id, accountId: f.creator.id,
                bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
                expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
                requestId: crypto.randomUUID(), operation, outcome, authentication: TEST_AUTHENTICATION });
        await expect(complete('install', 'unknown')).resolves.toEqual({ ok: true });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id })))
            .toMatchObject({ ok: true, binding: { installation: 'unknown' } });
        await expect(complete('install', 'confirmed')).resolves.toEqual({ ok: false, code: 'resource_changed' });
        await expect(complete('release', 'confirmed')).resolves.toEqual({ ok: true });
        expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id } })).toBe(0);
    });

    it('projects only activated native siblings and re-admits every desired resource before materialization', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        if (f.intent.resourceId === null) throw new Error('Expected native selection');
        const otherResource = await db.teamCredentialResource.create({ data: { teamId: f.team.id, custodianAccountId: f.custodian.id,
            displayName: 'Other independently granted Provider', sessionUsePolicy: 'personal_allowed',
            disclosureCeiling: f.credential.disclosureCeiling, sourceBindingJson: f.credential.sourceBindingJson,
            memberGrants: { create: { teamMembershipId: f.membership.id, deliveryMode: '["vendor-native"]' } } } });
        const sibling = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id, accountId: f.creator.id,
            intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const target = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!target.ok) throw new Error('Expected prepared target');
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: sibling.id, accountId: f.creator.id,
            intents: [{ ...f.intent, resourceId: otherResource.id, expectedResourceRevision: otherResource.revision }],
            authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const request = { managedId: f.row.id, sessionId: f.session.id, bindingKey: target.binding.safeFacet.bindingKey, operation: 'install' as const };
        const read = (value: { managedId: string; sessionId: string; bindingKey: string; operation: 'install' | 'release' } = request) =>
            inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
                accountId: f.creator.id, request: value, authentication: TEST_AUTHENTICATION }));
        const pending = await read();
        expect(pending.ok && pending.bindings.map(row => row.sessionId)).toEqual([f.session.id]);
        const other = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: sibling.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!other.ok) throw new Error('Expected source-ready sibling');
        await db.teamCredentialMemberGrant.deleteMany({ where: { resourceId: otherResource.id } });
        const stillUninstalled = await read();
        expect(stillUninstalled.ok && stillUninstalled.bindings.map(row => row.sessionId)).toEqual([f.session.id]);
        await db.teamCredentialMemberGrant.create({ data: { resourceId: otherResource.id, teamMembershipId: f.membership.id, deliveryMode: '["vendor-native"]' } });
        for (const row of [target.binding, other.binding]) await expect(submitAndCompleteNativeDelivery({
            sessionId: row.sessionId, accountId: f.creator.id, bindingKey: row.safeFacet.bindingKey,
            expectedResourceRevision: row.resourceRevision, expectedSourceRevision: row.safeFacet.sourceRevision,
            expectedProviderTicket: row.safeFacet.providerTicket, operation: 'install', requestId: crypto.randomUUID(),
            outcome: 'confirmed', authentication: TEST_AUTHENTICATION })).resolves.toEqual({ ok: true });
        const installed = await read();
        expect(installed.ok && installed.bindings.length).toBe(2);
        await db.teamCredentialMemberGrant.deleteMany({ where: { resourceId: otherResource.id } });
        const withoutWithdrawnPeer = await read();
        expect(withoutWithdrawnPeer.ok && withoutWithdrawnPeer.ownedBindings.length).toBe(2);
        expect(withoutWithdrawnPeer.ok && withoutWithdrawnPeer.desiredBindings.map(row => row.sessionId)).toEqual([f.session.id]);
        const releaseCurrent = await read({ ...request, operation: 'release' });
        expect(releaseCurrent).toMatchObject({ ok: true, desiredBindings: [] });
        expect(releaseCurrent.ok && releaseCurrent.ownedBindings.length).toBe(2);
        const releaseWithdrawn = await read({ ...request, sessionId: sibling.id, bindingKey: other.binding.safeFacet.bindingKey, operation: 'release' });
        expect(releaseWithdrawn.ok && releaseWithdrawn.ownedBindings.length).toBe(2);
        expect(releaseWithdrawn.ok && releaseWithdrawn.desiredBindings.map(row => row.sessionId)).toEqual([f.session.id]);
    });

    it.each(['disabled', 'audience'] as const)('removes both installed rules after shared %s withdrawal without peer deadlock', async withdrawal => {
        const f = await createNativeSessionTeamCredentialFixture();
        const peer = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const requests = [];
        for (const sessionId of [f.session.id, peer.id]) {
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId, accountId: f.creator.id,
                intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
            const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
            if (!prepared.ok) throw new Error('Expected prepared native source');
            const request = { homeId: f.row.homeId, managedId: f.row.id, sessionId, accountId: f.creator.id,
                bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
                expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
                requestId: crypto.randomUUID(), operation: 'install' as const, authentication: TEST_AUTHENTICATION };
            await expect(submitAndCompleteNativeDelivery({ ...request, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
            requests.push({ ...request, requestId: crypto.randomUUID(), operation: 'release' as const });
        }
        if (withdrawal === 'disabled') await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false } });
        else await db.teamCredentialMemberGrant.deleteMany({ where: { resourceId: f.credential.id } });
        await db.session.updateMany({ where: { id: { in: [f.session.id, peer.id] } }, data: { active: false, archivedAt: new Date() } });
        for (const [index, request] of requests.slice(0, 1).entries()) {
            const authority = () => inTx(tx => readManagedCredentialDeliveryAuthorityInTx(tx, {
                actorAccountId: f.creator.id, machineId: f.controller.id, request, authentication: TEST_AUTHENTICATION,
            }));
            await db.machine.update({ where: { id: f.controller.id }, data: { revokedAt: new Date() } });
            expect(await authority()).toBeNull();
            await db.machine.update({ where: { id: f.controller.id }, data: { revokedAt: null } });
            expect(await authority()).not.toBeNull();
            const qualified = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
                accountId: f.creator.id, request, authentication: TEST_AUTHENTICATION,
            }));
            expect(qualified).toMatchObject({ ok: true, desiredBindings: [] });
            expect(qualified.ok && qualified.ownedBindings).toHaveLength(2 - index);
            expect(await db.sessionTeamCredentialBinding.count({ where: { nativeManagedId: f.row.id } })).toBe(2 - index);
            await expect(submitAndCompleteNativeDelivery({ ...request, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
            expect(await db.sessionTeamCredentialBinding.count({ where: { nativeManagedId: f.row.id } })).toBe(1 - index);
        }
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: peer.id })))
            .toMatchObject({ ok: true, binding: { installation: 'prepared' } });
    });

    it.each(['reactivated', 'submitted', 'unknown'] as const)('reads the settled binding without a sibling %s veto and retains omitted-peer classification', async scenario => {
        const f = await createNativeSessionTeamCredentialFixture();
        if (f.intent.resourceId === null) throw new Error('Expected native selection');
        const peerTeam = await db.team.create({ data: { name: 'Independent native peer Team' } });
        await db.teamMembership.create({ data: { teamId: peerTeam.id, accountId: f.custodian.id, role: 'owner' } });
        const peerMembership = await db.teamMembership.create({ data: { teamId: peerTeam.id, accountId: f.creator.id, role: 'member' } });
        const resource = await db.teamCredentialResource.create({ data: { teamId: peerTeam.id, custodianAccountId: f.custodian.id,
            displayName: 'Independent native peer', sessionUsePolicy: 'personal_allowed', disclosureCeiling: f.credential.disclosureCeiling,
            sourceBindingJson: f.credential.sourceBindingJson,
            memberGrants: { create: { teamMembershipId: peerMembership.id, deliveryMode: '["vendor-native"]' } } } });
        const peer = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain', active: true } });
        const installed = [];
        for (const [sessionId, resourceId, resourceRevision] of [[f.session.id, f.credential.id, f.credential.revision],
            [peer.id, resource.id, resource.revision]] as const) {
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId, accountId: f.creator.id,
                intents: [{ ...f.intent, resourceId, teamId: resourceId === resource.id ? peerTeam.id : f.team.id,
                    expectedResourceRevision: resourceRevision }], authentication: TEST_AUTHENTICATION })))
                .resolves.toEqual({ ok: true });
            const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
            if (!prepared.ok) throw new Error('Expected prepared native source');
            const request = { homeId: f.row.homeId, managedId: f.row.id, sessionId, bindingKey: prepared.binding.safeFacet.bindingKey,
                accountId: f.creator.id, expectedResourceRevision: resourceRevision, expectedSourceRevision: f.nativeSource.sourceRevision,
                expectedProviderTicket: f.nativeSource.providerTicket, operation: 'install' as const, requestId: crypto.randomUUID(),
                authentication: TEST_AUTHENTICATION };
            await expect(submitAndCompleteNativeDelivery({ ...request, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
            installed.push({ request, binding: prepared.binding });
        }
        const [target, sibling] = installed;
        if (!target || !sibling) throw new Error('Expected both installed bindings');
        const keys = tweetnacl.sign.keyPair();
        await db.machine.update({ where: { id: f.guest.id }, data: { installationPublicKey: new Uint8Array(keys.publicKey) } });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id, machineId: f.guest.id,
            sessionId: peer.id, data: 'opaque-native-peer-access' }))).resolves.toMatchObject({ ok: true });
        const read = () => {
            const body = { purpose: 'vendor_native_binding' as const, homeId: f.row.homeId, teamId: peerTeam.id, resourceId: resource.id,
                sessionId: peer.id, managedId: f.row.id, bindingKey: sibling.binding.safeFacet.bindingKey,
                expectedResourceRevision: resource.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
                expectedProviderTicket: f.nativeSource.providerTicket, machineId: f.guest.id, installationId: f.guest.installationId! };
            return inTx(tx => readManagedNativeCredentialBindingForGuestInTx(tx, { actorAccountId: f.creator.id, homeId: f.row.homeId,
                authentication: TEST_AUTHENTICATION, request: { ...body, proof: signMachineInstallationProof({ privateKey: keys.secretKey,
                    payload: { version: 1, accountId: f.creator.id, machineId: f.guest.id, installationId: f.guest.installationId!,
                        nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(body) } } }) } }));
        };
        await expect(read()).resolves.toMatchObject({ status: 'ready' });
        if (scenario !== 'reactivated') {
            const request = { ...target.request, requestId: crypto.randomUUID() };
            await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, request))).resolves.toEqual({ ok: true, submitted: true });
            if (scenario === 'unknown') await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, {
                ...request, outcome: 'unknown',
            }))).resolves.toEqual({ ok: true });
            await expect(read()).resolves.toMatchObject({ status: 'ready' });
            expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: peer.id })))
                .toMatchObject({ ok: true, binding: { installation: 'confirmed', safeFacet: sibling.binding.safeFacet } });
            if (scenario === 'submitted') {
                const qualified = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
                    accountId: f.creator.id, request, authentication: TEST_AUTHENTICATION }));
                if (!qualified.ok) throw new Error('Expected current whole-policy cohort');
                const completed = { ...request, outcome: 'confirmed' as const, appliedPolicy: {
                    ownedBindingKeys: qualified.ownedBindings.map(row => row.safeFacet.bindingKey),
                    desiredBindingKeys: qualified.desiredBindings.map(row => row.safeFacet.bindingKey),
                } };
                await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, completed))).resolves.toEqual({ ok: true });
                await expect(read()).resolves.toMatchObject({ status: 'ready' });
            }
            return;
        }
        const membershipInput = { teamId: peerTeam.id, actorAccountId: f.custodian.id, membershipId: peerMembership.id,
            authentication: TEST_TEAM_AUTHENTICATION };
        await expect(inTx(tx => suspendTeamMemberForActorInTx(tx, membershipInput))).resolves.toMatchObject({ ok: true });
        const request = { ...target.request, requestId: crypto.randomUUID(), operation: 'release' as const };
        await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, request))).resolves.toEqual({ ok: true, submitted: true });
        const qualified = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
            accountId: f.creator.id, request, authentication: TEST_AUTHENTICATION }));
        if (!qualified.ok) throw new Error('Expected qualified release policy');
        expect(qualified.desiredBindings).toEqual([]);
        const completed = { ...request, outcome: 'confirmed' as const, appliedPolicy: {
            ownedBindingKeys: qualified.ownedBindings.map(row => row.safeFacet.bindingKey),
            desiredBindingKeys: qualified.desiredBindings.map(row => row.safeFacet.bindingKey),
        } };
        // Authority returns while the already-composed replacement is in IO.
        // Settlement must describe that applied cohort, not re-derive it now.
        await expect(inTx(tx => reactivateTeamMemberForActorInTx(tx, membershipInput))).resolves.toMatchObject({ ok: true });
        expect(await db.teamCredentialMemberGrant.count({ where: { resourceId: resource.id, teamMembershipId: peerMembership.id } })).toBe(1);
        await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, completed))).resolves.toEqual({ ok: true });
        await expect(read()).resolves.toEqual({ status: 'prepared', binding: sibling.binding.safeFacet });
        expect(await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: peer.id })))
            .toMatchObject({ ok: true, binding: { installation: 'prepared', safeFacet: sibling.binding.safeFacet } });
    });

    it('exposes only the exact prepared diagnostic facet after Session and Team use end', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.session.update({ where: { id: f.session.id }, data: { active: true } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const selected = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        if (!selected.ok) throw new Error(selected.code);
        const facet = selected.binding.safeFacet;
        const keys = tweetnacl.sign.keyPair();
        await db.machine.update({ where: { id: f.guest.id }, data: { installationPublicKey: new Uint8Array(keys.publicKey) } });
        await expect(inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: f.creator.id,
            machineId: f.guest.id, sessionId: f.session.id, data: 'prepared-diagnostic-session-access' })))
            .resolves.toMatchObject({ ok: true });
        const body = { purpose: 'vendor_native_binding' as const, homeId: f.homeId, teamId: f.team.id,
            resourceId: f.credential.id, sessionId: f.session.id, managedId: f.row.id, bindingKey: facet.bindingKey,
            expectedResourceRevision: f.credential.revision, expectedSourceRevision: facet.sourceRevision,
            expectedProviderTicket: facet.providerTicket, machineId: f.guest.id, installationId: f.guest.installationId! };
        const read = (request = body, actorAccountId = f.creator.id) => inTx(tx => readManagedNativeCredentialBindingForGuestInTx(tx, {
            actorAccountId, homeId: f.homeId, authentication: TEST_AUTHENTICATION,
            request: { ...request, proof: signMachineInstallationProof({ privateKey: keys.secretKey,
                payload: { version: 1, accountId: actorAccountId, machineId: request.machineId,
                    installationId: request.installationId,
                    nativeCredentialBindingRead: { requestBodyDigest: computeTeamCredentialNativeBindingReadDigestV1(request) } } }) },
        }));
        await expect(read()).resolves.toEqual({ status: 'prepared', binding: facet });
        await db.session.update({ where: { id: f.session.id }, data: { active: false } });
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false } });
        await expect(inTx(tx => suspendTeamMemberForActorInTx(tx, { teamId: f.team.id, actorAccountId: f.custodian.id,
            membershipId: f.membership.id, authentication: TEST_TEAM_AUTHENTICATION }))).resolves.toMatchObject({ ok: true });
        await expect(read()).resolves.toEqual({ status: 'prepared', binding: facet });
        await expect(read({ ...body, teamId: crypto.randomUUID() })).resolves.toMatchObject({ status: 'unavailable' });
        await expect(read({ ...body, bindingKey: crypto.randomUUID() })).resolves.toMatchObject({ status: 'unavailable' });
        await expect(read(body, f.custodian.id)).resolves.toMatchObject({ status: 'unavailable' });
        await db.machine.update({ where: { id: f.controller.id }, data: { installationId: crypto.randomUUID() } });
        await expect(read()).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('settles the actual confirmed effect when current use is withdrawn after submission', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id, accountId: f.creator.id,
            intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected prepared native source');
        const request = { sessionId: f.session.id, accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
            expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
            expectedProviderTicket: f.nativeSource.providerTicket, requestId: crypto.randomUUID(),
            operation: 'install' as const, authentication: TEST_AUTHENTICATION };
        await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, request))).resolves.toEqual({ ok: true, submitted: true });
        const cohort = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
            accountId: f.creator.id, request: { ...request, managedId: f.row.id }, authentication: TEST_AUTHENTICATION,
        }));
        if (!cohort.ok) throw new Error('Expected current native apply cohort');
        const completion = { ...request, outcome: 'confirmed' as const, appliedPolicy: {
            ownedBindingKeys: cohort.ownedBindings.map(row => row.safeFacet.bindingKey),
            desiredBindingKeys: cohort.desiredBindings.map(row => row.safeFacet.bindingKey),
        } };
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: { enabled: false, revision: { increment: 1 } } });
        await expect(inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, completion)))
            .resolves.toEqual({ ok: true });
        const after = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: f.session.id }));
        expect(after).toMatchObject({ ok: true, binding: { installation: 'confirmed' } });
        expect(after.ok && after.binding.submission).toBeUndefined();
    });

    it('settles every unknown peer in a confirmed whole-policy release and permits its next install', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        const sibling = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const requests = [];
        for (const sessionId of [f.session.id, sibling.id]) {
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId, accountId: f.creator.id,
                intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
            const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId,
                accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
            if (!prepared.ok) throw new Error('Expected prepared native source');
            requests.push({ sessionId, accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
                expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
                expectedProviderTicket: f.nativeSource.providerTicket, requestId: crypto.randomUUID(),
                operation: 'install' as const, authentication: TEST_AUTHENTICATION });
        }
        const [first, second] = requests;
        if (!first || !second) throw new Error('Expected both managed-resource consumers');
        await expect(submitAndCompleteNativeDelivery({ ...first, outcome: 'confirmed' })).resolves.toEqual({ ok: true });
        await expect(submitAndCompleteNativeDelivery({ ...second, outcome: 'unknown' })).resolves.toEqual({ ok: true });
        await expect(submitAndCompleteNativeDelivery({ ...first, requestId: crypto.randomUUID(), operation: 'release', outcome: 'confirmed' }))
            .resolves.toEqual({ ok: true });
        expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id } })).toBe(0);
        const settled = await inTx(tx => readSessionTeamCredentialNativeSelectionInTx(tx, { sessionId: sibling.id }));
        expect(settled).toMatchObject({ ok: true, binding: { installation: 'confirmed' } });
        expect(settled.ok && settled.binding.submission).toBeUndefined();
        await expect(submitAndCompleteNativeDelivery({ ...second, requestId: crypto.randomUUID(), outcome: 'confirmed' }))
            .resolves.toEqual({ ok: true });
    });

    it.each(['clear', 'replace', 'replace_all', 'delete_resource'] as const)('allows %s for a valid native selection that was never submitted', async operation => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: {
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ['vendor-native', 'direct'] }, experimentalBindingConfirmations: [] }),
        } });
        await db.teamCredentialMemberGrant.updateMany({ where: { resourceId: f.credential.id }, data: { deliveryMode: '["direct","vendor-native"]' } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id, accountId: f.creator.id,
            intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        if (operation === 'delete_resource') {
            await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
                resourceId: f.credential.id, expectedRevision: f.credential.revision, authentication: TEST_TEAM_AUTHENTICATION })))
                .resolves.toEqual({ ok: true });
        } else {
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id, accountId: f.creator.id,
                intents: operation === 'replace_all' ? [] : operation === 'clear'
                    ? [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }]
                    : [{ v: 1, slot: { kind: 'provider_model' }, resourceId: f.credential.id,
                        expectedResourceRevision: f.credential.revision, deliveryMode: 'direct' }],
                replaceExisting: operation === 'replace_all', authentication: TEST_AUTHENTICATION })))
                .resolves.toEqual({ ok: true });
        }
        expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id, nativeManagedId: { not: null } } })).toBe(0);
    });

    it.each((['confirmed', 'unknown', 'submitted', 'corrupt'] as const).flatMap(installation =>
        (['clear', 'resource', 'session'] as const).map(operation => ({ installation, operation }))))
    ('allows $operation deletion after $installation native delivery without retaining cleanup rows', async ({ installation, operation }) => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: {
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ['vendor-native', 'direct'] }, experimentalBindingConfirmations: [] }),
        } });
        await db.teamCredentialMemberGrant.updateMany({ where: { resourceId: f.credential.id }, data: { deliveryMode: '["direct","vendor-native"]' } });
        const purposeSlot = { kind: 'connected_service_purpose', purpose: {
            consumer: { pluginId: 'fixture.consumer', localId: 'tool' }, purpose: 'search',
        } } as const;
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent, { v: 1, slot: purposeSlot, resourceId: f.credential.id,
                expectedResourceRevision: f.credential.revision, deliveryMode: 'direct' }],
            authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION }));
        if (!prepared.ok) throw new Error('Expected prepared native source');
        const complete = (operation: 'install' | 'release', outcome: 'confirmed' | 'unknown') =>
            submitAndCompleteNativeDelivery({ sessionId: f.session.id, accountId: f.creator.id,
                bindingKey: prepared.binding.safeFacet.bindingKey, expectedResourceRevision: f.credential.revision,
                expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
                requestId: crypto.randomUUID(), operation, outcome, authentication: TEST_AUTHENTICATION });
        if (installation === 'confirmed' || installation === 'unknown') await expect(complete('install', installation)).resolves.toEqual({ ok: true });
        else if (installation === 'submitted') await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, {
            sessionId: f.session.id, accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
            expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
            expectedProviderTicket: f.nativeSource.providerTicket, operation: 'install', requestId: crypto.randomUUID(),
            authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true, submitted: true });
        else await db.sessionTeamCredentialBinding.updateMany({ where: { sessionId: f.session.id, nativeManagedId: { not: null } }, data: { nativeDeliveryJson: '{corrupt' } });
        if (operation === 'clear') await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id, accountId: f.creator.id,
            intents: [{ v: 1, slot: purposeSlot, resourceId: null }, { v: 1, slot: { kind: 'provider_model' }, resourceId: null }],
            authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: true });
        if (operation === 'resource') await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            resourceId: f.credential.id, expectedRevision: f.credential.revision, authentication: TEST_TEAM_AUTHENTICATION })))
            .resolves.toEqual({ ok: true });
        if (operation === 'session') await inTx(tx => deleteSessionTree(tx, { sessionId: f.session.id,
            sessionUpdatedAt: new Date(), actorAccountId: f.creator.id, reason: 'user_request' }));
        expect(await db.sessionTeamCredentialBinding.count({ where: { sessionId: f.session.id, nativeManagedId: { not: null } } })).toBe(0);
    });

    it('does not block resource deletion for broker-only accepted bindings', async () => {
        const f = await fixture('personal_allowed');
        const session = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: session.id,
            accountId: f.creator.id, intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: f.resource.id,
                expectedResourceRevision: f.resource.revision, deliveryMode: 'brokered' }], authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: true });
        await expect(inTx(tx => deleteTeamCredentialResourceInTx(tx, { actorAccountId: f.custodian.id,
            resourceId: f.resource.id, expectedRevision: f.resource.revision, authentication: TEST_TEAM_AUTHENTICATION })))
            .resolves.toEqual({ ok: true });
    });

    it('keeps private native material on its own slot when the same resource appears elsewhere in one batch', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.teamCredentialResource.update({ where: { id: f.credential.id }, data: {
            disclosureCeiling: JSON.stringify({ policy: { preferredAllowedModes: ['vendor-native', 'direct'] }, experimentalBindingConfirmations: [] }),
        } });
        await db.teamCredentialMemberGrant.updateMany({ where: { resourceId: f.credential.id }, data: { deliveryMode: '["direct","vendor-native"]' } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id, accountId: f.creator.id,
            authentication: TEST_AUTHENTICATION, intents: [f.intent, { v: 1, slot: { kind: 'connected_service_purpose',
                purpose: { consumer: { pluginId: 'fixture.consumer', localId: 'tool' }, purpose: 'search' } },
                resourceId: f.credential.id, expectedResourceRevision: f.credential.revision, deliveryMode: 'direct' }],
        }))).resolves.toEqual({ ok: true });
        const rows = await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: f.session.id },
            select: { slotKind: true, nativeManagedId: true, nativeDeliveryJson: true } });
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.slotKind === 'connected_service_purpose:direct'))
            .toEqual({ slotKind: 'connected_service_purpose:direct', nativeManagedId: null, nativeDeliveryJson: null });
        expect(rows.find(row => row.slotKind === 'provider_model:vendor-native')?.nativeManagedId).toBe(f.row.id);
    });


    it("validates personal, Team-context, and exact Team-visibility policy without a placeholder Session", async () => {
        const existingSessionCount = await db.session.count();
        const personal = await fixture("personal_allowed");
        await expect(personal.validate({ primaryTeamId: null, teamVisibilityTeamIds: [] }))
            .resolves.toMatchObject({
                ok: true,
                binding: { resourceId: personal.resource.id },
                custodianAccountId: personal.custodian.id,
                sourceBinding: {
                    v: 1,
                    kind: "provider_connection",
                    connectionId: "pc_runner",
                    credentialSlotId: "apiKey",
                },
            });

        const contextual = await fixture("team_context_required");
        await expect(contextual.validate({ primaryTeamId: null, teamVisibilityTeamIds: [] }))
            .resolves.toEqual({ ok: false, reason: "team_context_required" });
        await expect(contextual.validate({ primaryTeamId: contextual.team.id, teamVisibilityTeamIds: [] }))
            .resolves.toMatchObject({ ok: true });

        const visible = await fixture("team_visibility_required");
        await expect(visible.validate({ primaryTeamId: visible.team.id, teamVisibilityTeamIds: [] }))
            .resolves.toEqual({ ok: false, reason: "team_visibility_required" });
        await expect(visible.validate({ primaryTeamId: null, teamVisibilityTeamIds: [visible.team.id] }))
            .resolves.toMatchObject({ ok: true });

        expect(await db.session.count()).toBe(existingSessionCount);
    });

    it("rechecks the exact resource revision, broker, entitlement, and source binding", async () => {
        const current = await fixture("personal_allowed");
        const plannedSession = { primaryTeamId: null, teamVisibilityTeamIds: [] } as const;

        await expect(inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision + 1,
            deliveryMode: "brokered",
            expectedBrokerMachineId: current.broker.id,
            plannedSession,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, reason: "resource_changed" });
        await expect(inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision,
            deliveryMode: "brokered",
            expectedBrokerMachineId: crypto.randomUUID(),
            plannedSession,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, reason: "broker_unavailable" });

        await db.account.update({ where: { id: current.creator.id }, data: { status: "suspended" } });
        await expect(current.validate(plannedSession)).resolves.toEqual({ ok: false, reason: "access_removed" });
    });

    it("validates conditional Team visibility before writing access without a parent model binding", async () => {
        const current = await fixture("team_visibility_required");
        const session = await db.session.create({ data: {
            accountId: current.creator.id, tag: `run-visibility-${crypto.randomUUID()}`,
            encryptionMode: "plain", metadata: "unchanged-parent-model", currentStorageState: "hosted",
        } });
        const grant = () => inTx(tx => grantRequiredTeamVisibilityAndValidateBindingInTx(tx, {
            accountId: current.creator.id,
            sessionId: session.id,
            consentTeamId: current.team.id,
            intent: {
                v: 1, slot: { kind: "provider_model" }, resourceId: current.resource.id,
                expectedResourceRevision: current.resource.revision, deliveryMode: "brokered",
            },
            authentication: TEST_AUTHENTICATION,
        }));

        await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { enabled: false } });
        await expect(grant()).resolves.toEqual({ ok: false, reason: "disabled" });
        await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { enabled: true, revision: 1 } });
        await expect(grant()).resolves.toEqual({ ok: false, reason: "resource_changed" });
        await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { revision: 0, sessionUsePolicy: "personal_allowed" } });
        await expect(grant()).resolves.toEqual({ ok: false, reason: "invalid_input" });
        await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { sessionUsePolicy: "team_visibility_required" } });

        await expect(grant()).resolves.toMatchObject({ ok: true });
        await expect(db.sessionTeamGrant.findUnique({ where: { sessionId_teamId: { sessionId: session.id, teamId: current.team.id } } }))
            .resolves.toMatchObject({ accessLevel: "edit", canApprovePermissions: false });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true, metadataVersion: true } }))
            .resolves.toEqual({ metadata: "unchanged-parent-model", metadataVersion: 0 });
    });

    it("admits the exact Run credential condition through the Session access transport", async () => {
        const current = await fixture("team_visibility_required");
        const session = await db.session.create({ data: {
            accountId: current.creator.id, tag: `run-http-${crypto.randomUUID()}`,
            encryptionMode: "plain", metadata: "unchanged-parent-model", currentStorageState: "hosted",
        } });
        const payload = {
            sessionId: session.id, subject: { kind: "team", teamId: current.team.id },
            accessLevel: "edit", canApprovePermissions: false,
            requiredTeamCredential: {
                resourceId: current.resource.id, expectedResourceRevision: current.resource.revision,
                deliveryMode: "brokered",
            },
        };
        await withAuthenticatedTestApp(registerSessionAccessGrantRoutes, async app => {
            const post = () => app.inject({ method: "POST", url: "/v2/sessions/access-grants/set",
                headers: { "x-test-user-id": current.creator.id }, payload });
            await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { enabled: false } });
            const rejected = await post();
            expect(rejected.statusCode, rejected.body).toBe(409);
            expect(rejected.json()).toEqual({ error: "session_team_credential_binding_rejected", reason: "disabled" });
            await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
            await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { enabled: true } });
            const granted = await post();
            expect(granted.statusCode, granted.body).toBe(200);
            expect(granted.json()).toMatchObject({ changed: true, grant: { subject: payload.subject, accessLevel: "edit", canApprovePermissions: false } });
            const repeated = await post();
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(repeated.json()).toMatchObject({ changed: false });
            // A later failed attempt does not undo an already accepted share.
            await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { enabled: false } });
            expect((await post()).statusCode).toBe(409);
            await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(1);
        });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadata: true, metadataVersion: true } }))
            .resolves.toEqual({ metadata: "unchanged-parent-model", metadataVersion: 0 });
    });

    it("atomically grants required Team visibility with the model intent and witness", async () => {
        const current = await fixture("team_visibility_required");
        const sharedMetadata = JSON.stringify({ v: 1 });
        const ownerMetadata = { t: "plain", v: { v: 1 } } as const;
        const session = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `binding-visibility-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            currentStorageState: "hosted",
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            ownerMetadata: JSON.stringify(ownerMetadata),
            agentState: null,
        } });
        const mutation = {
            mode: "owner_team_credential_binding" as const,
            actorUserId: current.creator.id,
            sessionId: session.id,
            authentication: TEST_AUTHENTICATION,
            metadataLayoutVersion: 1 as const,
            expectedOwnerMetadata: ownerMetadata,
            ownerMetadata,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 0 },
            agentState: { ciphertext: null, expectedVersion: 0 },
            operation: "session.model.set" as const,
            teamCredentialBindings: [{
                v: 1 as const, slot: { kind: "provider_model" as const }, resourceId: current.resource.id,
                expectedResourceRevision: current.resource.revision,
                deliveryMode: "brokered" as const,
            }],
        };
        await expect(updateSessionMetadataEnvelopeTuple({
            ...mutation,
            teamVisibilityGrantConsent: { teamId: crypto.randomUUID() },
        })).resolves.toEqual({
            ok: false,
            error: "session_team_credential_binding_rejected",
            reason: "invalid_input",
        });
        await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, agentStateVersion: true },
        })).resolves.toEqual({ metadataVersion: 0, agentStateVersion: 0 });

        // Exact consent and matching revision cannot share a Session when the
        // selected resource is no longer usable.
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { enabled: false },
        });
        await expect(updateSessionMetadataEnvelopeTuple({
            ...mutation,
            teamVisibilityGrantConsent: { teamId: current.team.id },
        })).resolves.toEqual({
            ok: false,
            error: "session_team_credential_binding_rejected",
            reason: "disabled",
        });
        await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true, agentStateVersion: true },
        })).resolves.toEqual({ metadataVersion: 0, agentStateVersion: 0 });
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { enabled: true },
        });

        const admissions = vi.spyOn(teamCredentialAccessOwner, "resolveTeamCredentialEntitlementInTx");
        const result = await updateSessionMetadataEnvelopeTuple({
            ...mutation,
            teamVisibilityGrantConsent: { teamId: current.team.id },
        });
        const entitlementEvaluations = admissions.mock.calls.length;
        admissions.mockRestore();
        expect(result).toMatchObject({ ok: true });
        expect(entitlementEvaluations).toBe(mutation.teamCredentialBindings.length);
        await expect(db.sessionTeamGrant.findUnique({
            where: { sessionId_teamId: { sessionId: session.id, teamId: current.team.id } },
        })).resolves.toMatchObject({ accessLevel: "edit", canApprovePermissions: false });
        await expect(db.sessionTeamCredentialBinding.findFirst({ where: { sessionId: session.id } }))
            .resolves.toMatchObject({ resourceId: current.resource.id, resourceRevision: current.resource.revision });

        await expect(updateSessionMetadataEnvelopeTuple({
            ...mutation,
            teamVisibilityGrantConsent: { teamId: current.team.id },
        })).resolves.toMatchObject({ ok: true });
        await expect(db.sessionTeamGrant.count({ where: { sessionId: session.id } })).resolves.toBe(1);
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(1);
    });

    it("accepts an owned Pool as broker placement without prematurely selecting a Machine", async () => {
        const current = await fixture("personal_allowed");
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: current.broker.accountId,
            name: "Provider brokers",
            members: { create: { machineId: current.broker.id, priorityTier: 0, enabled: true } },
        } });
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { brokerMachineId: null, brokerPoolId: pool.id },
        });

        await expect(inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision,
            deliveryMode: "brokered",
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toMatchObject({ ok: true });

        // Deleting the Pool through its real owner removes the placement. The
        // resource is still readable, so it is not corrupt: it names no broker.
        const poolIo: MachineDaemonPresenceSocketServer = { in: () => ({ fetchSockets: async () => [] }) };
        await expect(deleteMachinePool({
            accountId: current.broker.accountId,
            input: { poolId: pool.id, expectedRevision: pool.revision },
            io: poolIo,
        })).resolves.toMatchObject({ ok: true });
        const withoutPlacement = await db.teamCredentialResource.findUniqueOrThrow({
            where: { id: current.resource.id },
            select: { revision: true, brokerMachineId: true, brokerPoolId: true },
        });
        expect(withoutPlacement).toMatchObject({ brokerMachineId: null, brokerPoolId: null });
        await expect(inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: withoutPlacement.revision,
            deliveryMode: "brokered",
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, reason: "broker_unavailable" });
    });

    it("produces only the exact reviewed Runner resource/broker binding from current planned authority", async () => {
        const current = await fixture("team_visibility_required");
        const sessionCountBefore = await db.session.count();
        const input = {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision,
            deliveryMode: "brokered",
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [current.team.id] },
            authentication: TEST_AUTHENTICATION,
        } as const;

        await expect(inTx(tx => resolvePlannedRunnerCredentialSelectionBindingInTx(tx, input)))
            .resolves.toEqual({
                ok: true,
                binding: {
                    v: 1,
                    resourceId: current.resource.id,
                    brokerMachineId: current.broker.id,
                    revision: current.resource.revision,
                },
            });
        expect(await db.session.count()).toBe(sessionCountBefore);

        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { revision: { increment: 1 } },
        });
        await expect(inTx(tx => resolvePlannedRunnerCredentialSelectionBindingInTx(tx, input)))
            .resolves.toEqual({ ok: false, reason: "resource_changed" });
    });

    // A Pool placement is a broker location, so the exact member the placement
    // owner already selected is admitted; a Machine the Pool does not currently
    // carry is not, and an unselected Pool has no Machine to bind.
    it("admits the selected current Pool member for Runner selection and refuses a non-member", async () => {
        const current = await fixture("personal_allowed");
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: current.broker.accountId,
            name: "Runner brokers",
            members: { create: { machineId: current.broker.id, priorityTier: 0, enabled: true } },
        } });
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { brokerMachineId: null, brokerPoolId: pool.id },
        });
        const input = {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision,
            deliveryMode: "brokered",
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            authentication: TEST_AUTHENTICATION,
            selectedBrokerMachineId: current.broker.id,
        } as const;

        await expect(inTx(tx => resolvePlannedRunnerCredentialSelectionBindingInTx(tx, input)))
            .resolves.toEqual({
                ok: true,
                binding: {
                    v: 1,
                    resourceId: current.resource.id,
                    brokerMachineId: current.broker.id,
                    revision: current.resource.revision,
                },
            });

        const outsider = await db.machine.create({ data: {
            id: `non-member-${crypto.randomUUID()}`,
            accountId: current.broker.accountId,
            metadata: "{}",
            kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await expect(inTx(tx => resolvePlannedRunnerCredentialSelectionBindingInTx(tx, {
            ...input,
            selectedBrokerMachineId: outsider.id,
        }))).resolves.toEqual({ ok: false, reason: "broker_unavailable" });

        const { selectedBrokerMachineId: _unselected, ...withoutSelection } = input;
        await expect(inTx(tx => resolvePlannedRunnerCredentialSelectionBindingInTx(tx, withoutSelection)))
            .resolves.toEqual({ ok: false, reason: "broker_unavailable" });
    });

    // 11.03 §B3: an established target travels with its operation, so later
    // Pool membership edits never re-ACL it. The exact Machine's own resource,
    // source and revocation authority still applies, and no other member is
    // ever silently substituted for it.
    it("admits an established Pool target after the Pool empties and refuses it once revoked", async () => {
        const current = await fixture("personal_allowed");
        const pool = await db.machinePool.create({ data: {
            id: crypto.randomUUID(),
            accountId: current.broker.accountId,
            name: "Established brokers",
            members: { create: { machineId: current.broker.id, priorityTier: 0, enabled: true } },
        } });
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { brokerMachineId: null, brokerPoolId: pool.id },
        });
        const established = {
            accountId: current.creator.id,
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision,
            deliveryMode: "brokered",
            expectedBrokerMachineId: current.broker.id,
            brokerSelection: "established",
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            authentication: TEST_AUTHENTICATION,
        } as const;

        await db.machinePoolMember.deleteMany({ where: { poolId: pool.id } });
        await expect(inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, established)))
            .resolves.toMatchObject({ ok: true, binding: { resourceId: current.resource.id } });

        const successor = await db.machine.create({ data: {
            id: crypto.randomUUID(),
            accountId: current.broker.accountId,
            active: true,
            kind: "persistent",
            metadata: "{}",
            metadataVersion: 1,
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await db.machinePoolMember.create({ data: { poolId: pool.id, machineId: successor.id, priorityTier: 0, enabled: true } });
        await db.machine.update({ where: { id: current.broker.id }, data: { revokedAt: new Date() } });
        await expect(inTx(tx => validatePlannedSessionTeamCredentialResourceInTx(tx, established)))
            .resolves.toEqual({ ok: false, reason: "broker_unavailable" });
    });


    it("fences Team-to-native witness contraction to the current publisher", async () => {
        const current = await fixture("personal_allowed");
        const source = createSessionOwnerMetadataV1({ metadata: { modelSelectionIntentV2: {
            v: 2, updatedAt: 10, ref: { source: "team_resource", teamId: current.team.id,
                resourceId: current.resource.id, expectedResourceRevision: current.resource.revision,
                deliveryMode: "brokered", agentTargetKey: "agent:happier.agent.codex/codex", modelId: "native" },
        } } });
        const target = createSessionOwnerMetadataV1({ metadata: { modelSelectionIntentV1: {
            v: 1, updatedAt: 20, selection: { agentTargetKey: "agent:happier.agent.codex/codex",
                providerConnectionId: null, modelId: "native" },
        } } });
        if (!source.ok || !target.ok) throw new Error("Model intent fixture is not owner metadata");
        const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1(source.ownerMetadata);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: current.creator.id,
            metadata: "{}", active: true } });
        const fence = new Date(1234);
        const session = await db.session.create({ data: {
            accountId: current.creator.id, tag: `native-contraction-${crypto.randomUUID()}`, encryptionMode: "plain",
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), ownerMetadata: JSON.stringify(ownerMetadata),
            active: true, lastActiveAt: fence, publisherGeneration: 7n, publisherGenerationLastActiveAt: fence,
        } });
        await db.accessKey.create({ data: { accountId: current.creator.id, machineId: machine.id,
            sessionId: session.id, data: "test-material" } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id, accountId: current.creator.id, authentication: TEST_AUTHENTICATION,
            intents: [{ v: 1, slot: { kind: "provider_model" }, resourceId: current.resource.id,
                expectedResourceRevision: current.resource.revision, deliveryMode: "brokered" }],
        }))).resolves.toEqual({ ok: true });
        const clearBody = {
            mode: "owner_team_credential_binding" as const, operation: "session.model.set" as const,
            metadataLayoutVersion: 1 as const, expectedOwnerMetadata: ownerMetadata,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(target.ownerMetadata),
            sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }), expectedVersion: 0 },
            agentState: { ciphertext: null, expectedVersion: 0 },
            teamCredentialBindings: [{ v: 1 as const, slot: { kind: "provider_model" as const }, resourceId: null }],
        };
        const clear = (publisherGeneration: string) => ({
            ...SessionTeamCredentialBindingMetadataPatchV1Schema.parse({ ...clearBody,
                publisherPrecondition: { machineId: machine.id, committedFenceMs: fence.getTime(), publisherGeneration } }),
            actorUserId: current.creator.id, sessionId: session.id, authentication: TEST_AUTHENTICATION,
        });
        await expect(updateSessionMetadataEnvelopeTuple(clear("6")))
            .resolves.toMatchObject({ ok: false, error: "publisher-superseded" });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(1);
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { ownerMetadata: true } }))
            .resolves.toEqual({ ownerMetadata: JSON.stringify(ownerMetadata) });
        await expect(updateSessionMetadataEnvelopeTuple(clear("7"))).resolves.toMatchObject({ ok: true });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
    });

    it("commits and removes an existing-Session witness atomically with the owner metadata tuple", async () => {
        const current = await fixture("personal_allowed");
        const ownerMetadata = { t: "plain", v: { v: 1 } } as const;
        const sharedMetadata = JSON.stringify({ v: 1 });
        const session = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `binding-mutation-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            ownerMetadata: JSON.stringify(ownerMetadata),
            agentState: null,
        } });
        const base = {
            mode: "owner_team_credential_binding" as const,
            actorUserId: current.creator.id,
            sessionId: session.id,
            authentication: TEST_AUTHENTICATION,
            metadataLayoutVersion: 1 as const,
            expectedOwnerMetadata: ownerMetadata,
            ownerMetadata,
            agentState: { ciphertext: null, expectedVersion: 0 },
            operation: "session.model.set" as const,
        };
        const bind = {
            ...base,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 0 },
            teamCredentialBindings: [{
                v: 1 as const,
                slot: { kind: "provider_model" as const },
                resourceId: current.resource.id,
                expectedResourceRevision: current.resource.revision,
                deliveryMode: "brokered" as const,
            }],
        };
        const admissions = vi.spyOn(teamCredentialAccessOwner, "resolveTeamCredentialEntitlementInTx");
        try {
            await expect(updateSessionMetadataEnvelopeTuple(bind)).resolves.toMatchObject({ ok: true });
            expect(admissions.mock.calls.length).toBe(bind.teamCredentialBindings.length);
        } finally { admissions.mockRestore(); }
        await expect(db.sessionTeamCredentialBinding.findFirst({
            where: { sessionId: session.id },
        })).resolves.toMatchObject({
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        });
        await expect(updateSessionMetadataEnvelopeTuple(bind)).resolves.toMatchObject({ ok: true });

        await db.session.update({ where: { id: session.id }, data: { active: true } });
        await expect(updateSessionMetadataEnvelopeTuple({
            ...bind,
            sessionExpectation: { kind: "inactive_model_intent" },
            teamCredentialBindings: [{
                v: 1,
                slot: { kind: "provider_model" },
                resourceId: null,
            }],
        })).resolves.toMatchObject({ ok: false, error: "session_active" });
        await expect(db.sessionTeamCredentialBinding.count({
            where: { sessionId: session.id },
        })).resolves.toBe(1);
        await expect(db.sessionTeamCredentialBinding.findUnique({
            where: { sessionId_slotKind_slotKey: {
                sessionId: session.id,
                slotKind: "provider_model:brokered",
                slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            } },
        })).resolves.toMatchObject({
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        });
        await db.session.update({ where: { id: session.id }, data: { active: false } });

        const connectedServiceSlot = {
            kind: "connected_service_purpose" as const,
            purpose: {
                consumer: { pluginId: "example.plugin", localId: "consumer" },
                purpose: "search",
            },
        };
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: `${connectedServiceSlot.kind}:brokered`,
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1(connectedServiceSlot)),
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        } });
        await expect(inTx(tx => admitSessionTeamCredentialBindingInTx(tx, {
            sessionId: session.id,
            accountId: current.creator.id,
            slot: {
                ...connectedServiceSlot,
                purpose: { ...connectedServiceSlot.purpose, purpose: "files" },
            },
            deliveryMode: "brokered",
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, reason: "binding_missing" });
        await db.sessionTeamCredentialBinding.delete({
            where: { sessionId_slotKind_slotKey: {
                sessionId: session.id,
                slotKind: `${connectedServiceSlot.kind}:brokered`,
                slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1(connectedServiceSlot)),
            } },
        });
        await db.sessionTeamCredentialBinding.delete({
            where: { sessionId_slotKind_slotKey: {
                sessionId: session.id,
                slotKind: "provider_model:brokered",
                slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            } },
        });
        await expect(inTx(tx => admitSessionTeamCredentialBindingInTx(tx, {
            sessionId: session.id,
            accountId: current.creator.id,
            slot: { kind: "provider_model" },
            deliveryMode: "brokered",
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, reason: "binding_missing" });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: "provider_model:brokered",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        } });

        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { revision: { increment: 1 } },
        });
        // The accepted witness names the selected resource and route; the
        // revision is a mutable policy fact admitted as it is now, so a policy
        // edit does not strand the Session's selection.
        await expect(inTx(tx => admitSessionTeamCredentialBindingInTx(tx, {
            sessionId: session.id,
            accountId: current.creator.id,
            slot: { kind: "provider_model" },
            deliveryMode: "brokered",
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toMatchObject({
            ok: true,
            binding: { resourceId: current.resource.id, resourceRevision: current.resource.revision + 1 },
        });
        await expect(updateSessionMetadataEnvelopeTuple({
            ...base,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 1 },
            // Unchanged null Agent state does not advance its own version.
            agentState: { ciphertext: null, expectedVersion: 0 },
            teamCredentialBindings: [{
                v: 1,
                slot: { kind: "provider_model" },
                resourceId: null,
            }],
        })).resolves.toMatchObject({ ok: true });
        await expect(db.sessionTeamCredentialBinding.count({
            where: { sessionId: session.id },
        })).resolves.toBe(0);

        await expect(updateSessionMetadataEnvelopeTuple({
            ...bind,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 2 },
            agentState: { ciphertext: null, expectedVersion: 0 },
        })).resolves.toEqual({
            ok: false,
            error: "session_team_credential_binding_rejected",
            reason: "resource_changed",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadataVersion: true },
        })).resolves.toEqual({ metadataVersion: 2 });
    });

    it("commits every Connected Service purpose through one existing-Session mutation and rolls back the whole batch on failure", async () => {
        const current = await fixture("personal_allowed");
        const ownerMetadata = { t: "plain", v: { v: 1 } } as const;
        const sharedMetadata = JSON.stringify({ v: 1 });
        const session = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `connected-service-batch-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            ownerMetadata: JSON.stringify(ownerMetadata),
            agentState: null,
        } });
        const purpose = (value: string) => ({
            kind: "connected_service_purpose" as const,
            purpose: {
                consumer: { pluginId: "example.plugin", localId: "consumer" },
                purpose: value,
            },
        });
        const intents = ["search", "files"].map(value => ({
            v: 1 as const,
            slot: purpose(value),
            resourceId: current.resource.id,
            expectedResourceRevision: current.resource.revision,
            deliveryMode: "brokered" as const,
        }));
        const base = {
            mode: "owner_team_credential_binding" as const,
            actorUserId: current.creator.id,
            sessionId: session.id,
            authentication: TEST_AUTHENTICATION,
            metadataLayoutVersion: 1 as const,
            expectedOwnerMetadata: ownerMetadata,
            ownerMetadata,
            operation: "session.connected_service.switch" as const,
        };
        await expect(updateSessionMetadataEnvelopeTuple({
            ...base,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 0 },
            agentState: { ciphertext: null, expectedVersion: 0 },
            teamCredentialBindings: intents,
        })).resolves.toMatchObject({ ok: true });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(2);

        await expect(updateSessionMetadataEnvelopeTuple({
            ...base,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: 1 },
            agentState: { ciphertext: null, expectedVersion: 0 },
            teamCredentialBindings: [
                { v: 1, slot: purpose("search"), resourceId: null },
                { v: 1, slot: purpose("files"), resourceId: "missing-resource", expectedResourceRevision: 0, deliveryMode: "brokered" },
            ],
        })).resolves.toMatchObject({
            ok: false,
            error: "session_team_credential_binding_rejected",
            reason: "resource_missing",
        });
        await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(2);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id }, select: { metadataVersion: true },
        })).resolves.toEqual({ metadataVersion: 1 });
    });

    it('attributes a native turn to its accepted resource without labeling it brokered or direct', async () => {
        const f = await createNativeSessionTeamCredentialFixture();
        await db.session.update({ where: { id: f.session.id }, data: { active: true } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
            accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION }))).resolves.toEqual({ ok: true });
        await expect(applySessionTurnMutation({ actorUserId: f.creator.id, authentication: TEST_AUTHENTICATION,
            mutation: { v: 1, sessionId: f.session.id, mutationId: 'native-turn-begin', turnId: 'native-turn',
                action: 'begin', observedAt: 100 } })).resolves.toMatchObject({ ok: true, didApply: true });
        expect(await db.sessionTurn.findUniqueOrThrow({ where: { sessionId_turnId: { sessionId: f.session.id, turnId: 'native-turn' } },
            select: { usageActorAccountId: true, teamCredentialResourceId: true, credentialDeliveryMode: true } }))
            .toEqual({ usageActorAccountId: f.creator.id, teamCredentialResourceId: f.credential.id, credentialDeliveryMode: 'vendor-native' });
    });

    it("snapshots the admitted runtime Account and current provider resource once per new turn", async () => {
        const current = await fixture("personal_allowed");
        const session = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `turn-witness-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            metadata: "{}",
            active: true,
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: session.id,
            slotKind: "provider_model:brokered",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        } });

        const begin = (turnId: string, mutationId: string, observedAt: number) =>
            applySessionTurnMutation({
                actorUserId: current.creator.id,
                authentication: TEST_AUTHENTICATION,
                mutation: {
                    v: 1,
                    sessionId: session.id,
                    mutationId,
                    turnId,
                    action: "begin",
                    observedAt,
                },
            });

        await expect(begin("turn-brokered", "begin-brokered", 100)).resolves.toMatchObject({
            ok: true,
            didApply: true,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId: "turn-brokered" } },
            select: {
                usageActorAccountId: true,
                teamCredentialResourceId: true,
                credentialDeliveryMode: true,
            },
        })).resolves.toEqual({
            usageActorAccountId: current.creator.id,
            teamCredentialResourceId: current.resource.id,
            credentialDeliveryMode: "brokered",
        });

        const directResource = await db.teamCredentialResource.create({ data: {
            teamId: current.team.id,
            custodianAccountId: current.custodian.id,
            displayName: "Direct provider",
            enabled: true,
            revision: 1,
            disclosureCeiling: "direct_allowed",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                connectionId: "pc_direct",
                connectionSecurityFingerprint: "connection-security:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                credentialSlotId: "apiKey",
            }),
            memberGrants: { create: {
                teamMembershipId: current.creatorMembership.id,
                deliveryMode: "direct",
            } },
        } });
        await inTx(async (tx) => {
            const slotKey = Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" }));
            await tx.sessionTeamCredentialBinding.delete({
                where: { sessionId_slotKind_slotKey: {
                    sessionId: session.id,
                    slotKind: "provider_model:brokered",
                    slotKey,
                } },
            });
            await tx.sessionTeamCredentialBinding.create({ data: {
                sessionId: session.id,
                slotKind: "provider_model:direct",
                slotKey,
                resourceId: directResource.id,
                resourceRevision: directResource.revision,
            } });
        });

        await expect(applySessionTurnMutation({
            actorUserId: current.creator.id,
            authentication: TEST_AUTHENTICATION,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: "touch-brokered-after-switch",
                turnId: "turn-brokered",
                action: "touch_active",
                observedAt: 101,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId: "turn-brokered" } },
            select: {
                usageActorAccountId: true,
                teamCredentialResourceId: true,
                credentialDeliveryMode: true,
            },
        })).resolves.toEqual({
            usageActorAccountId: current.creator.id,
            teamCredentialResourceId: current.resource.id,
            credentialDeliveryMode: "brokered",
        });

        await expect(begin("turn-direct", "begin-direct", 102)).resolves.toMatchObject({
            ok: true,
            didApply: true,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId: "turn-direct" } },
            select: {
                usageActorAccountId: true,
                teamCredentialResourceId: true,
                credentialDeliveryMode: true,
            },
        })).resolves.toEqual({
            usageActorAccountId: current.creator.id,
            teamCredentialResourceId: directResource.id,
            credentialDeliveryMode: "direct",
        });

        await expect(recordUsageEvent(current.creator.id, {
            sessionId: session.id,
            observedAt: 103,
            agentId: "codex",
            backendMode: "local",
            modelId: "model-direct",
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: "codex",
            scope: "turn_delta",
            externalKey: "direct-observation",
            turnId: "turn-direct",
            isCumulative: false,
            tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: "USD" },
            context: { usedTokens: 3, windowTokens: 100 },
        })).resolves.toMatchObject({ ok: true });
        await expect(db.usageEvent.findFirstOrThrow({
            where: { sessionId: session.id, externalKey: "direct-observation" },
            select: {
                teamCredentialResourceId: true,
                teamCredentialActorAccountId: true,
                credentialDeliveryMode: true,
            },
        })).resolves.toEqual({
            teamCredentialResourceId: directResource.id,
            teamCredentialActorAccountId: current.creator.id,
            credentialDeliveryMode: "direct",
        });
    });

    it("keeps an unbound turn ordinary and rejects a stale bound resource without committing begin", async () => {
        const current = await fixture("personal_allowed");
        const unboundSession = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `unbound-turn-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            metadata: "{}",
            active: true,
        } });
        await expect(applySessionTurnMutation({
            actorUserId: current.creator.id,
            authentication: TEST_AUTHENTICATION,
            mutation: {
                v: 1,
                sessionId: unboundSession.id,
                mutationId: "begin-unbound",
                turnId: "turn-unbound",
                action: "begin",
                observedAt: 200,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: unboundSession.id, turnId: "turn-unbound" } },
            select: {
                usageActorAccountId: true,
                teamCredentialResourceId: true,
                credentialDeliveryMode: true,
            },
        })).resolves.toEqual({
            usageActorAccountId: null,
            teamCredentialResourceId: null,
            credentialDeliveryMode: null,
        });

        const staleSession = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `stale-turn-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            metadata: "{}",
            active: true,
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: staleSession.id,
            slotKind: "provider_model:brokered",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        } });
        await db.teamCredentialResource.update({
            where: { id: current.resource.id },
            data: { revision: { increment: 1 } },
        });

        // A policy edit after the selection was accepted does not strand the
        // Session: the turn witness is admitted against the resource as it is
        // now (`11-integrated-security-qa-and-completion.md` A2(4)).
        await expect(applySessionTurnMutation({
            actorUserId: current.creator.id,
            authentication: TEST_AUTHENTICATION,
            mutation: {
                v: 1,
                sessionId: staleSession.id,
                mutationId: "begin-after-policy-edit",
                turnId: "turn-after-policy-edit",
                action: "begin",
                observedAt: 201,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: staleSession.id, turnId: "turn-after-policy-edit" } },
            select: { teamCredentialResourceId: true, credentialDeliveryMode: true },
        })).resolves.toEqual({ teamCredentialResourceId: current.resource.id, credentialDeliveryMode: "brokered" });
        // Losing the grant still refuses the turn's credential witness.
        const refusedSession = await db.session.create({ data: {
            accountId: current.creator.id,
            tag: `refused-turn-${crypto.randomUUID()}`,
            encryptionMode: "plain",
            metadata: "{}",
            active: true,
        } });
        await db.sessionTeamCredentialBinding.create({ data: {
            sessionId: refusedSession.id,
            slotKind: "provider_model:brokered",
            slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1({ kind: "provider_model" })),
            resourceId: current.resource.id,
            resourceRevision: current.resource.revision,
        } });
        await db.teamCredentialResource.update({ where: { id: current.resource.id }, data: { enabled: false } });
        await expect(applySessionTurnMutation({
            actorUserId: current.creator.id,
            authentication: TEST_AUTHENTICATION,
            mutation: {
                v: 1,
                sessionId: refusedSession.id,
                mutationId: "begin-refused",
                turnId: "turn-refused",
                action: "begin",
                observedAt: 202,
            },
        })).resolves.toMatchObject({ ok: false, code: "session_team_credential_binding_rejected" });
        await expect(db.sessionTurn.count({ where: { sessionId: refusedSession.id } })).resolves.toBe(0);
        await expect(db.usageEvent.count({ where: { sessionId: refusedSession.id } })).resolves.toBe(0);
    });
});
