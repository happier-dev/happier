import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { APP_LOCK_RECOVERY_CODE_LENGTH, type AppLockRecoveryErrorCode } from "@happier-dev/protocol";
import { sendMail, type SmtpSettings } from "@/modules/mail/sendMail";
import { log } from "@/utils/logging/log";

/**
 * One-time email codes for app-lock recovery.
 *
 * Bounds protect the six-digit code against guessing: a code lives for 15 minutes, allows five
 * wrong attempts, and a new code can be sent at most once a minute per lock id. The public routes
 * are additionally rate limited per IP.
 */
export const APP_LOCK_CODE_TTL_MS = 15 * 60 * 1000;
export const APP_LOCK_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const APP_LOCK_CODE_MAX_ATTEMPTS = 5;

export type AppLockCodePurpose = "reset";

export interface AppLockCodeState {
    readonly id: string;
    readonly codeHash: string | null;
    readonly codePurpose: string | null;
    readonly codeExpiresAt: Date | null;
    readonly codeSentAt: Date | null;
    readonly codeAttempts: number;
}

export type AppLockResult<T> =
    | ({ readonly ok: true } & T)
    | { readonly ok: false; readonly error: AppLockRecoveryErrorCode; readonly retryAfterSeconds?: number };

export function hashAppLockCode(lockId: string, code: string): string {
    return createHash("sha256").update(`${lockId}:${code}`).digest("hex");
}

export function generateAppLockCode(): string {
    return String(randomInt(0, 10 ** APP_LOCK_RECOVERY_CODE_LENGTH)).padStart(APP_LOCK_RECOVERY_CODE_LENGTH, "0");
}

/** Seconds left before another code may be sent, or 0 when sending is allowed. */
export function appLockCodeCooldownSeconds(state: Pick<AppLockCodeState, "codeSentAt">, now: Date): number {
    if (!state.codeSentAt) return 0;
    const remainingMs = state.codeSentAt.getTime() + APP_LOCK_CODE_RESEND_COOLDOWN_MS - now.getTime();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export function buildIssuedAppLockCode(lockId: string, purpose: AppLockCodePurpose, now: Date) {
    const code = generateAppLockCode();
    return {
        code,
        data: {
            codeHash: hashAppLockCode(lockId, code),
            codePurpose: purpose,
            codeExpiresAt: new Date(now.getTime() + APP_LOCK_CODE_TTL_MS),
            codeSentAt: now,
            codeAttempts: 0,
        },
    };
}

export const CLEARED_APP_LOCK_CODE = Object.freeze({
    codeHash: null,
    codePurpose: null,
    codeExpiresAt: null,
    codeAttempts: 0,
});

/**
 * Decides whether `code` matches the active code for `purpose`. Does not mutate state; callers
 * record failed attempts atomically so parallel guesses cannot exceed the attempt budget.
 */
export function checkAppLockCode(
    state: AppLockCodeState,
    purpose: AppLockCodePurpose,
    code: string,
    now: Date,
): "ok" | Extract<AppLockRecoveryErrorCode, "invalid_code" | "code_expired" | "too_many_attempts"> {
    if (!state.codeHash || state.codePurpose !== purpose || !state.codeExpiresAt) return "invalid_code";
    if (state.codeAttempts >= APP_LOCK_CODE_MAX_ATTEMPTS) return "too_many_attempts";
    if (state.codeExpiresAt.getTime() <= now.getTime()) return "code_expired";
    const expected = Buffer.from(state.codeHash, "hex");
    const actual = Buffer.from(hashAppLockCode(state.id, code), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? "ok" : "invalid_code";
}

/**
 * Sends an email through the account's SMTP server. Returns false (and logs without the address,
 * code or credentials) when sending fails.
 */
export async function sendAppLockEmail(
    settings: SmtpSettings,
    message: Readonly<{ to: string; subject: string; text: string }>,
    kind: string,
): Promise<boolean> {
    try {
        await sendMail(settings, message);
        return true;
    } catch (error) {
        log({ module: "app-lock", level: "error" }, `Failed to send app lock ${kind} email: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

export async function emailAppLockResetCode(settings: SmtpSettings, to: string, code: string): Promise<boolean> {
    return await sendAppLockEmail(settings, {
        to,
        subject: "Reset your Happier app lock password",
        text: `Someone asked to reset the Happier app lock password on one of your devices. Use this code to set a new password:\n\n${code}\n\nThe code expires in ${APP_LOCK_CODE_TTL_MS / 60000} minutes. If you did not ask for this, you can ignore this email.\n`,
    }, "reset");
}
