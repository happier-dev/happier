import { db } from "@/storage/db";
import { getDbProviderFromEnv } from "@/config/databaseProvider";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

const MIN_LOCK_TTL_MS = 30_000;

export interface GlobalLockLease {
    readonly renew: (params: Readonly<{ ttlMs: number; now?: Date }>) => Promise<boolean>;
    readonly release: () => Promise<void>;
}

export async function acquireGlobalLock(params: Readonly<{
    key: string;
    ttlMs: number;
    now?: Date;
}>): Promise<GlobalLockLease | null> {
    const now = params.now ?? new Date();
    const ttlMs = Math.max(MIN_LOCK_TTL_MS, params.ttlMs);
    const expiresAt = new Date(now.getTime() + ttlMs);
    const value = randomKeyNaked(16);

    // Losing admission is normal across replicas; it must not raise a unique
    // violation for every pass while another worker owns the lease.
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const inserted = provider === "mysql"
        ? (await db.globalLock.createMany({
            data: { key: params.key, value, expiresAt },
            skipDuplicates: true,
        })).count
        : await db.$executeRaw`
            INSERT INTO "GlobalLock" ("key", "value", "expiresAt", "createdAt", "updatedAt")
            VALUES (${params.key}, ${value}, ${provider === "sqlite" ? expiresAt.getTime() : expiresAt},
                ${provider === "sqlite" ? Date.now() : new Date()}, ${provider === "sqlite" ? Date.now() : new Date()})
            ON CONFLICT ("key") DO NOTHING
        `;
    if (inserted === 0) {
        const updated = await db.globalLock.updateMany({
            where: {
                key: params.key,
                expiresAt: { lt: now },
            },
            data: {
                value,
                expiresAt,
            },
        });
        if (updated.count !== 1) return null;

        const current = await db.globalLock.findUnique({
            where: { key: params.key },
            select: { value: true },
        });
        if (!current || current.value !== value) return null;
    }

    return {
        renew: async (renewParams) => {
            const renewNow = renewParams.now ?? new Date();
            const renewTtlMs = Math.max(MIN_LOCK_TTL_MS, renewParams.ttlMs);
            const updated = await db.globalLock.updateMany({
                where: {
                    key: params.key,
                    value,
                },
                data: {
                    expiresAt: new Date(renewNow.getTime() + renewTtlMs),
                },
            });
            return updated.count === 1;
        },
        release: async () => {
            await db.globalLock.deleteMany({
                where: {
                    key: params.key,
                    value,
                },
            }).catch(() => {});
        },
    };
}
