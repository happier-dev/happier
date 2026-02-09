import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
}

export async function pruneExpiredVoiceSessionLeasesOnce(params: { cutoff: Date }): Promise<{ deleted: number }> {
    const deleted = await db.voiceSessionLease.deleteMany({
        where: {
            expiresAt: { lt: params.cutoff },
        },
    });
    return { deleted: deleted.count };
}

export function startVoiceSessionLeaseCleanupFromEnv(): { stop: () => void } | null {
    const enabled =
        process.env.VOICE_LEASE_CLEANUP === "1" ||
        process.env.VOICE_LEASE_CLEANUP === "true";
    if (!enabled) return null;

    const retentionDaysRaw = (process.env.VOICE_LEASE_RETENTION_DAYS ?? "").toString().trim();
    const retentionDaysParsed = retentionDaysRaw ? Number(retentionDaysRaw) : NaN;
    const retentionDays = clampInt(retentionDaysParsed, 7, 365);

    const intervalMsRaw = (process.env.VOICE_LEASE_CLEANUP_INTERVAL_MS ?? "").toString().trim();
    const intervalMsParsed = intervalMsRaw ? Number(intervalMsRaw) : NaN;
    const intervalMs = Number.isFinite(intervalMsParsed) && intervalMsParsed >= 10_000
        ? Math.floor(intervalMsParsed)
        : 6 * 60 * 60 * 1000;

    let stopped = false;

    const run = async (reason: "startup" | "interval") => {
        try {
            const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
            const result = await pruneExpiredVoiceSessionLeasesOnce({ cutoff });
            log(
                { module: "voice-lease-cleanup", reason, deleted: result.deleted, retentionDays },
                `VoiceSessionLease cleanup ran (${reason})`,
            );
        } catch (error) {
            log(
                { module: "voice-lease-cleanup", reason, error: error instanceof Error ? error.message : String(error) },
                `VoiceSessionLease cleanup failed (${reason})`,
            );
        }
    };

    void run("startup");
    const timer = setInterval(() => {
        if (stopped) return;
        void run("interval");
    }, intervalMs);
    timer.unref?.();

    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}

