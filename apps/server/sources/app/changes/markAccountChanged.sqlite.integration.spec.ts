import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConnectedServicesAccountChangeV1, readSessionFollowReceiverAvailabilityChangedV1, readSessionFollowSourceChangedV1, readSessionMemoryInputsChangedV1, readSessionMemoryPushedFactsV1, readSessionTranscriptRevisedV1, readSessionUsageAccountingChangedV1 } from '@happier-dev/protocol/changes';

import { markSessionProjectionRecipientsChanged } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import { markPendingStateChangedRecipients } from "@/app/session/pending/markPendingStateChangedRecipients";
import { invalidateSessionReviewProjectionForRunInTx } from '@/app/automations/sessionReviewProjectionInvalidation';
import { db } from "@/storage/db";
import { afterTx, inTx, transactionResult } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { markAccountChanged, markAccountProjectionChanges, markAccountsChanged, markSessionAccountsChanged, type MarkAccountChangedParams } from "./markAccountChanged";
import { recordConnectedServiceAccountProfileChange } from '@/app/api/routes/connect/connectedServicesAccountProfileChange';
import { markDiscussionPrivateReaderChangedInTx } from '@/app/discussions/changes';
import { logger } from '@/utils/logging/log';

describe("terminal AccountChange publication on SQLite", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-publication-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    afterEach(() => { eventRouter.clearIo(); });
    afterAll(async () => { await harness?.close(); });

    it('retains known Artifact kinds for new recipients and keeps unknown history coarse', async () => {
        const owner = await db.account.create({ data: { publicKey: 'artifact-kind-owner' } });
        const recipient = await db.account.create({ data: { publicKey: 'artifact-kind-recipient' } });
        const artifact = await db.artifact.create({ data: { id: 'artifact-kind-portable', accountId: owner.id,
            kind: 'v1:other:bot_template.v1', header: Buffer.from('header'), body: Buffer.from('body'), dataEncryptionKey: Buffer.from('key') } });
        const read = (accountId = recipient.id) => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId, kind: 'artifact', entityId: artifact.id },
        } });
        const publish = (hint?: unknown) => inTx(tx => markAccountsChanged(tx, {
            accountIds: [owner.id, recipient.id], kind: 'artifact', entityId: artifact.id, hint,
        }));
        await publish();
        expect((await read()).hint).toMatchObject({ artifactKinds: ['v1:other:bot_template.v1'] });
        await db.artifact.update({ where: { id: artifact.id }, data: { kind: 'v1:prompt:prompt_doc.v2' } });
        await publish({ artifactKinds: ['v1:other:bot_template.v1', 'v1:prompt:prompt_doc.v2'] });
        await publish();
        expect((await read()).hint).toMatchObject({ artifactKinds: expect.arrayContaining([
            'v1:other:bot_template.v1', 'v1:prompt:prompt_doc.v2',
        ]) });
        await db.accountChange.update({ where: { accountId_kind_entityId: {
            accountId: owner.id, kind: 'artifact', entityId: artifact.id,
        } }, data: { hint: {} } });
        await publish();
        expect((await read(owner.id)).hint).not.toHaveProperty('artifactKinds');
        await db.artifact.delete({ where: { id: artifact.id } });
        await publish();
        await db.artifact.create({ data: { id: artifact.id, accountId: owner.id,
            kind: 'v1:other:bot_template.v1', header: Buffer.from('header'), body: Buffer.from('body'), dataEncryptionKey: Buffer.from('key') } });
        await publish();
        expect((await read()).hint).not.toHaveProperty('artifactKinds');
    });

    it('retains receiver availability through point and batch coalescing only for unconsumed readers', async () => {
        const account = await db.account.create({ data: { publicKey: 'receiver-availability-coalescing' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'receiver-availability', metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const point = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint,
        }));
        await point({ pendingVersion: 1 });
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), 0)).toBe(false);
        await point({ runtimeActivityRevision: 1, followSourceChanged: false, followReceiverAvailabilityChanged: true });
        const availability = await read();
        await point({ metadataVersion: 2, followSourceChanged: false });
        const title = await read();
        expect(readSessionFollowReceiverAvailabilityChangedV1(title, availability.cursor - 1)).toBe(true);
        expect(readSessionFollowReceiverAvailabilityChangedV1(title, availability.cursor)).toBe(false);
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), availability.cursor - 1)).toBe(true);
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), title.cursor)).toBe(false);
        expect(readSessionFollowSourceChangedV1(await read(), title.cursor)).toBe(true);
        await point({ lastMessageSeq: 2 });
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), title.cursor)).toBe(false);
        expect(readSessionFollowSourceChangedV1(await read(), title.cursor)).toBe(true);
    });

    it('proves Workflow origin delivery is unchanged only after the last unobserved publication', async () => {
        const account = await db.account.create({ data: { publicKey: 'workflow-origin-coalescing' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'workflow-origin-coalescing', metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const point = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint,
        }));
        await point({ lastMessageSeq: 1 });
        const append = await read();
        expect(append.hint).toMatchObject({ workflowOriginUnchangedSinceCursor: append.cursor - 1 });
        await point({ kind: 'workflow-run-delivery', runId: 'origin-run', revision: 2 });
        const delivery = await read();
        expect(delivery.hint).not.toHaveProperty('workflowOriginUnchangedSinceCursor');
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect((await read()).hint).toMatchObject({ workflowOriginUnchangedSinceCursor: delivery.cursor });
        await point({ lastMessageSeq: 2, workflowOriginUnchangedSinceCursor: 0 });
        expect((await read()).hint).toMatchObject({ workflowOriginUnchangedSinceCursor: delivery.cursor });
    });

    it('retains a transcript revision under later append and batch coalescing only for unconsumed readers', async () => {
        const account = await db.account.create({ data: { publicKey: 'transcript-revision-coalescing' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'transcript-revision', metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const point = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint,
        }));
        await point({ lastMessageSeq: 1 });
        const append = await read();
        expect(readSessionTranscriptRevisedV1(append, append.cursor - 1)).toBe(false);
        // A writer cannot forge the server-owned revision cursor.
        await point({ lastMessageSeq: 2, transcriptRevisedAtCursor: 1 });
        expect(readSessionTranscriptRevisedV1(await read(), 0)).toBe(false);
        await point({ updatedMessageSeq: 2, updatedMessageId: 'revised' });
        const revision = await read();
        expect(readSessionTranscriptRevisedV1(revision, revision.cursor - 1)).toBe(true);
        await point({ lastMessageSeq: 3 });
        const coalesced = await read();
        expect(readSessionTranscriptRevisedV1(coalesced, revision.cursor - 1)).toBe(true);
        expect(readSessionTranscriptRevisedV1(coalesced, revision.cursor)).toBe(false);
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect(readSessionTranscriptRevisedV1(await read(), revision.cursor - 1)).toBe(true);
        expect(readSessionTranscriptRevisedV1(await read(), revision.cursor)).toBe(false);
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { v: 1, lifecycle: 'deleted' } }));
        expect((await read()).hint).toEqual({ v: 1, lifecycle: 'deleted' });
    });

    it('preserves accounting change floors across projection writes and withdraws them for unknown batches', async () => {
        const account = await db.account.create({ data: { publicKey: 'usage-accounting-coalescing' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'usage-accounting', metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const source = () => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint: { lastMessageSeq: 1 },
        }));
        const projection = (hint: unknown) => inTx(tx => markSessionProjectionRecipientsChanged({
            tx, sessionId: session.id, recipientAccountIds: [account.id], hint, usageAccountingChanged: false,
        }));
        await source();
        const transcript = await read();
        await projection({ agentStateVersion: 1 });
        await projection({ latestTurnStatusObservedAt: 2 });
        expect((await read()).hint).toMatchObject({ usageAccountingChanged: false,
            usageAccountingUnchangedSinceCursor: transcript.cursor });
        // A latest status hint cannot hide the preceding unconsumed transcript.
        expect(readSessionUsageAccountingChangedV1(await read(), transcript.cursor - 1)).toBe(true);
        expect(readSessionUsageAccountingChangedV1(await read(), transcript.cursor)).toBe(false);
        // Accounting projection does not suppress Follow source changes.
        expect(readSessionFollowSourceChangedV1(await read(), transcript.cursor)).toBe(true);
        await source();
        const nextTranscript = await read();
        await projection({ runtimeActivityRevision: 3 });
        expect((await read()).hint).toMatchObject({ usageAccountingUnchangedSinceCursor: nextTranscript.cursor });
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect((await read()).hint).not.toHaveProperty('usageAccountingChanged');
        expect((await read()).hint).not.toHaveProperty('usageAccountingUnchangedSinceCursor');
        const unknown = await read();
        await projection({ metadataVersion: 4 });
        expect((await read()).hint).toMatchObject({ usageAccountingUnchangedSinceCursor: unknown.cursor });
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { v: 1, lifecycle: 'deleted' } }));
        expect((await read()).hint).toEqual({ v: 1, lifecycle: 'deleted' });
    });

    it('keeps the Memory-unchanged floor across activity writes and withdraws it under a coalesced Memory input', async () => {
        const account = await db.account.create({ data: { publicKey: 'memory-inputs-coalescing' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'memory-inputs', metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        let revision = 0;
        const activity = () => inTx(tx => markSessionProjectionRecipientsChanged({
            tx, sessionId: session.id, recipientAccountIds: [account.id], hint: { runtimeActivityRevision: ++revision },
            followSourceChanged: false, usageAccountingChanged: false, memoryInputsChanged: false,
        }));
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { lastMessageSeq: 1 } }));
        const transcript = await read();
        await activity();
        await activity();
        // Activity-only writes after a consumed transcript: Memory inputs unchanged.
        expect((await read()).hint).toMatchObject({ memoryInputsChanged: false, memoryInputsUnchangedSinceCursor: transcript.cursor });
        expect(readSessionMemoryInputsChangedV1(await read(), transcript.cursor)).toBe(false);
        expect(readSessionMemoryInputsChangedV1(await read(), transcript.cursor - 1)).toBe(true);
        const consumed = await read();
        // A metadata write coalesced with a later activity write must stay visible to Memory.
        await inTx(async tx => {
            await markSessionProjectionRecipientsChanged({ tx, sessionId: session.id, recipientAccountIds: [account.id],
                hint: { metadataVersion: 2 }, followSourceChanged: false, usageAccountingChanged: false });
            await markSessionProjectionRecipientsChanged({ tx, sessionId: session.id, recipientAccountIds: [account.id],
                hint: { runtimeActivityRevision: ++revision }, followSourceChanged: false, usageAccountingChanged: false,
                memoryInputsChanged: false });
        });
        expect(readSessionMemoryInputsChangedV1(await read(), consumed.cursor)).toBe(true);
        // A batch/unknown write withdraws the proof outright.
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect((await read()).hint).not.toHaveProperty('memoryInputsChanged');
        expect((await read()).hint).not.toHaveProperty('memoryInputsUnchangedSinceCursor');
    });

    it('keeps the Memory-unchanged floor across pending-queue bookkeeping after a consumed transcript change', async () => {
        const account = await db.account.create({ data: { publicKey: 'memory-inputs-pending' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'memory-inputs-pending', metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { lastMessageSeq: 1 } }));
        const transcript = await read();
        // Enqueue and activation: queue rows are not Memory inputs.
        await inTx(tx => markPendingStateChangedRecipients({ tx, sessionId: session.id, pendingVersion: 1, pendingCount: 1 }));
        await inTx(tx => markPendingStateChangedRecipients({ tx, sessionId: session.id, pendingVersion: 2, pendingCount: 0 }));
        expect(readSessionMemoryInputsChangedV1(await read(), transcript.cursor)).toBe(false);
    });

    it('keeps Memory facts across an Automation Run review invalidation of its source Session', async () => {
        const account = await db.account.create({ data: { publicKey: 'memory-review-invalidation' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'memory-review', metadata: '{}', seq: 4 } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { lastMessageSeq: 4 } }));
        const transcript = await read();
        await inTx(tx => invalidateSessionReviewProjectionForRunInTx(tx, { causeTriggerKind: 'sessionLifecycle',
            causeSessionLifecycleEvent: 'parentTurnCompleted', causeSourceSessionId: session.id }));
        const latest = await read();
        expect(latest.cursor).toBeGreaterThan(transcript.cursor);
        // A Run lifecycle hint touches no Memory input: seq, owner locality, archive and access are unchanged.
        expect(readSessionMemoryInputsChangedV1(latest, transcript.cursor)).toBe(false);
    });

    it('pushes the transcript seq and keeps the Memory locality floor across transcript and queue writes', async () => {
        const account = await db.account.create({ data: { publicKey: 'memory-locality-floor' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'memory-locality', metadata: '{}', seq: 7 } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        await inTx(tx => markSessionProjectionRecipientsChanged({ tx, sessionId: session.id, recipientAccountIds: [account.id],
            hint: { metadataVersion: 2 }, followSourceChanged: false, usageAccountingChanged: false }));
        const consumed = await read();
        await inTx(tx => markSessionProjectionRecipientsChanged({ tx, sessionId: session.id, recipientAccountIds: [account.id],
            hint: { lastMessageSeq: 7 }, memoryLocalityChanged: false }));
        await inTx(tx => markPendingStateChangedRecipients({ tx, sessionId: session.id, pendingVersion: 3, pendingCount: 0 }));
        const latest = await read();
        expect(readSessionMemoryPushedFactsV1(latest, consumed.cursor)).toEqual({ transcriptSeq: 7, localityUnchanged: true });
        // A metadata write withdraws the locality proof.
        await inTx(tx => markSessionProjectionRecipientsChanged({ tx, sessionId: session.id, recipientAccountIds: [account.id],
            hint: { metadataVersion: 3 }, followSourceChanged: false, usageAccountingChanged: false }));
        expect(readSessionMemoryPushedFactsV1(await read(), consumed.cursor)).toEqual({ transcriptSeq: 7 });
    });

    it('attributes committed connected-service publications without credential or Account identifiers', async () => {
        const account = await db.account.create({ data: { publicKey: 'connected-publication-attribution' } });
        const diagnostic = vi.spyOn(logger, 'debug');
        try {
            const publish = (tx: Parameters<typeof recordConnectedServiceAccountProfileChange>[0]['tx']) =>
                recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, reason: 'credential-health',
                    service: { pluginId: 'test.email', localId: 'email-imap-smtp' } });
            await expect(inTx(async tx => { await publish(tx); throw new Error('fixture rollback'); }))
                .rejects.toThrow('fixture rollback');
            expect(diagnostic.mock.calls.filter(([, message]) => message === 'Connected service Account change committed')).toEqual([]);
            await inTx(publish);
            expect(diagnostic.mock.calls.filter(([, message]) => message === 'Connected service Account change committed'))
                .toEqual([[{ reason: 'credential-health', serviceKind: 'email-imap-smtp' }, 'Connected service Account change committed']]);
        } finally { diagnostic.mockRestore(); }
    });

    it.each(['read-first', 'resource-first'] as const)('retains the union of private Discussion read-state and resource changes (%s)', async order => {
        const account = await db.account.create({ data: { publicKey: `discussion-hint-${order}` } });
        const entityId = `discussion-${order}`;
        const readState = (tx: Parameters<typeof markAccountChanged>[0]) => markDiscussionPrivateReaderChangedInTx({
            tx, accountId: account.id, discussionId: entityId,
        });
        const resource = (tx: Parameters<typeof markAccountChanged>[0]) => markAccountsChanged(tx, {
            accountIds: [account.id], kind: 'discussion', entityId,
            hint: { v: 1, discussions: true, changes: { resource: true } },
        });
        const first = order === 'read-first' ? readState : resource;
        const second = order === 'read-first' ? resource : readState;
        await inTx(async tx => { await first(tx); });
        const readHint = async () => (await db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: 'discussion', entityId } },
            select: { hint: true },
        })).hint;
        expect(await readHint()).toEqual({ v: 1, discussions: true,
            changes: order === 'read-first' ? { readState: true } : { resource: true } });
        await inTx(async tx => { await second(tx); await readState(tx); });
        expect(await readHint()).toEqual({ v: 1, discussions: true, changes: { readState: true, resource: true } });
        expect(await db.accountChange.count({ where: { accountId: account.id, kind: 'discussion', entityId } })).toBe(1);
    });

    it('keeps connected service entities cursor-relative and independent of self changes', async () => {
        const account = await db.account.create({ data: { publicKey: 'connected-service-entities' } });
        const first = { pluginId: 'test.connected', localId: 'first' };
        const second = { pluginId: 'test.connected', localId: 'second' };
        const firstChange = buildConnectedServicesAccountChangeV1(first);
        const secondChange = buildConnectedServicesAccountChangeV1(second);
        const broadChange = buildConnectedServicesAccountChangeV1();
        const readChanges = (after = 0) => db.accountChange.findMany({
            where: { accountId: account.id, cursor: { gt: after } }, orderBy: { cursor: 'asc' },
            select: { kind: true, entityId: true, hint: true },
        });
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
                hint: { connectedServices: true } });
            await recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: first });
            await recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: second });
            await markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
                hint: { settingsVersion: 7 } });
        });
        expect(await readChanges()).toEqual([
            firstChange, secondChange, { kind: 'account', entityId: 'self', hint: { settingsVersion: 7 } },
        ]);
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
            hint: { username: true } }));
        expect((await readChanges()).at(-1)).toEqual({ kind: 'account', entityId: 'self', hint: { username: true } });
        await inTx(tx => markAccountsChanged(tx, { accountIds: [account.id], kind: 'account', entityId: 'self' }));
        expect((await readChanges()).at(-1)?.hint).toBeNull();
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id }));
        expect(await readChanges()).toHaveLength(4);
        expect((await readChanges()).at(-1)).toEqual(broadChange);
        const checkpoint = (await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq;
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: first }));
        expect(await readChanges(checkpoint)).toEqual([firstChange]);
    });

    it("retains queued Session and Machine removal changes after domain work deletes their rows", async () => {
        const account = await db.account.create({ data: { publicKey: "deleted-publication-resources" } });
        const pointSession = await db.session.create({ data: { accountId: account.id, tag: "deleted-point", metadata: "{}" } });
        const batchSession = await db.session.create({ data: { accountId: account.id, tag: "deleted-batch", metadata: "{}" } });
        const pointMachine = await db.machine.create({ data: { id: "deleted-point-machine", accountId: account.id, metadata: "{}" } });
        const batchMachine = await db.machine.create({ data: { id: "deleted-batch-machine", accountId: account.id, metadata: "{}" } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });

        const changes = await inTx(async tx => {
            const pointSessionChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "session", entityId: pointSession.id, hint: { removed: true },
            });
            const [batchSessionChange] = await markSessionAccountsChanged(tx, new Map([[batchSession.id, [account.id]]]));
            const pointMachineChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "machine", entityId: pointMachine.id, hint: { removed: true },
            });
            const [batchMachineChange] = await markAccountsChanged(tx, {
                accountIds: [account.id], kind: "machine", entityId: batchMachine.id, hint: { removed: true, batch: true },
            });
            await tx.session.deleteMany({ where: { id: { in: [pointSession.id, batchSession.id] } } });
            await tx.machine.deleteMany({ where: { id: { in: [pointMachine.id, batchMachine.id] } } });
            expect(emit).not.toHaveBeenCalled();
            return transactionResult(() => [
                { kind: "session", entityId: pointSession.id, cursor: pointSessionChange.resolveCursor(), hint: expect.objectContaining({ removed: true, followReceiverAvailabilityChanged: false }) },
                { kind: "session", entityId: batchSession.id, cursor: batchSessionChange.resolveCursor(), hint: expect.objectContaining({ followReceiverAvailabilityChanged: false }) },
                { kind: "machine", entityId: pointMachine.id, cursor: pointMachineChange.resolveCursor(), hint: { removed: true } },
                { kind: "machine", entityId: batchMachine.id, cursor: batchMachineChange.resolveCursor(), hint: { removed: true, batch: true } },
            ]);
        });

        expect(changes.map(change => change.cursor).sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
        await expect(db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: "asc" },
            select: { kind: true, entityId: true, cursor: true, hint: true,
                sessionId: true, machineId: true, artifactId: true, accountPetPackageId: true } }))
            .resolves.toEqual(changes.map(change => ({ ...change,
                sessionId: null, machineId: null, artifactId: null, accountPetPackageId: null,
            })).sort((left, right) => left.cursor - right.cursor));
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({ seq: 4,
            body: expect.objectContaining({ t: "account-change", changeKinds: ["session", "machine"],
                entityIds: [pointSession.id, batchSession.id, pointMachine.id, batchMachine.id] }),
        }));
    });

    it("batches hint-free Machine invalidation without losing retained portable hints or durable cursors", async () => {
        const accounts = await Promise.all(["first", "second", "new"].map(name => db.account.create({
            data: { publicKey: `machine-batch-${name}` },
        })));
        const machine = await db.machine.create({ data: { id: "retained-batch-machine", accountId: accounts[0].id, metadata: "{}" } });
        await inTx(async tx => {
            for (const [index, account] of accounts.slice(0, 2).entries()) await markAccountChanged(tx, {
                accountId: account.id, kind: "machine", entityId: machine.id, hint: { daemonStateVersion: index + 1 },
            });
        });
        const publish = () => inTx(tx => markAccountsChanged(tx, {
            accountIds: accounts.map(account => account.id), kind: "machine", entityId: machine.id,
        }));
        const expected = accounts.map((account, index) => ({ accountId: account.id, cursor: index < 2 ? 2 : 1,
            hint: index < 2 ? { daemonStateVersion: index + 1 } : null,
        })).sort((left, right) => left.accountId.localeCompare(right.accountId));
        const readChanges = () => db.accountChange.findMany({ where: { kind: "machine", entityId: machine.id },
            orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true, machineId: true, hint: true } });
        const publications = await publish();
        expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
            .toEqual(expected.map(({ hint: _hint, ...row }) => row));
        expect(await readChanges()).toEqual(expected.map(row => ({ ...row, machineId: machine.id })));
        await db.machine.delete({ where: { id: machine.id } });
        await publish();
        expect(await readChanges()).toEqual(expected.map(row => ({ ...row, cursor: row.cursor + 1, machineId: null })));
        expect(await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            orderBy: { id: "asc" }, select: { id: true, seq: true } }))
            .toEqual(expected.map(row => ({ id: row.accountId, seq: row.cursor + 1 })));
    });

    it("coalesces mixed writers independently for each recipient Account", async () => {
        const accounts = await Promise.all(["first", "second"].map(name => db.account.create({
            data: { publicKey: `coalesced-${name}-recipient` },
        })));
        const emit = vi.fn();
        const to = vi.fn((_room: string | string[]) => ({ emit, disconnectSockets: vi.fn() }));
        eventRouter.setIo({ to });
        await inTx(async tx => {
            await markAccountChanged(tx, { accountId: accounts[0].id, kind: "account", entityId: "settings" });
            await markAccountsChanged(tx, { accountIds: accounts.map(account => account.id), entityId: "profile" });
            expect(emit).not.toHaveBeenCalled();
        });
        expect(to.mock.calls.map(([room]) => room).sort()).toEqual(accounts
            .map(account => `account-stored-content-v3:${account.id}`).sort());
        expect(emit.mock.calls.map(([, payload]) => payload.seq).sort()).toEqual([1, 2]);
        expect(emit.mock.calls.every(([event, payload]) => event === "update" && payload.body.t === "account-change")).toBe(true);
        expect(emit.mock.calls.map(([, payload]) => payload.body)).toEqual(expect.arrayContaining([
            { t: "account-change", changeKinds: ["account"], entityIds: ["settings", "profile"] },
            { t: "account-change", changeKinds: ["account"], entityIds: ["profile"] },
        ]));
    });

    it("captures the declared Session audience and entities before caller-owned maps and arrays change", async () => {
        const owner = await db.account.create({ data: { publicKey: "captured-session-owner" } });
        const later = await db.account.create({ data: { publicKey: "later-session-recipient" } });
        const original = await db.session.create({ data: { accountId: owner.id, tag: "captured", metadata: "{}" } });
        const replacement = await db.session.create({ data: { accountId: owner.id, tag: "replacement", metadata: "{}" } });

        const publications = await inTx(async tx => {
            const accountIds = [owner.id];
            const recipients = new Map([[original.id, accountIds]]);
            const publications = await markSessionAccountsChanged(tx, recipients);
            accountIds.push(later.id);
            recipients.delete(original.id);
            recipients.set(replacement.id, [later.id]);
            return publications;
        });

        expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
            .toEqual([{ accountId: owner.id, cursor: 1 }]);
        await expect(db.accountChange.findMany({ where: { accountId: { in: [owner.id, later.id] } },
            select: { accountId: true, entityId: true, sessionId: true } })).resolves.toEqual([{
            accountId: owner.id, entityId: original.id, sessionId: original.id,
        }]);
        await expect(db.account.findUniqueOrThrow({ where: { id: later.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: 0 });
    });

    it("captures shared Account hints before terminal set publication and clears them on a later hint-free write", async () => {
        const accounts = await Promise.all(["first", "second"].map(name => db.account.create({ data: { name, encryptionMode: 'plain' } })));
        const accountIds = accounts.map(account => account.id).sort();
        const hint = { scope: ['original'] };
        await inTx(async tx => {
            await markAccountProjectionChanges(tx, 'account', new Map([['shared-hint', accountIds]]), hint);
            hint.scope.push('later');
        });
        const readHints = () => db.accountChange.findMany({ where: { accountId: { in: accountIds }, entityId: 'shared-hint' },
            orderBy: { accountId: 'asc' }, select: { accountId: true, cursor: true, hint: true } });
        expect(await readHints()).toEqual(accountIds.map(accountId => ({ accountId, cursor: 1, hint: { scope: ['original'] } })));
        await inTx(tx => markAccountsChanged(tx, { accountIds, kind: 'account', entityId: 'shared-hint' }));
        expect(await readHints()).toEqual(accountIds.map(accountId => ({ accountId, cursor: 2, hint: null })));
    });

    it("captures point publication parameters and hints when the intent is recorded", async () => {
        const owner = await db.account.create({ data: { publicKey: "captured-point-owner" } });
        const later = await db.account.create({ data: { publicKey: "later-point-recipient" } });
        const publication = await inTx(async tx => {
            const hint = { keys: ["original"] };
            const params: MarkAccountChangedParams = { accountId: owner.id, kind: "account", entityId: "original", hint };
            const publication = await markAccountChanged(tx, params);
            params.accountId = later.id;
            params.entityId = "replacement";
            hint.keys[0] = "replacement";
            return publication;
        });

        expect(publication.accountId).toBe(owner.id);
        expect(publication.resolveCursor()).toBe(1);
        await expect(db.accountChange.findMany({ where: { accountId: { in: [owner.id, later.id] } },
            select: { accountId: true, entityId: true, hint: true } })).resolves.toEqual([{
            accountId: owner.id, entityId: "original", hint: { keys: ["original"] },
        }]);
        await expect(db.account.findUniqueOrThrow({ where: { id: later.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: 0 });
    });

    it("defers allocation until domain work finishes and preserves queued full Collection invalidation", async () => {
        const account = await db.account.create({ data: { publicKey: "queued-collection-publication" } });
        const pluginId = "example.contract";
        const collectionId = "queued";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        let afterCommitCursor: number | undefined;

        const result = await inTx(async tx => {
            const full = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "a".repeat(43), revision: 1, full: true },
            });
            const exact = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "b".repeat(43), revision: 2, rowIds: ["task-1"] },
            });
            expect(() => exact.resolveCursor()).toThrow();
            expect(await tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
            expect(await tx.accountChange.findMany({ where: { accountId: account.id } })).toEqual([]);
            expect(emit).not.toHaveBeenCalled();
            afterTx(tx, () => { afterCommitCursor = exact.resolveCursor(); });
            return transactionResult(() => ({ fullCursor: full.resolveCursor(), cursor: exact.resolveCursor() }));
        });

        expect(result.cursor).toBeGreaterThanOrEqual(result.fullCursor);
        expect(afterCommitCursor).toBe(result.cursor);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({
            seq: result.cursor, body: { t: "account-change", changeKinds: ["pluginDomain"], entityIds: [entityId] },
        }));
        await expect(db.accountChange.findMany({ where: { accountId: account.id },
            select: { entityId: true, cursor: true, hint: true } })).resolves.toEqual([{
            entityId, cursor: result.cursor,
            hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                contractDigest: "b".repeat(43), revision: 2, full: true },
        }]);
    });

    it("rolls back terminal allocation and suppresses wakes when result projection fails", async () => {
        const account = await db.account.create({ data: { publicKey: "failed-publication-result" } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });
        const failure = new Error("result projection rejected");

        await expect(inTx(async tx => {
            const publication = await markAccountChanged(tx, {
                accountId: account.id, kind: "account", entityId: "settings",
            });
            return transactionResult(() => {
                expect(publication.resolveCursor()).toBe(1);
                throw failure;
            });
        })).rejects.toBe(failure);

        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
            .resolves.toEqual({ seq: 0 });
        await expect(db.accountChange.findMany({ where: { accountId: account.id } })).resolves.toEqual([]);
        expect(emit).not.toHaveBeenCalled();

        for (const cursor of [1, 2]) {
            const publication = await inTx(async tx => markAccountChanged(tx, {
                accountId: account.id, kind: "account", entityId: "settings",
            }));
            expect(publication.resolveCursor()).toBe(cursor);
            expect(emit).toHaveBeenCalledTimes(cursor);
            expect(emit).toHaveBeenLastCalledWith("update", expect.objectContaining({
                seq: cursor, body: { t: "account-change", changeKinds: ["account"], entityIds: ["settings"] },
            }));
        }
    });
});
