import { registerManagedMachineRoutes } from '@/app/machines/managed/managedRoutes';
import type { FastifyRequest } from 'fastify';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
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

    it("validates personal, Team-context, and exact Team-visibility policy without a placeholder Session", async () => {
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

        expect(await db.session.count()).toBe(0);
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

        const result = await updateSessionMetadataEnvelopeTuple({
            ...mutation,
            teamVisibilityGrantConsent: { teamId: current.team.id },
        });
        expect(result).toMatchObject({ ok: true });
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
        await expect(updateSessionMetadataEnvelopeTuple(bind)).resolves.toMatchObject({ ok: true });
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
            agentState: { ciphertext: null, expectedVersion: 1 },
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
            agentState: { ciphertext: null, expectedVersion: 2 },
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
            agentState: { ciphertext: null, expectedVersion: 1 },
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
