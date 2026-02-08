import { db } from "@/storage/db";
import { parseIntEnv } from "@/config/env";

export function accountDisabledKey(accountId: string): string {
    const id = accountId.toString().trim();
    return `auth_disabled_${id}`;
}

function resolveAccountDisabledTtlSecondsFromEnv(env: NodeJS.ProcessEnv): number {
    // Default: 10 years, configurable.
    return parseIntEnv(env.AUTH_ACCOUNT_DISABLED_TTL_SECONDS, 315_360_000, { min: 3_600, max: 3_153_600_000 });
}

export async function disableAccount(params: { accountId: string; reason: string; env: NodeJS.ProcessEnv }): Promise<void> {
    const key = accountDisabledKey(params.accountId);
    if (!key || key === "auth_disabled_") return;

    const ttlSeconds = resolveAccountDisabledTtlSecondsFromEnv(params.env);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await db.repeatKey.upsert({
        where: { key },
        update: { value: params.reason, expiresAt },
        create: { key, value: params.reason, expiresAt },
    });
}

export async function isAccountDisabled(params: { accountId: string }): Promise<boolean> {
    const key = accountDisabledKey(params.accountId);
    if (!key || key === "auth_disabled_") return false;

    const row = await db.repeatKey.findUnique({
        where: { key },
        select: { expiresAt: true },
    });
    if (!row) return false;
    return row.expiresAt.getTime() > Date.now();
}

