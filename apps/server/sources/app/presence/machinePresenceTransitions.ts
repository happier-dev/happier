import { MachinePresenceTransitionsV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { readAccessibleMachineAccessInTx } from '@/app/machines/machineAccess';
import { getDbProviderFromEnv, resolveDbSqlDialect } from '@/config/databaseProvider';
import type { Tx } from '@/storage/inTx';
import { invalidateManagedWakeControllerInTx } from '@/app/machines/managed/managedWakeAvailability';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import type { MachinePresenceAutomationOccurrenceV1 } from '@happier-dev/protocol/machines/machinePresenceTransitionsV1';
import { AutomationEventAdmitDefinitionSelectorV1Schema } from '@happier-dev/protocol/automations/automationEventAdmissionSelectorV1';

async function readPresenceCandidatesInTx(tx: Tx, input: Readonly<{
    serverId: string; machineId: string; transition: 'online' | 'offline'; recipientAccountIds: readonly string[];
}>) {
    const candidates = await tx.automationTrigger.findMany({ where: {
        kind: 'pluginEvent', enabled: true, deletedAt: null,
        eventPluginId: 'happier.machine.services', eventLocalId: `machine-${input.transition}`,
        automation: { enabled: true, deletedAt: null, accountId: { in: [...input.recipientAccountIds] } },
        OR: [{ subjectKind: null, subjectKey: null }, { subjectKind: 'machine',
            subjectKey: automationSubjectKeyV1({ kind: 'machine', serverId: input.serverId, machineId: input.machineId }) }],
    }, select: { id: true, automationId: true, revision: true, sourceSelectorId: true,
        automation: { select: { accountId: true } } }, orderBy: { id: 'asc' } });
    const byAccount = new Map<string, MachinePresenceAutomationOccurrenceV1['definitions']>();
    for (const candidate of candidates) {
        const accountId = candidate.automation.accountId;
        if (!candidate.sourceSelectorId) continue;
        const selector = AutomationEventAdmitDefinitionSelectorV1Schema.parse({ automationId: candidate.automationId,
            triggerId: candidate.id, triggerRevision: candidate.revision, sourceSelectorId: candidate.sourceSelectorId });
        const definitions = byAccount.get(accountId);
        if (definitions) definitions.push(selector);
        else byAccount.set(accountId, [selector]);
    }
    return byAccount;
}

export async function readMachinePresenceForAccountInTx(tx: Tx, input: Readonly<{ actorAccountId: string; machineId: string }>) {
    const access = await readAccessibleMachineAccessInTx(tx, input);
    if (!access) return { kind: 'refused' as const, code: 'machine_unavailable' as const };
    const transitions = await readMachinePresenceTransitionsInTx(tx, input.machineId);
    const serverId = await readCurrentServerIdentityId(process.env, tx);
    const occurrences: MachinePresenceAutomationOccurrenceV1[] = [];
    if (transitions && serverId) for (const transition of ['offline', 'online'] as const) {
        const fact = transitions[transition];
        if (!fact) continue;
        const candidates = await readPresenceCandidatesInTx(tx, { serverId, machineId: input.machineId, transition,
            recipientAccountIds: [input.actorAccountId] });
        const definitions = candidates.get(input.actorAccountId) ?? [];
        if (definitions.length) occurrences.push({ v: 1, serverId, machineId: input.machineId, transition, ...fact, definitions });
    }
    return { kind: 'present' as const, machineId: input.machineId, transitions, occurrences };
}

/** The containing presence transaction already locks and decides this Machine. */
export async function readMachinePresenceTransitionsInTx(tx: Pick<Tx, '$queryRaw'>, machineId: string) {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const rows = dialect === 'mysql'
        ? await tx.$queryRaw<Array<{ presenceTransitions: string | null }>>`SELECT \`presenceTransitions\` FROM \`Machine\` WHERE \`id\` = ${machineId}`
        : await tx.$queryRaw<Array<{ presenceTransitions: string | null }>>`SELECT "presenceTransitions" FROM "Machine" WHERE "id" = ${machineId}`;
    const stored = rows[0]?.presenceTransitions;
    return stored == null ? null : MachinePresenceTransitionsV1Schema.parse(JSON.parse(stored));
}

/** Retain only decided changes, with identity independent of heartbeat clocks.
 * Initial enrollment changes inventory without inventing an outage occurrence. */
export async function retainMachinePresenceTransitionInTx(tx: Tx, input: Readonly<{
    machineId: string; active: boolean; occurredAt: number; recipientAccountIds: readonly string[];
}>): Promise<void> {
    const previous = await readMachinePresenceTransitionsInTx(tx, input.machineId);
    // Publication is queued until the containing transaction finishes domain
    // writes, including the first inactive→active inventory change.
    await invalidateManagedWakeControllerInTx(tx, input.machineId);
    if (input.active && previous === null) {
        for (const accountId of input.recipientAccountIds) await markAccountChanged(tx, { accountId, kind: 'machine', entityId: input.machineId });
        return;
    }
    const revision = (previous?.revision ?? 0) + 1;
    const occurrence = { revision, occurredAt: input.occurredAt };
    const transitions = MachinePresenceTransitionsV1Schema.parse({ v: 1, revision,
        offline: input.active ? previous?.offline ?? null : occurrence,
        online: input.active ? occurrence : previous?.online ?? null });
    const stored = JSON.stringify(transitions);
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    // Like the owning presence write, this must leave content clocks untouched.
    if (dialect === 'mysql') await tx.$executeRaw`UPDATE \`Machine\` SET \`presenceTransitions\` = ${stored} WHERE \`id\` = ${input.machineId}`;
    else await tx.$executeRaw`UPDATE "Machine" SET "presenceTransitions" = ${stored} WHERE "id" = ${input.machineId}`;
    const serverId = await readCurrentServerIdentityId(process.env, tx);
    const transition = input.active ? 'online' : 'offline';
    const byAccount = serverId === null ? new Map<string, MachinePresenceAutomationOccurrenceV1['definitions']>() : await readPresenceCandidatesInTx(tx,
        { serverId, machineId: input.machineId, transition, recipientAccountIds: input.recipientAccountIds });
    for (const accountId of input.recipientAccountIds) {
        const definitions = byAccount.get(accountId) ?? [];
        await markAccountChanged(tx, { accountId, kind: 'machine', entityId: input.machineId,
            ...(definitions.length ? { hint: { machinePresence: { v: 1, serverId, machineId: input.machineId,
                transition, revision, occurredAt: input.occurredAt, definitions } } } : {}) });
    }
}
