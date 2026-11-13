import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeSessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSessionPublisherPresence, expireSessionPublisherCandidates } from '@/app/presence/sessionPublisherPresence';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';
import { applyReleasedUiV021SessionEnd } from '@/app/session/compatibility/applyReleasedUiV021SessionEnd';
import { TEAM_CHANGE_ENTITY_ID, publishTeamChangedInTx } from '@/app/teams/teamChanges';
import { readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';

describe('Home broker consumer retirement wakes', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'broker-consumer-changes-', initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const [owner, custodian, directCustodian, stranger] = await Promise.all(Array.from({ length: 4 }, () =>
            db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Broker consumers' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false,
        } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: stranger.id, accessLevel: 'view' } });
        for (const [deliveryMode, account] of [['brokered', custodian], ['direct', directCustodian]] as const) {
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: account.id, displayName: deliveryMode,
                disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
                ...(deliveryMode === 'brokered' ? { brokerMachineId: machine.id } : {}),
            } });
            const slot = deliveryMode === 'brokered' ? { kind: 'provider_model' as const } : {
                kind: 'connected_service_purpose' as const,
                purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'source_control' },
            };
            await db.sessionTeamCredentialBinding.create({ data: {
                sessionId: session.id, slotKind: `${slot.kind}:${deliveryMode}`,
                slotKey: Buffer.from(encodeSessionTeamCredentialSlotKeyV1(slot)),
                resourceId: resource.id, resourceRevision: 0,
            } });
        }
        const read = () => db.accountChange.findMany({ where: { accountId: { in: [owner.id, custodian.id, directCustodian.id, stranger.id] },
            kind: 'account', entityId: TEAM_CHANGE_ENTITY_ID }, orderBy: { accountId: 'asc' },
            select: { accountId: true, entityId: true, kind: true, hint: true } });
        const expected = [custodian.id].map(accountId => ({
            accountId, entityId: TEAM_CHANGE_ENTITY_ID, kind: 'account', hint: null,
        }));
        return { owner, custodian, directCustodian, stranger, team, session, machine, read, expected };
    }

    it.each(['publisher close', 'publisher expiry', 'released stop', 'archive', 'delete'] as const)(
        'publishes one identity-free wake only to the bound broker custodian on %s', async transition => {
            const f = await fixture();
            const presence = createSessionPublisherPresence();
            const socket = {};
            const binding = { accountId: f.owner.id, machineId: f.machine.id, sessionId: f.session.id };
            if (transition === 'publisher close' || transition === 'publisher expiry') {
                const registered = await presence.registerPublisher({ socket, binding,
                    completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
                if (registered.status !== 'registered') throw new Error(`registration ${registered.status}`);
                expect(await f.read()).toEqual([]);
                if (transition === 'publisher close') {
                    expect(await presence.closePublisher({ socket })).toMatchObject({ status: 'closed' });
                    const before = await db.account.findUniqueOrThrow({ where: { id: f.custodian.id }, select: { seq: true } });
                    await presence.closePublisher({ socket });
                    expect(await db.account.findUniqueOrThrow({ where: { id: f.custodian.id }, select: { seq: true } })).toEqual(before);
                } else {
                    expect(await expireSessionPublisherCandidates({ candidates: [{ sessionId: f.session.id,
                        observedFence: registered.committedFence }] })).toMatchObject([{ status: 'expired' }]);
                }
            } else if (transition === 'released stop') {
                await db.session.update({ where: { id: f.session.id }, data: { active: true } });
                expect(await applyReleasedUiV021SessionEnd({ accountId: f.owner.id, sessionId: f.session.id,
                    observedAt: Date.now() + 1_000 })).toEqual({ status: 'applied' });
            } else if (transition === 'archive') {
                await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: f.session.id,
                    wasArchived: false, archivedAt: new Date() }));
            } else {
                expect(await deleteOwnedSession({ sessionId: f.session.id, ownerAccountId: f.owner.id,
                    reason: 'user_request' })).toEqual({ ok: true });
            }
            expect(await f.read()).toEqual(f.expected);
        },
    );

    it('keeps departed broker custodians in the existing Team withdrawal audience without waking direct-only custodians', async () => {
        const f = await fixture();
        await inTx(tx => publishTeamChangedInTx(tx, { teamId: f.team.id }));
        expect(await f.read()).toEqual([f.expected.find(row => row.accountId === f.custodian.id)]);
    });

    it('publishes no broker retirement wake for a rolled back lifecycle transition', async () => {
        const f = await fixture();
        await expect(inTx(async tx => {
            await transitionSessionArchiveStateInTx({ tx, sessionId: f.session.id, wasArchived: false, archivedAt: new Date() });
            throw new Error('abort archive');
        })).rejects.toThrow('abort archive');
        expect(await f.read()).toEqual([]);
        expect(await db.session.findUniqueOrThrow({ where: { id: f.session.id }, select: { archivedAt: true } }))
            .toEqual({ archivedAt: null });
    });

    it('archives plain Sessions without publishing any teams changes', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (let index = 0; index < 5; index++) {
            const session = await db.session.create({ data: { accountId: owner.id,
                tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: session.id,
                wasArchived: false, archivedAt: new Date() }));
        }
        expect(await db.accountChange.count({ where: { accountId: owner.id,
            kind: 'account', entityId: TEAM_CHANGE_ENTITY_ID } })).toBe(0);
    });

    it('admits lifecycle custodian publications through the same census used by enclosing archive and erasure transactions', async () => {
        const f = await fixture();
        const ordinary = await inTx(tx => readSessionAccountCursorAudienceInTx(tx, [f.session.id], []));
        expect(ordinary.accountIds).not.toContain(f.custodian.id);
        const lifecycle = await inTx(tx => readSessionAccountCursorAudienceInTx(tx, [f.session.id], [], { includeLifecyclePublications: true }));
        expect(lifecycle.accountIds).toContain(f.custodian.id);
        expect(lifecycle.accountIds).not.toContain(f.directCustodian.id);
    });
});
