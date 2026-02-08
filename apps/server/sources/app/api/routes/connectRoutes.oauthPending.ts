import { db } from "@/storage/db";

function isSafeOAuthPendingKey(key: string): boolean {
    const pendingKey = key.toString().trim();
    if (!pendingKey) return false;
    // Bound key shape to avoid accidental deletes/reads of unrelated repeatKey entries.
    // Pending keys are generated server-side as `oauth_pending_${randomKeyNaked(24)}`.
    return /^oauth_pending_[A-Za-z0-9]{8,128}$/.test(pendingKey);
}

export async function deleteOAuthPendingBestEffort(key: string): Promise<void> {
    const pendingKey = key.toString().trim();
    if (!isSafeOAuthPendingKey(pendingKey)) return;
    await db.repeatKey.delete({ where: { key: pendingKey } }).catch(() => {});
}

export async function loadValidOAuthPending(key: string): Promise<{ key: string; value: string } | null> {
    const pendingKey = key.toString().trim();
    if (!isSafeOAuthPendingKey(pendingKey)) return null;

    const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
    if (!pending) return null;
    if (pending.expiresAt.getTime() <= Date.now()) {
        await deleteOAuthPendingBestEffort(pendingKey);
        return null;
    }

    return { key: pending.key, value: pending.value };
}
