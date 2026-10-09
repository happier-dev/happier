import type { MachineAccessRoleV1 } from "@happier-dev/protocol";

import { readMachineAccessKeySessionBindingsInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { dispatchMachineAccessLossCustody } from "./machineAccessCustody";
import {
    resolveCurrentMachineRecipientAccountIdsInTx,
    resolveEffectiveMachineAccessForMachinesInTx,
} from "./machineAccess";

const captured = Symbol("Machine access impact");

/** Transaction-local structural before-state, never persisted or supplied by a caller over transport. */
export interface MachineAccessImpact {
    readonly [captured]: Readonly<{
        tx: Tx;
        accountId: string;
        machines: ReadonlyMap<string, MachineAccessRoleV1 | null>;
    }>;
}

export async function captureMachineAccessImpactsInTx(
    tx: Tx,
    input: Readonly<{ machineIds: readonly string[]; accountIds: readonly string[] }>,
): Promise<ReadonlyMap<string, MachineAccessImpact>> {
    const accountIds = [...new Set(input.accountIds)];
    const machineIds = [...new Set(input.machineIds)];
    const access = accountIds.length === 0 || machineIds.length === 0
        ? new Map<string, Map<string, MachineAccessRoleV1 | null>>()
        : await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds, accountIds });
    return new Map(accountIds.map(accountId => [accountId, {
        [captured]: { tx, accountId, machines: new Map(machineIds.map(machineId => [machineId, access.get(machineId)?.get(accountId) ?? null])) },
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
        directGrantChangedAccountId?: string;
        grantRosterChanged?: boolean;
    }>,
): Promise<Readonly<{ changedAccountIds: readonly string[]; revokedAccountIds: readonly string[] }>> {
    const beforeByMachine = new Map<string, Map<string, MachineAccessRoleV1 | null>>();
    for (const wrapper of input.impacts) {
        const impact = wrapper[captured];
        if (impact.tx !== tx) throw new Error("Machine access impact must be applied in its capture transaction");
        for (const [machineId, beforeRole] of impact.machines) {
            const before = beforeByMachine.get(machineId) ?? new Map<string, MachineAccessRoleV1 | null>();
            before.set(impact.accountId, beforeRole);
            beforeByMachine.set(machineId, before);
        }
    }
    if (beforeByMachine.size === 0) return { changedAccountIds: [], revokedAccountIds: [] };

    const accountIds = [...new Set([...beforeByMachine.values()].flatMap(before => [...before.keys()]))];
    const after = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [...beforeByMachine.keys()], accountIds });
    const changedAccountIds = new Set<string>();
    const revokedAccountIds = new Set<string>();
    for (const [machineId, before] of beforeByMachine) {
        const changed = new Set<string>();
        const revoked = new Set<string>();
        for (const [accountId, beforeRole] of before) {
            const afterRole = after.get(machineId)?.get(accountId) ?? null;
            if (beforeRole === afterRole && accountId !== input.directGrantChangedAccountId) continue;
            changed.add(accountId);
            changedAccountIds.add(accountId);
            if (beforeRole !== null && afterRole === null) {
                revoked.add(accountId);
                revokedAccountIds.add(accountId);
            }
        }
        if (changed.size === 0 && !input.grantRosterChanged) continue;

        // Current Manage holders consume the same changed-Machine projection to
        // refresh sharing and current recipient work; this creates no key queue.
        const recipientIds = await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId);
        const current = await resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [machineId], accountIds: recipientIds });
        for (const accountId of recipientIds) if (current.get(machineId)?.get(accountId) === "manage") changed.add(accountId);
        for (const accountId of changed) await markAccountChanged(tx, { accountId, kind: "machine", entityId: machineId });

        if (revoked.size === 0) continue;
        const machine = await tx.machine.findUnique({ where: { id: machineId }, select: { accountId: true, installationId: true } });
        if (!machine) continue;
        const sessionBindings = await readMachineAccessKeySessionBindingsInTx(tx, { accountId: machine.accountId, machineId });
        for (const accountId of revoked) {
            const actorBindings = sessionBindings.filter(binding => binding.accountId === accountId);
            afterTx(tx, () => {
                eventRouter.disconnectMachineAndSessionSockets({ accountId, machineId, sessionBindings: actorBindings });
                if (!machine.installationId) {
                    log({ module: "machine-access", level: "warn", machineId }, "Requester Session access-loss cleanup remains incomplete: installation unavailable");
                    return;
                }
                void dispatchMachineAccessLossCustody({ machineId, subjectAccountId: accountId,
                    expectedCustodianAccountId: machine.accountId, expectedInstallationId: machine.installationId,
                }).then(outcome => {
                    log({ module: "machine-access", level: outcome.kind === "settled" ? "info" : "warn", machineId },
                        `Requester Session access-loss cleanup ${outcome.kind}`);
                }).catch(() => {
                    log({ module: "machine-access", level: "warn", machineId }, "Requester Session access-loss cleanup remains incomplete");
                });
            });
        }
    }
    return { changedAccountIds: [...changedAccountIds], revokedAccountIds: [...revokedAccountIds] };
}
