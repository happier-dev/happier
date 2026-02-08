import { db } from "@/storage/db";

export function oauthStateAttemptKey(sid: string): string {
    const normalized = sid.toString().trim();
    return `oauth_state_${normalized}`;
}

export async function deleteOAuthStateAttemptBestEffort(sid: string): Promise<void> {
    const key = oauthStateAttemptKey(sid);
    if (!key || key === "oauth_state_") return;
    await db.repeatKey.delete({ where: { key } }).catch(() => {});
}

export async function loadValidOAuthStateAttempt(sid: string): Promise<{ key: string; value: string } | null> {
    const key = oauthStateAttemptKey(sid);
    if (!key || key === "oauth_state_") return null;

    const row = await db.repeatKey.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
        await deleteOAuthStateAttemptBestEffort(sid);
        return null;
    }

    return { key: row.key, value: row.value };
}

