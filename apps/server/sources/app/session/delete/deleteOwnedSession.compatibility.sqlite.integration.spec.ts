import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";

import { db } from "@/storage/db";
import { inTx } from '@/storage/inTx';
import { createNativeSessionTeamCredentialFixture, createPlannedSessionTeamCredentialFixture,
    TEST_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { writeSessionTeamCredentialBindingsInTx, stampSessionTeamCredentialNativeDeliveryInTx,
    submitSessionTeamCredentialNativeDeliveryInTx, completeSessionTeamCredentialNativeDeliveryInTx,
    readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx } from '@/app/teams/credentials/sessionBinding';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const { emitUpdate } = vi.hoisted(() => ({ emitUpdate: vi.fn() }));
vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<
        typeof import("@/app/events/eventRouter")
    >("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: {
            ...actual.eventRouter,
            emitUpdate,
        },
    };
});

describe("deleteOwnedSession stored-content compatibility (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "session-delete-compatibility-",
            env: {
                HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}`,
            },
        });
    });

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(async () => {
        emitUpdate.mockReset();
        harness.resetEnv();
        await db.accountChange.deleteMany();
        await db.session.deleteMany();
        await db.teamCredentialResource.deleteMany();
        // Canonical managed fixtures retain independent custody rows until the
        // disposable harness closes; only these fixed Account ids are reused.
        await db.account.deleteMany({ where: { id: { in: ['owner', 'collaborator'] } } });
        await db.account.create({ data: { id: "owner" } });
    });

    it.each(['prepared', 'confirmed', 'unknown', 'submitted', 'corrupt'] as const)(
        'honors %s native evidence when deleting an inactive Session', async installation => {
            const f = await createNativeSessionTeamCredentialFixture();
            expect(f.session.active).toBe(false);
            await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
                sessionId: f.session.id, accountId: f.creator.id, intents: [f.intent],
                authentication: TEST_AUTHENTICATION,
            }))).resolves.toEqual({ ok: true });
            const prepared = await inTx(tx => stampSessionTeamCredentialNativeDeliveryInTx(tx, {
                sessionId: f.session.id, accountId: f.creator.id, response: f.sourceResponse,
                authentication: TEST_AUTHENTICATION,
            }));
            if (!prepared.ok) throw new Error('Expected prepared native delivery');
            const complete = async (operation: 'install' | 'release', outcome: 'confirmed' | 'unknown') => {
                const input = {
                    sessionId: f.session.id, accountId: f.creator.id,
                    bindingKey: prepared.binding.safeFacet.bindingKey,
                    expectedResourceRevision: f.credential.revision,
                    expectedSourceRevision: f.nativeSource.sourceRevision,
                    expectedProviderTicket: f.nativeSource.providerTicket,
                    requestId: crypto.randomUUID(), operation, outcome, authentication: TEST_AUTHENTICATION,
                };
                await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, input)))
                    .resolves.toEqual({ ok: true, submitted: true });
                const cohort = await inTx(tx => readQualifiedSessionTeamCredentialNativeDeliveriesForManagedMachineInTx(tx, {
                    accountId: input.accountId, request: { ...input, managedId: prepared.binding.managedId },
                    authentication: input.authentication,
                }));
                if (!cohort.ok) throw new Error('Expected qualified submitted native cohort');
                const completion = { ...input, appliedPolicy: {
                    ownedBindingKeys: cohort.ownedBindings.map(row => row.safeFacet.bindingKey),
                    desiredBindingKeys: cohort.desiredBindings.map(row => row.safeFacet.bindingKey),
                } };
                return inTx(tx => completeSessionTeamCredentialNativeDeliveryInTx(tx, completion));
            };
            if (installation === 'confirmed' || installation === 'unknown') {
                await expect(complete('install', installation)).resolves.toEqual({ ok: true });
            } else if (installation === 'submitted') {
                await expect(inTx(tx => submitSessionTeamCredentialNativeDeliveryInTx(tx, {
                    sessionId: f.session.id, accountId: f.creator.id, bindingKey: prepared.binding.safeFacet.bindingKey,
                    expectedResourceRevision: f.credential.revision, expectedSourceRevision: f.nativeSource.sourceRevision,
                    expectedProviderTicket: f.nativeSource.providerTicket, requestId: crypto.randomUUID(),
                    operation: 'install', authentication: TEST_AUTHENTICATION,
                }))).resolves.toEqual({ ok: true, submitted: true });
            } else if (installation === 'corrupt') {
                await db.sessionTeamCredentialBinding.updateMany({ where: { sessionId: f.session.id }, data: { nativeDeliveryJson: '{' } });
            }
            const { deleteOwnedSession } = await import('./deleteOwnedSession');
            const remove = () => deleteOwnedSession({ sessionId: f.session.id,
                ownerAccountId: f.creator.id, reason: 'user_request' });
            await expect(remove()).resolves.toEqual({ ok: true });
            expect(await db.session.findUnique({ where: { id: f.session.id } })).toBeNull();
            expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: f.session.id } })).toEqual([]);
        },
    );

    it.each(['brokered', 'direct'] as const)('deletes a Session with only a %s credential binding', async deliveryMode => {
        const f = await createPlannedSessionTeamCredentialFixture('personal_allowed');
        await db.teamCredentialResource.update({ where: { id: f.resource.id }, data: { disclosureCeiling: 'direct_allowed' } });
        await db.teamCredentialMemberGrant.updateMany({ where: { resourceId: f.resource.id }, data: { deliveryMode } });
        const session = await db.session.create({ data: { accountId: f.creator.id, tag: crypto.randomUUID(), metadata: '{}' } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id, accountId: f.creator.id, authentication: TEST_AUTHENTICATION,
            intents: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: f.resource.id,
                expectedResourceRevision: f.resource.revision, deliveryMode }],
        }))).resolves.toEqual({ ok: true });
        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        await expect(deleteOwnedSession({ sessionId: session.id, ownerAccountId: f.creator.id, reason: 'user_request' }))
            .resolves.toEqual({ ok: true });
        expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
        expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: session.id } })).toEqual([]);
    });

    it("allows a caller to delete layout 1 without interpreting its content", async () => {
        await db.session.create({
            data: {
                id: "layout-1",
                tag: "layout-1",
                accountId: "owner",
                metadata: "shared",
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({
                    t: "plain",
                    v: { path: "/private" },
                }),
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "layout-1",
            ownerAccountId: "owner",
            reason: "user_request",
        });

        expect(result).toEqual({ ok: true });
        expect(await db.session.findUnique({
            where: { id: "layout-1" },
        })).toBeNull();
        expect(await db.accountChange.findMany({
            where: { accountId: "owner", kind: "session" },
            select: {
                kind: true,
                entityId: true,
                hint: true,
            },
        })).toEqual([{
            kind: "session",
            entityId: "layout-1",
            hint: { v: 1, lifecycle: "deleted" },
        }]);
        expect(emitUpdate).toHaveBeenCalled();
    });

    it("sends the delete update after the Session's earlier queued fan-out", async () => {
        const session = await db.session.create({ data: { accountId: "owner", tag: crypto.randomUUID(), metadata: "{}" } });
        const { publishSessionAfterCommit } = await import("@/app/session/publishSessionAfterCommit");
        const order: string[] = [];
        let releaseTurnPush!: () => void;
        const turnPushReleased = new Promise<void>(resolve => { releaseTurnPush = resolve; });
        // A turn push committed before the delete and still waiting in the Session's fan-out queue.
        const queuedTurnPush = publishSessionAfterCommit(session.id, "test turn push", async () => {
            await turnPushReleased;
            order.push("turn-push");
        });
        emitUpdate.mockImplementation(({ payload }: { payload: { body: { t: string } } }) => {
            order.push(payload.body.t);
        });

        const { deleteOwnedSession } = await import("./deleteOwnedSession");
        await expect(deleteOwnedSession({ sessionId: session.id, ownerAccountId: "owner", reason: "user_request" }))
            .resolves.toEqual({ ok: true });
        await new Promise(resolve => setTimeout(resolve, 20));
        // RED (HEAD 7cd8a0b2bc7): ["delete-session"] — the delete overtook the queued push.
        expect(order).toEqual([]);

        releaseTurnPush();
        await queuedTurnPush;
        await publishSessionAfterCommit(session.id, "test drain", async () => {});
        expect(order).toEqual(["turn-push", "delete-session"]);
    });

    it("preserves released layout-0 deletion for a legacy caller", async () => {
        await db.session.create({
            data: {
                id: "layout-0",
                tag: "layout-0",
                accountId: "owner",
                metadata: "legacy-ciphertext",
                metadataLayoutVersion: 0,
            },
        });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "layout-0",
            ownerAccountId: "owner",
            reason: "user_request",
        });

        expect(result).toEqual({ ok: true });
        expect(await db.session.findUnique({
            where: { id: "layout-0" },
        })).toBeNull();
        expect(await db.accountChange.count({
            where: { accountId: "owner", kind: "session" },
        })).toBe(1);
    });

    it("tombstones the owner's and collaborator's Session and Run drafts while preserving a sibling Session", async () => {
        const { mutateSessionDraft, readSessionDraft } = await import('@/app/account/sessionDrafts/sessionDraftService');
        const { sessionDraftPhysicalKey } = await import('@/app/account/sessionDrafts/sessionDraftPhysicalKey');
        const { deleteOwnedSession } = await import('./deleteOwnedSession');
        const authentication = { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined };
        await db.account.create({ data: { id: 'collaborator' } });
        await db.session.createMany({ data: ['draft-parent', 'draft-parent-sibling'].map(id => ({
            id, tag: id, accountId: 'owner', metadata: '{}', encryptionMode: 'e2ee',
        })) });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: 'draft-parent', accountId: 'collaborator', createdByAccountId: 'owner', accessLevel: 'view',
        } });
        const addresses = [
            { kind: 'session', sessionId: 'draft-parent' },
            { kind: 'run', sessionId: 'draft-parent', runId: 'run-a' },
            { kind: 'session', sessionId: 'draft-parent-sibling' },
        ] as const;
        for (const accountId of ['owner', 'collaborator']) {
            for (const address of addresses) {
                if (accountId === 'collaborator' && address.sessionId !== 'draft-parent') continue;
                expect(await mutateSessionDraft({ accountId, address, expectedRevision: 'absent',
                    content: { t: 'encrypted', c: 'opaque-draft-content', v: 2 }, authentication,
                })).toMatchObject({ status: 'updated', record: { revision: 0 } });
            }
        }

        await expect(deleteOwnedSession({ sessionId: 'draft-parent', ownerAccountId: 'owner', reason: 'user_request' }))
            .resolves.toEqual({ ok: true });
        for (const accountId of ['owner', 'collaborator']) {
            for (const address of addresses.slice(0, 2)) {
                const key = sessionDraftPhysicalKey(address);
                if (!key) throw new Error('Expected a canonical draft key');
                expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId, key } },
                    select: { value: true, version: true },
                })).toEqual({ value: null, version: 1 });
                expect(await readSessionDraft({ accountId, address, authentication })).toEqual({ status: 'absent' });
            }
        }
        expect(await readSessionDraft({ accountId: 'owner', address: addresses[2], authentication }))
            .toMatchObject({ status: 'present', record: { revision: 0 } });
        expect(await mutateSessionDraft({ accountId: 'owner', address: addresses[0], expectedRevision: 1,
            content: null, authentication,
        })).toEqual({ status: 'sessionUnavailable' });
    });

    it("invalidates a surviving Follow destination when deleting its source Session", async () => {
        await db.session.createMany({ data: [{
            id: "follow-source-delete",
            tag: "follow-source-delete",
            accountId: "owner",
            metadata: "{}",
            metadataLayoutVersion: 1,
        }, {
            id: "follow-destination-survives",
            tag: "follow-destination-survives",
            accountId: "owner",
            metadata: "{}",
            metadataLayoutVersion: 1,
        }] });
        await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: 'follow-source-delete' }),
            sourceSessionId: "follow-source-delete",
            destinationSessionId: "follow-destination-survives",
            policyJson: '{"preset":"quiet"}',
        } });

        const { deleteOwnedSession } = await import("./deleteOwnedSession");
        await expect(deleteOwnedSession({
            sessionId: "follow-source-delete",
            ownerAccountId: "owner",
            reason: "user_request",
        })).resolves.toEqual({ ok: true });

        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: "owner",
            kind: "session",
            entityId: "follow-destination-survives",
        } } })).not.toBeNull();
    });

    it("rolls the durable deletion hint back when the physical delete loses its condition", async () => {
        await db.session.create({
            data: {
                id: "delete-condition-lost",
                tag: "delete-condition-lost",
                accountId: "owner",
                metadata: "legacy-ciphertext",
                metadataLayoutVersion: 0,
            },
        });
        await db.session.create({ data: {
            id: "delete-condition-destination",
            tag: "delete-condition-destination",
            accountId: "owner",
            metadata: "{}",
            metadataLayoutVersion: 1,
        } });
        await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: 'delete-condition-lost' }),
            sourceSessionId: "delete-condition-lost",
            destinationSessionId: "delete-condition-destination",
            policyJson: '{"preset":"quiet"}',
        } });

        const { deleteOwnedSession } = await import(
            "./deleteOwnedSession"
        );
        const result = await deleteOwnedSession({
            sessionId: "delete-condition-lost",
            reason: "retention_policy",
            // The deletion owner increments seq at its writer boundary. Keeping
            // the pre-claim value in the final predicate deterministically
            // forces the final physical delete to lose its condition after the
            // AccountChange write, exercising the real transaction rollback.
            sessionWhereGuard: { seq: 0 },
        });

        expect(result).toEqual({ ok: false, error: "conflict" });
        expect(await db.session.findUnique({
            where: { id: "delete-condition-lost" },
            select: { seq: true },
        })).toEqual({ seq: 0 });
        expect(await db.accountChange.count({
            where: {
                accountId: "owner",
                kind: "session",
                entityId: "delete-condition-lost",
            },
        })).toBe(0);
        expect(await db.accountChange.count({
            where: {
                accountId: "owner",
                kind: "session",
                entityId: "delete-condition-destination",
            },
        })).toBe(0);
        expect(emitUpdate).not.toHaveBeenCalled();
    });
});
