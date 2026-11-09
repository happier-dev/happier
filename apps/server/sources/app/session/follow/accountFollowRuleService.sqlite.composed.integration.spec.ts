import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { readSessionFollowRuleProgressInTx, writeSessionFollowRuleProgressInTx } from './sessionFollowRuleProgress';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { getAccountFollowRule, listAccountFollowRules, removeAccountFollowRule, setAccountFollowRule } from './accountFollowRuleService';
import { createSessionMessage } from '@/app/session/sessionWriteService';
import { buildSessionFollowRulePhysicalKeyV1, ListSessionFollowRulesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { decodeBase64 } from 'privacy-kit';
import { updateAccountFollowCreationPreferencesInTx } from './accountFollowCreationPreferences';

describe('private Follow rule service (SQLite)', () => {
    let harness: LightSqliteHarness;
    let previousStoragePolicy: string | undefined;
    beforeAll(async () => {
        previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-rule-undo-', initAuth: false });
    }, 180_000);
    afterAll(async () => {
        await harness?.close();
        if (previousStoragePolicy === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
    });

    it.each(['own', 'foreign'] as const)('discovers the first missed %s original from Account changes without enrolling sources or replaying precreation history', async placement => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sourceOwner = placement === 'own' ? account : await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const share = async (sessionId: string) => {
            if (placement === 'foreign') await db.sessionShare.create({ data: { sessionId, sharedByUserId: sourceOwner.id,
                sharedWithUserId: account.id, accessLevel: 'view' } });
        };
        await share(source.id);
        const authentication = createPresentUserSessionAccessAuthentication();
        const publish = (sessionId: string) => {
            const localId = randomUUID();
            return createSessionMessage({ actorUserId: sourceOwner.id, sessionId,
                inputAdmission: 'transcriptOnly', localId, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: localId,
                    data: { type: 'worker-report', summary: 'original update' } } } } });
        };
        const old = await publish(source.id);
        expect(old.ok).toBe(true);
        if (!old.ok) throw new Error(old.error);
        // Existing original timestamps are the history boundary; use a strict
        // older row, independently of the clock's millisecond tie granularity.
        await db.sessionMessage.update({ where: { id: old.message.id }, data: { createdAt: new Date(0) } });
        const scope = { accountId: account.id, authentication, ruleId: randomUUID() };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const content = { t: 'plain' as const, v: { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } } };
        const created = await setAccountFollowRule({ ...scope, mutation: { receiver, content, expectedVersion: -1 } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        expect(created.value.rule.sources).toBeUndefined();
        expect(await db.sessionFollowEdge.count()).toBe(0);
        expect((await publish(source.id)).ok).toBe(true);
        expect((await publish(source.id)).ok).toBe(true);
        const demand = { ...scope, destinationSessionId: destination.id };
        const read = await listAccountFollowRules(demand);
        expect(read).toMatchObject({ ok: true, value: { sourceRanges: { status: 'available', sources: [{
            sourceSessionId: source.id, delivered: { transcriptSeq: 1, agentStateVersion: 0 }, throughSeq: 3,
        }] } } });
        if (!read.ok) throw new Error(read.error);
        const wire = ListSessionFollowRulesResponseV1Schema.parse(read.value);
        const firstRange = wire.sourceRanges?.sources.find(row => row.sourceSessionId === source.id);
        if (!firstRange) throw new Error('Missing first range');
        // The actual current-source reader consumes the committed writer's
        // records after the transport's strict range parser, without a second
        // event classifier or hand-authored semantic occurrence fixture.
        const { readCommittedSessionFollowSourceOccurrence } = await vi.importActual<{
            readCommittedSessionFollowSourceOccurrence: (input: Readonly<Record<string, unknown>>) => unknown;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowRuleSourceEvidence');
        const originals = await db.sessionMessage.findMany({ where: { sessionId: source.id,
            seq: { gt: firstRange.delivered.transcriptSeq, lte: firstRange.throughSeq } }, orderBy: { seq: 'asc' } });
        expect(originals.map(row => readCommittedSessionFollowSourceOccurrence({ sourceSessionId: source.id,
            serverId: 'home', ownerAccountId: sourceOwner.id, origin: { kind: 'none' }, mode: 'plain', ctx: null,
            row: { id: row.id, seq: row.seq, localId: row.localId, sidechainId: row.sidechainId,
                messageRole: row.messageRole, content: row.content, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime() },
        }))).toEqual([2, 3].map(seq => expect.objectContaining({ status: 'occurrence', occurrence: expect.objectContaining({
            sourceSessionId: source.id, sourceMessage: expect.objectContaining({ seq }),
            evidence: expect.objectContaining({ event: { kind: 'update_posted' } }),
        }) })));
        await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
        expect(await listAccountFollowRules(demand)).toMatchObject({ ok: true, value: { sourceRanges: { status: 'unavailable', sources: [] } } });
        await db.session.update({ where: { id: source.id }, data: { archivedAt: null } });
        // A later Session reaches exactly the same change/recovery reader.
        const future = await db.session.create({ data: { accountId: sourceOwner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await share(future.id);
        expect((await publish(future.id)).ok).toBe(true);
        const later = await listAccountFollowRules(demand);
        expect(later).toMatchObject({ ok: true, value: { sourceRanges: { status: 'available', sources: expect.arrayContaining([
            expect.objectContaining({ sourceSessionId: future.id, delivered: expect.objectContaining({ transcriptSeq: 0 }), throughSeq: 1 }),
        ]) } } });
        const exact = await listAccountFollowRules({ ...demand, sourceSessionId: future.id });
        expect(exact).toMatchObject({ ok: true, value: { sourceRanges: { status: 'available', sources: [{
            sourceSessionId: future.id, delivered: { transcriptSeq: 0 }, throughSeq: 1,
        }] } } });
        expect(await getAccountFollowRule(scope)).toEqual({ ok: true, value: { rule: created.value.rule } });
        const edited = await setAccountFollowRule({ ...scope, mutation: { receiver, content: { ...content,
            v: { ...content.v, policy: { preset: 'quiet' } } }, expectedVersion: created.value.rule.version } });
        expect(edited).toMatchObject({ ok: true, value: { rule: { inception: expect.any(Object) } } });
        if (!edited.ok) throw new Error(edited.error);
        expect(edited.value.rule.inception).toEqual(created.value.rule.inception);
        expect(await listAccountFollowRules(demand)).toMatchObject({ ok: true, value: { sourceRanges: { status: 'available', sources: expect.arrayContaining([
            expect.objectContaining({ sourceSessionId: source.id, delivered: expect.objectContaining({ transcriptSeq: 1 }), throughSeq: 3 }),
        ]) } } });
        expect(await db.sessionFollowEdge.count()).toBe(0);
    });

    it('keeps the inception cursor at the changes floor readable and reports a crossed floor as unavailable', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const scope = { accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), ruleId: randomUUID() };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const created = await setAccountFollowRule({ ...scope, mutation: { receiver, expectedVersion: -1,
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } } });
        if (!created.ok) throw new Error(created.error);
        const cursor = created.value.rule.inception?.accountChangeCursor;
        if (cursor === undefined) throw new Error('Missing server-owned inception cursor');
        const localId = randomUUID();
        expect(await createSessionMessage({ actorUserId: account.id, sessionId: source.id, inputAdmission: 'transcriptOnly',
            localId, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: localId,
                data: { type: 'worker-report', summary: 'After rule creation' } } } } })).toMatchObject({ ok: true });
        const demand = { ...scope, destinationSessionId: destination.id };
        await db.account.update({ where: { id: account.id }, data: { changesFloor: cursor } });
        expect(await listAccountFollowRules(demand)).toMatchObject({ ok: true, value: { sourceRanges: {
            status: 'available', sources: [expect.objectContaining({ sourceSessionId: source.id, throughSeq: 1 })],
        } } });
        // Coalesced source rows can remain after older changes were pruned;
        // their presence must never turn incomplete discovery into a complete census.
        await db.account.update({ where: { id: account.id }, data: { changesFloor: cursor + 1 } });
        expect(await listAccountFollowRules(demand)).toMatchObject({ ok: true, value: { sourceRanges: { status: 'unavailable' } } });
        expect(await getAccountFollowRule(scope)).toEqual({ ok: true, value: { rule: created.value.rule } });
        expect(await db.sessionFollowEdge.count()).toBe(0);
    });

    it('uses the owning retained KV creation time when inception was not yet carried and preserves accepted progress on edit', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const destination = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const scope = { accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), ruleId: randomUUID() };
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const content = { t: 'plain' as const, v: { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } } };
        const sources = [{ sourceSessionId: source.id, delivered: { transcriptSeq: 7, readyEventSeq: 0, agentStateVersion: 2, turn: null } }];
        const encoded = encodeAccountScopedKvJson({ version: 0, receiver, content, sources });
        if (encoded === null) throw new Error('Expected encoded rule fixture');
        await db.userKVStore.create({ data: { accountId: account.id, key: buildSessionFollowRulePhysicalKeyV1(scope.ruleId),
            version: 4, createdAt: new Date(50), value: decodeBase64(encoded) } });
        const read = await getAccountFollowRule(scope);
        expect(read).toMatchObject({ ok: true, value: { rule: { inception: { createdAt: 50 }, sources } } });
        const edited = await setAccountFollowRule({ ...scope, mutation: { receiver, content, expectedVersion: 0 } });
        expect(edited).toMatchObject({ ok: true, value: { rule: { version: 1, inception: { createdAt: 50 }, sources } } });
    });

    it('requires full Account authority even when a signed transport retains a restricted grant', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const scope = { accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), ruleId: randomUUID() };
        const [source, destination] = await Promise.all([0, 1].map(() => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } })));
        const receiver = { kind: 'session' as const, sessionId: destination.id };
        const content = { t: 'plain' as const, v: { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } } };
        const created = await setAccountFollowRule({ ...scope, mutation: { receiver, content, expectedVersion: -1 } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const delivered = { transcriptSeq: 7, readyEventSeq: 0, agentStateVersion: 2, turn: null };
        expect(await inTx(async tx => {
            const admission = await readSessionFollowRuleProgressInTx(tx, { accountId: account.id,
                rule: { ruleId: scope.ruleId, ruleVersion: created.value.rule.version },
                sourceSessionId: source.id, destinationSessionId: destination.id });
            return admission !== null && await writeSessionFollowRuleProgressInTx(tx, admission, delivered);
        })).toBe(true);
        // This is the authenticated credential boundary, not a substitute for
        // the private reader or grant predicate exercised beneath it.
        const authentication = { ...scope.authentication, authority: 'account_automation' as const,
            apiTokenGrant: { ...API_TOKEN_FULL_GRANT_V1,
                actions: { families: [], ids: ['follow.get', 'follow.list', 'follow.set', 'follow.remove'] } } };
        const restricted = { ...scope, authentication };
        const denied = { ok: false, error: 'credential_scope_denied' };
        expect(await getAccountFollowRule(restricted)).toEqual(denied);
        expect(await listAccountFollowRules(restricted)).toEqual(denied);
        expect(await setAccountFollowRule({ ...restricted, mutation: { receiver, content, expectedVersion: created.value.rule.version } })).toEqual(denied);
        expect(await removeAccountFollowRule({ ...restricted, receiver, expectedVersion: created.value.rule.version })).toEqual(denied);
        const foreign = { ...scope, accountId: (await db.account.create({ data: { encryptionMode: 'plain' } })).id };
        expect(await getAccountFollowRule(foreign)).toEqual({ ok: true, value: { rule: null } });
        expect(await listAccountFollowRules(foreign)).toEqual({ ok: true, value: { rules: [] } });
        const expected = { ...created.value.rule, sources: [{ sourceSessionId: source.id, delivered }] };
        expect(await getAccountFollowRule({ ...scope, authentication: { ...authentication, apiTokenGrant: API_TOKEN_FULL_GRANT_V1 } }))
            .toEqual({ ok: true, value: { rule: expected } });
        expect(await listAccountFollowRules(scope)).toEqual({ ok: true, value: { rules: [expected] } });
    });

    it('refuses progress without publishing when its existing rule loses the physical revision CAS', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const scope = { accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), ruleId: randomUUID() };
        const created = await setAccountFollowRule({ ...scope, mutation: {
            receiver: { kind: 'account' }, expectedVersion: -1,
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
        } });
        if (!created.ok) throw new Error(created.error);
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        const changed = await inTx(async tx => {
            const admission = await readSessionFollowRuleProgressInTx(tx, { accountId: account.id,
                rule: { ruleId: scope.ruleId, ruleVersion: created.value.rule.version }, sourceSessionId: source.id });
            if (!admission) throw new Error('Expected current rule progress');
            // The persistent DB boundary reports a refused existing-row CAS;
            // Account admission, rule validation and publication remain real.
            const rows = new Proxy(tx.userKVStore, { get(target, key, receiver) {
                return key === 'updateMany' ? async () => ({ count: 0 }) : Reflect.get(target, key, receiver);
            } });
            const losingTx = new Proxy(tx, { get(target, key, receiver) {
                return key === 'userKVStore' ? rows : Reflect.get(target, key, receiver);
            } });
            return writeSessionFollowRuleProgressInTx(losingTx, admission,
                { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null });
        });
        expect(changed).toBe(false);
        expect(await getAccountFollowRule(scope)).toEqual({ ok: true, value: { rule: created.value.rule } });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(before);
    });

    it('restores only the acknowledged deletion and refuses stale Undo after a later edit', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            metadata: '{}', encryptionMode: 'plain' } });
        const scope = { accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), ruleId: randomUUID() };
        const receiver = { kind: 'session' as const, sessionId: session.id };
        const content = { t: 'plain' as const, v: { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], startedBy: ['you'], scope: 'all_accessible' }),
            policy: { preset: 'important' as const } } };
        const created = await setAccountFollowRule({ ...scope, mutation: { receiver, content, expectedVersion: -1 } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const stopped = await removeAccountFollowRule({ ...scope, receiver, expectedVersion: created.value.rule.version });
        expect(stopped.ok).toBe(true);
        if (!stopped.ok) throw new Error(stopped.error);
        expect(await getAccountFollowRule(scope)).toEqual({ ok: true, value: { rule: null } });

        const restored = await setAccountFollowRule({ ...scope,
            mutation: { receiver, content, expectedVersion: stopped.value.version } });
        expect(restored.ok).toBe(true);
        if (!restored.ok) throw new Error(restored.error);
        expect(restored.value.rule).toMatchObject({ ruleId: scope.ruleId, receiver, content });
        const edited = await setAccountFollowRule({ ...scope, mutation: { receiver,
            content: { ...content, v: { ...content.v, enabled: false } }, expectedVersion: restored.value.rule.version } });
        expect(edited.ok).toBe(true);
        if (!edited.ok) throw new Error(edited.error);
        expect(await setAccountFollowRule({ ...scope,
            mutation: { receiver, content, expectedVersion: stopped.value.version } }))
            .toEqual({ ok: false, error: 'version_conflict' });
        expect(await getAccountFollowRule(scope)).toEqual({ ok: true, value: { rule: edited.value.rule } });
    });
    it.each(['set', 'remove'] as const)('returns version_conflict after a late physical rule CAS refusal during %s', async operation => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const scope = { accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), ruleId: randomUUID() };
        const receiver = { kind: 'account' as const };
        const content = { t: 'plain' as const, v: { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } } };
        const created = await setAccountFollowRule({ ...scope, mutation: { receiver, content, expectedVersion: -1 } });
        if (!created.ok) throw new Error(created.error);
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        const transact = db.$transaction;
        const physicalKey = buildSessionFollowRulePhysicalKeyV1(scope.ruleId);
        // Instrument only the persistent transaction transport: all admission,
        // validation and publication logic executes against the real SQLite DB.
        const transport = async (work: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transact(async tx => {
            const rows = new Proxy(tx.userKVStore, { get(target, key, receiver) {
                if (key !== 'updateMany') return Reflect.get(target, key, receiver);
                return (input: Parameters<Tx['userKVStore']['updateMany']>[0]) => input?.where?.key === physicalKey
                    ? Promise.resolve({ count: 0 }) : target.updateMany(input);
            } });
            return work(new Proxy(tx, { get(target, key, receiver) {
                return key === 'userKVStore' ? rows : Reflect.get(target, key, receiver);
            } }));
        }, options);
        // Prisma exposes array and callback overloads; this test intercepts only
        // the interactive callback boundary used by the public service.
        db.$transaction = transport as typeof db.$transaction;
        try {
            const result = operation === 'set'
                ? await setAccountFollowRule({ ...scope, mutation: { receiver, content: { ...content, v: { ...content.v, enabled: false } },
                    expectedVersion: created.value.rule.version } })
                : await removeAccountFollowRule({ ...scope, receiver, expectedVersion: created.value.rule.version });
            expect(result).toEqual({ ok: false, error: 'version_conflict' });
        } finally {
            db.$transaction = transact;
        }
        expect(await getAccountFollowRule(scope)).toEqual({ ok: true, value: { rule: created.value.rule } });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(before);
    });
    it('preserves the creation-preferences refusal code when its physical revision CAS loses', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await inTx(tx => updateAccountFollowCreationPreferencesInTx(tx, { accountId: account.id, patch: { managerPolicy: { preset: 'quiet' } } }));
        await expect(inTx(async tx => {
            // The real persistent boundary refuses the write; the owning
            // preference merge and KV validation remain unmocked.
            const rows = new Proxy(tx.userKVStore, { get(target, key, receiver) {
                return key === 'updateMany' ? async () => ({ count: 0 }) : Reflect.get(target, key, receiver);
            } });
            const losingTx = new Proxy(tx, { get(target, key, receiver) {
                return key === 'userKVStore' ? rows : Reflect.get(target, key, receiver);
            } });
            return updateAccountFollowCreationPreferencesInTx(losingTx, { accountId: account.id, patch: { managerPolicy: { preset: 'important' } } });
        })).rejects.toMatchObject({ code: 'follow_preferences_unavailable' });
    });
});
