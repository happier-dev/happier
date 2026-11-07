import { db } from "@/storage/db";
import type { AppLockRecoveryErrorCode } from "@happier-dev/protocol";
import {
    APP_LOCK_CODE_MAX_ATTEMPTS,
    CLEARED_APP_LOCK_CODE,
    checkAppLockCode,
    type AppLockCodePurpose,
    type AppLockCodeState,
} from "./appLockRecoveryCode";

/**
 * Spends one attempt on the active code and reports whether `code` matched it.
 *
 * Wrong attempts are reserved with a conditional increment, so parallel guesses can never exceed
 * the attempt budget. A matching code is cleared conditionally in one update (single use);
 * `onMatch` data is written in that same update without clearing a newer replacement code.
 */
export async function appLockRecoveryConsumeCode(
    record: AppLockCodeState,
    purpose: AppLockCodePurpose,
    code: string,
    now: Date,
    onMatch: Readonly<Record<string, unknown>> = {},
): Promise<"ok" | Extract<AppLockRecoveryErrorCode, "invalid_code" | "code_expired" | "too_many_attempts">> {
    const precheck = checkAppLockCode(record, purpose, code, now);
    if (precheck === "code_expired" || precheck === "too_many_attempts") return precheck;
    if (!record.codeHash || record.codePurpose !== purpose) return "invalid_code";

    const currentCode = {
        id: record.id,
        codeHash: record.codeHash,
        codePurpose: purpose,
        codeExpiresAt: { gt: now },
        codeAttempts: { lt: APP_LOCK_CODE_MAX_ATTEMPTS },
    };
    if (precheck === "ok") {
        const consumed = await db.appLockRecovery.updateMany({
            where: currentCode,
            data: { ...CLEARED_APP_LOCK_CODE, ...onMatch },
        });
        return consumed.count === 1 ? "ok" : "invalid_code";
    }

    const reserved = await db.appLockRecovery.updateMany({
        where: currentCode,
        data: { codeAttempts: { increment: 1 } },
    });
    if (reserved.count === 0) return "too_many_attempts";
    return "invalid_code";
}
