import { readHomeEffectiveEnv } from "@/app/features/catalog/serverFeatureGate";
import { afterTx, type Tx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";

import { createPolarClient, readPolarConfig } from "./polarClient";

export function countActiveTeamSeats(dbReader: Pick<Tx, "teamMembership">, teamId: string): Promise<number> {
    return dbReader.teamMembership.count({ where: { teamId, status: "active" } });
}

// A directory pass may affect many memberships in one transaction. One callback per Team
// reads the final committed count, and a rollback discards the callback with that transaction.
const pendingSeatSync = new WeakMap<Tx, Set<string>>();

export function scheduleTeamSeatSyncInTx(tx: Tx, teamId: string): void {
    if (!readPolarConfig(process.env)) return;
    let teams = pendingSeatSync.get(tx);
    if (!teams) pendingSeatSync.set(tx, teams = new Set());
    if (teams.has(teamId)) return;
    teams.add(teamId);
    afterTx(tx, () => {
        void (async () => {
            const env = await readHomeEffectiveEnv();
            const config = readPolarConfig(env);
            if (!config) return;
            const { reconcileTeamBilling } = await import("./reconcileTeamBilling");
            await reconcileTeamBilling(teamId, { env, polar: createPolarClient(config), membershipChanged: true });
        })().catch((error: unknown) => {
            log({ module: "billing", level: "warn", teamId }, "Polar Team seat sync deferred", error instanceof Error ? error.name : "Error");
        });
    });
}
