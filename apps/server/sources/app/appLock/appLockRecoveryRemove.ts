import { db } from "@/storage/db";
import type { AppLockRecoveryLockRequest } from "@happier-dev/protocol";

/**
 * Forgets the caller's escrow for a lock id (the device turned its lock off or replaced the
 * escrow). Idempotent: removing an unknown lock id succeeds.
 */
export async function appLockRecoveryRemove(
    ctx: { readonly uid: string },
    input: AppLockRecoveryLockRequest,
): Promise<void> {
    await db.appLockRecovery.deleteMany({ where: { id: input.lockId, accountId: ctx.uid } });
}
