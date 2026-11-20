import { isDeepStrictEqual } from 'node:util';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1 } from '@happier-dev/protocol/changes';

import { acquireAccountChangePublicationLocksInTx, markAccountsChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { dispatchMachineAccessLossCustody } from "./machineAccessCustody";
import { contributions, expandMachineIdsWithManagedGuestsInTx, projectMachineRoles, readMachineRoleGraphForMachinesInTx } from './machineRole';
import { readMachineAudienceAccountIdsForMachinesInTx } from './machineRecipientWork';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import {
    resolveEffectiveMachineAccessForMachinesInTx,
} from "./machineAccess";

const captured = Symbol("Machine access impact");

/** Account erasure follows retained grants, including grants authored on foreign Machines. */
export async function readMachineAccessGrantsForAccountErasureInTx(tx: Tx, accountId: string): Promise<string[]> {
    const [owned, received, authored] = await Promise.all([
        tx.machine.findMany({ where: { accountId }, select: { id: true } }),
        tx.machineGrant.findMany({ where: { accountId }, select: { machineId: true } }),
        tx.machineGrant.findMany({ where: { createdByAccountId: accountId }, select: { machineId: true } }),
    ]);
    return [...new Set([...owned.map(machine => machine.id), ...received.map(grant => grant.machineId),
        ...authored.map(grant => grant.machineId)])];
}

interface MachineAccessProjection {
    readonly role: MachineAccessRoleV1 | null;
    readonly sources: ReadonlySet<PrincipalRefV1>;
}

async function readMachineAccessProjectionsInTx(tx: Tx, machineIds: readonly string[], accountIds: readonly string[]): Promise<Map<string, Map<string, MachineAccessProjection>>> {
    const graph = await readMachineRoleGraphForMachinesInTx(tx, machineIds, accountIds);
    const sources = new Map([...graph].map(([id, row]) => [id, contributions(row)]));
    const roles = projectMachineRoles(graph, accountIds, sources);
    return new Map(machineIds.map(machineId => [machineId, new Map(accountIds.map(accountId => [accountId, {
        role: roles.get(machineId)?.get(accountId) ?? null,
        sources: new Set((sources.get(machineId) ?? []).filter(source => source.accountIds.includes(accountId)).map(source => source.principal)),
    }]))]));
}

/** Transaction-local structural before-state, never persisted or supplied by a caller over transport. */
export interface MachineAccessImpact {
    readonly [captured]: Readonly<{
        tx: Tx;
        accountId: string;
        machines: ReadonlyMap<string, MachineAccessProjection>;
    }>;
}

async function readMachineManageRecipientsInTx(tx: Tx, machineIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    const audiences = await readMachineAudienceAccountIdsForMachinesInTx(tx, machineIds);
    const accountIds = [...new Set([...audiences.values()].flat())];
    const current = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds, accountIds });
    return new Map([...audiences].map(([id, recipients]) => [id, recipients.filter(accountId => current.get(id)?.get(accountId) === 'manage')]));
}

/** Pure complete publication/lifecycle census before an enclosing membership mutation. */
export async function readMachineAccessImpactPublicationAudienceInTx(
    tx: Tx, input: Readonly<{ machineIds: readonly string[]; accountIds: readonly string[] }>,
): Promise<readonly string[]> {
    const machineIds = await expandMachineIdsWithManagedGuestsInTx(tx, input.machineIds);
    const accountIds = new Set(input.accountIds);
    for (const ids of portableQueryChunks({ values: machineIds, bindingsPerValue: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] } }, select: { accountId: true } });
        for (const machine of machines) accountIds.add(machine.accountId);
    }
    for (const recipients of (await readMachineManageRecipientsInTx(tx, machineIds)).values()) {
        for (const accountId of recipients) accountIds.add(accountId);
    }
    return [...accountIds].sort();
}

export async function captureMachineAccessImpactsInTx(
    tx: Tx,
    input: Readonly<{ machineIds: readonly string[]; accountIds: readonly string[] }>,
): Promise<ReadonlyMap<string, MachineAccessImpact>> {
    const accountIds = [...new Set(input.accountIds)];
    await acquireAccountChangePublicationLocksInTx(tx, accountIds, { includeSingleAccount: true });
    const machineIds = await expandMachineIdsWithManagedGuestsInTx(tx, input.machineIds);
    const access = accountIds.length === 0 || machineIds.length === 0
        ? new Map<string, Map<string, MachineAccessProjection>>()
        : await readMachineAccessProjectionsInTx(tx, machineIds, accountIds);
    return new Map(accountIds.map(accountId => [accountId, {
        [captured]: { tx, accountId, machines: new Map(machineIds.map(machineId => [machineId, access.get(machineId)!.get(accountId)!])) },
    }]));
}

/**
 * One grant/membership transition producer. The canonical Machine access owner
 * supplies both unions; only their final difference can revoke sockets. Session
 * history and AccessKey material remain intact. Socket eviction is an access
 * consequence, not a claim that a runtime or process has settled.
 */
export async function applyMachineAccessImpactsInTx(
    tx: Tx,
    input: Readonly<{
        impacts: Iterable<MachineAccessImpact>;
        grantRosterChanged?: boolean;
    }>,
): Promise<Readonly<{ changedAccountIds: readonly string[]; revokedAccountIds: readonly string[] }>> {
    const beforeByMachine = new Map<string, Map<string, MachineAccessProjection>>();
    for (const wrapper of input.impacts) {
        const impact = wrapper[captured];
        if (impact.tx !== tx) throw new Error("Machine access impact must be applied in its capture transaction");
        for (const [machineId, beforeAccess] of impact.machines) {
            const before = beforeByMachine.get(machineId) ?? new Map<string, MachineAccessProjection>();
            before.set(impact.accountId, beforeAccess);
            beforeByMachine.set(machineId, before);
        }
    }
    if (beforeByMachine.size === 0) return { changedAccountIds: [], revokedAccountIds: [] };

    const accountIds = [...new Set([...beforeByMachine.values()].flatMap(before => [...before.keys()]))];
    const after = await readMachineAccessProjectionsInTx(tx, [...beforeByMachine.keys()], accountIds);
    const managers = await readMachineManageRecipientsInTx(tx, [...beforeByMachine.keys()]);
    const changedAccountIds = new Set<string>();
    const revokedAccountIds = new Set<string>();
    const publications: Array<{ machineId: string; changed: Set<string>; revoked: Set<string>; manageLost: Set<string> }> = [];
    for (const [machineId, before] of beforeByMachine) {
        const changed = new Set<string>();
        const revoked = new Set<string>();
        const manageLost = new Set<string>();
        for (const [accountId, beforeAccess] of before) {
            const afterAccess = after.get(machineId)!.get(accountId)!;
            const beforeRole = beforeAccess.role;
            const afterRole = afterAccess.role;
            if (beforeRole === afterRole && isDeepStrictEqual(beforeAccess.sources, afterAccess.sources)) continue;
            changed.add(accountId);
            changedAccountIds.add(accountId);
            if (beforeRole !== null && afterRole === null) {
                revoked.add(accountId);
                revokedAccountIds.add(accountId);
            }
            if (beforeRole === 'manage' && afterRole === 'use') manageLost.add(accountId);
        }
        if (changed.size === 0 && !input.grantRosterChanged) continue;

        // Current Manage holders consume the same changed-Machine projection to
        // refresh sharing and current recipient work; this creates no key queue.
        for (const accountId of managers.get(machineId) ?? []) changed.add(accountId);
        publications.push({ machineId, changed, revoked, manageLost });
    }

    await acquireAccountChangePublicationLocksInTx(tx, publications.flatMap(publication => [...publication.changed]));
    const lostAccessMachineIds = publications.filter(({ revoked, manageLost }) => revoked.size > 0 || manageLost.size > 0)
        .map(({ machineId }) => machineId);
    const custodyByMachineId = new Map<string, { accountId: string; installationId: string | null }>();
    for (const ids of portableQueryChunks({ values: lostAccessMachineIds, bindingsPerValue: 1, fixedBindings: 1 })) {
        const machines = await tx.machine.findMany({ where: { id: { in: [...ids] } },
            select: { id: true, accountId: true, installationId: true } });
        for (const machine of machines) custodyByMachineId.set(machine.id, machine);
    }
    for (const { machineId, changed, revoked, manageLost } of publications) {
        await markAccountsChanged(tx, { accountIds: [...changed], kind: MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1, entityId: machineId });

        const machine = custodyByMachineId.get(machineId);
        if (!machine) continue;
        for (const accountId of new Set([...revoked, ...manageLost])) {
            afterTx(tx, () => {
                // Retire open Machine access, but retain the admitted Session
                // publisher until its work ends. New Send/reconnect admits anew.
                if (revoked.has(accountId)) eventRouter.disconnectMachineAndSessionSockets({ accountId, machineId, sessionBindings: [] });
                if (!machine.installationId) {
                    log({ module: "machine-access", level: "warn", machineId, subjectAccountId: accountId,
                        reason: "installation_unavailable" }, "Requester Session access-loss cleanup remains incomplete: installation unavailable");
                    return;
                }
                void dispatchMachineAccessLossCustody({ machineId, subjectAccountId: accountId,
                    expectedCustodianAccountId: machine.accountId, expectedInstallationId: machine.installationId,
                }).then(outcome => {
                    log({ module: "machine-access", level: outcome.kind === "settled" ? "info" : "warn", machineId,
                        subjectAccountId: accountId, ...(outcome.kind === "incomplete" ? { reason: outcome.reason } : {}) },
                        `Requester Session access-loss cleanup ${outcome.kind}`);
                }).catch(() => {
                    log({ module: "machine-access", level: "warn", machineId, subjectAccountId: accountId,
                        reason: "custody_unavailable" }, "Requester Session access-loss cleanup remains incomplete");
                });
            });
        }
    }
    return { changedAccountIds: [...changedAccountIds], revokedAccountIds: [...revokedAccountIds] };
}
