import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { readMachinePresenceForAccountInTx, retainMachinePresenceTransitionInTx } from '@/app/presence/machinePresenceTransitions';
import { recordMachineAlive } from '@/app/presence/presenceRecorder';
import { stopLocalMachinePresenceTimeout } from '@/app/presence/timeout';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

const serverId = 'srv_presenceWorkflowComposed1';
let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-presence-workflow-', initAuth: false,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
}, 120_000);
afterAll(async () => { await stopLocalMachinePresenceTimeout(); await harness?.close(); });

// AM2: the server publishes structural candidates, while the key-holding client
// owns private filtering and Run admission. The presence owner supplies audience.
it('publishes any and exact Machine candidates to the decided audience without admitting Runs or replaying enrollment', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const shared = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const denied = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
    const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } });
    if (recipe.kind !== 'available') throw new Error('workflow_recipe_invalid');
    const add = async (accountId: string, subjectMachineId?: string, eventLocalId = 'machine-offline') => {
        const executor = await db.machine.create({ data: { id: randomUUID(), accountId, metadata: '{}' } });
        const automation = await db.automation.create({ data: { accountId, name: 'Presence diagnosis', enabled: true,
            templateCiphertext: recipe.serialized, templateVersion: 1, workflowDefinitionId: 'builtin:keep-going' } });
        await db.automationAssignment.create({ data: { automationId: automation.id, machineId: executor.id, enabled: true } });
        await db.automationTrigger.create({ data: { automationId: automation.id, id: randomUUID(), kind: 'pluginEvent',
            enabled: true, revision: 1, eventPluginId: 'happier.machine.services', eventLocalId,
            sourceSelectorId: randomUUID(), sourceContractVersion: 1, observationTransport: 'checkpointedPull',
            watcherMachineId: executor.id, watcherMachineInstallationId: randomUUID(),
            watcherPluginId: 'happier.machine.services', watcherMaterializationId: randomUUID(),
            // Structural matching must not open the private stored definition.
            definitionEnvelope: 'opaque-client-owned-definition',
            ...(subjectMachineId ? { subjectKind: 'machine', subjectKey: automationSubjectKeyV1({ kind: 'machine', serverId,
                machineId: subjectMachineId }) } : {}) } });
        return automation.id;
    };
    const any = await add(owner.id);
    const exact = await add(owner.id, machine.id);
    await add(owner.id, randomUUID());
    const sharedExact = await add(shared.id, machine.id);
    await add(denied.id, machine.id);
    const transition = (active: boolean, occurredAt: number) => inTx(tx => retainMachinePresenceTransitionInTx(tx,
        { machineId: machine.id, active, occurredAt, recipientAccountIds: [owner.id, shared.id] }));
    const candidates = async (accountId: string, machineId = machine.id) => {
        const row = await db.accountChange.findFirst({ where: { accountId, kind: 'machine', entityId: machineId } });
        return row?.hint;
    };
    await transition(true, Date.now());
    expect((await candidates(owner.id)) ?? {}).not.toHaveProperty('machinePresence');
    expect((await candidates(shared.id)) ?? {}).not.toHaveProperty('machinePresence');
    expect(await inTx(tx => readMachinePresenceForAccountInTx(tx, { actorAccountId: owner.id, machineId: machine.id })))
        .toMatchObject({ kind: 'present', transitions: null, occurrences: [] });
    expect(await db.automationRun.count()).toBe(0);
    const occurredAt = Date.now();
    await transition(false, occurredAt);
    const selectors = async (...automationIds: string[]) => (await db.automationTrigger.findMany({
        where: { automationId: { in: automationIds } }, select: { id: true, automationId: true, revision: true, sourceSelectorId: true }, orderBy: { id: 'asc' },
    })).map(row => ({ automationId: row.automationId, triggerId: row.id, triggerRevision: row.revision, sourceSelectorId: row.sourceSelectorId }));
    expect(await candidates(owner.id)).toMatchObject({ machinePresence: { v: 1, serverId, machineId: machine.id,
        transition: 'offline', revision: 1, occurredAt, definitions: await selectors(any, exact) } });
    expect(await candidates(shared.id)).toMatchObject({ machinePresence: { definitions: await selectors(sharedExact) } });
    expect(await candidates(denied.id)).toBeUndefined();
    expect(await db.automationRun.count()).toBe(0);
    const replay = await inTx(tx => readMachinePresenceForAccountInTx(tx, { actorAccountId: owner.id, machineId: machine.id }));
    expect(replay).toMatchObject({ kind: 'present', occurrences: [{ transition: 'offline', occurredAt,
        definitions: await selectors(any, exact) }] });
    expect(await inTx(tx => readMachinePresenceForAccountInTx(tx, { actorAccountId: denied.id, machineId: machine.id })))
        .toEqual({ kind: 'refused', code: 'machine_unavailable' });
    const online = await add(owner.id, machine.id, 'machine-online');
    await recordMachineAlive({ accountId: owner.id, machineId: machine.id, timestamp: Date.now() }, async tx => ({
        recipientAccountIds: [owner.id], wasOffline: true, lastActiveAt: new Date(0),
        accountChanges: [await markAccountChanged(tx, { accountId: owner.id, kind: 'machine', entityId: machine.id })],
    }));
    // A semantic writer having published the Machine must not remove that
    // recipient from the presence occurrence's authoritative audience.
    expect(await candidates(owner.id)).toMatchObject({ machinePresence: { transition: 'online', revision: 2,
        definitions: await selectors(online) } });
    const uninterested = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const unobservedMachine = await db.machine.create({ data: { id: randomUUID(), accountId: uninterested.id, metadata: '{}' } });
    await inTx(tx => retainMachinePresenceTransitionInTx(tx, { machineId: unobservedMachine.id,
        active: false, occurredAt: Date.now(), recipientAccountIds: [uninterested.id] }));
    // Ordinary presence publication remains available without automation demand.
    expect(await db.accountChange.count({ where: { accountId: uninterested.id, kind: 'machine', entityId: unobservedMachine.id } })).toBe(1);
    expect((await candidates(uninterested.id, unobservedMachine.id)) ?? {}).not.toHaveProperty('machinePresence');
    expect(await db.automationRun.count()).toBe(0);
});
