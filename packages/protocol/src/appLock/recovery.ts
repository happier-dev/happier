import { z } from 'zod';

/**
 * Wire contract for app-lock email recovery.
 *
 * A device that turns on its local app lock escrows a random recovery key with the relay server,
 * tied to a recovery email address. When the owner forgets the password, the device asks the server
 * to email a one-time code and trades that code for the recovery key. The server never sees the
 * password or the device's credentials: the recovery key only unwraps the device-local data key.
 *
 * The relay sends those emails through the account's own SMTP server, which the owner enters in the
 * app (Settings > App lock). The SMTP password is stored encrypted and never returned.
 */
export const APP_LOCK_RECOVERY_ROUTES = Object.freeze({
    /** Authenticated: store or replace the escrow for a lock id. Requires the account's mail settings. */
    register: '/v1/app-lock/recovery',
    /** Authenticated: forget the escrow when the device turns its lock off. */
    remove: '/v1/app-lock/recovery/remove',
    /** Public: email a reset code to the verified address of a lock id. */
    requestResetCode: '/v1/app-lock/recovery/reset-code',
    /** Public: trade a valid reset code for the escrowed recovery key. */
    redeemResetCode: '/v1/app-lock/recovery/redeem',
    /** Authenticated: GET the account's mail settings (without the password) or PUT new ones. */
    mailSettings: '/v1/app-lock/mail-settings',
    /** Authenticated: send a test email with the saved mail settings. */
    mailSettingsTest: '/v1/app-lock/mail-settings/test',
});

/** Six-digit one-time code sent by email. */
export const APP_LOCK_RECOVERY_CODE_LENGTH = 6;

export const AppLockIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
/** Base64 encoding of 32 random bytes. */
export const AppLockRecoveryKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
export const AppLockRecoveryCodeSchema = z.string().regex(new RegExp(`^\\d{${APP_LOCK_RECOVERY_CODE_LENGTH}}$`));
export const AppLockRecoveryEmailSchema = z.string().trim().max(191).email(); // 191 = MySQL VARCHAR default used by the server schema.

export const AppLockRecoveryRegisterRequestSchema = z.object({
    lockId: AppLockIdSchema,
    email: AppLockRecoveryEmailSchema,
    recoveryKey: AppLockRecoveryKeySchema,
});
export type AppLockRecoveryRegisterRequest = z.infer<typeof AppLockRecoveryRegisterRequestSchema>;

export const AppLockRecoveryCodeRequestSchema = z.object({
    lockId: AppLockIdSchema,
    code: AppLockRecoveryCodeSchema,
});
export type AppLockRecoveryCodeRequest = z.infer<typeof AppLockRecoveryCodeRequestSchema>;

export const AppLockRecoveryLockRequestSchema = z.object({
    lockId: AppLockIdSchema,
});
export type AppLockRecoveryLockRequest = z.infer<typeof AppLockRecoveryLockRequestSchema>;

export const AppLockRecoveryOkResponseSchema = z.object({ ok: z.literal(true) });

export const AppLockRecoveryRedeemResponseSchema = z.object({
    recoveryKey: AppLockRecoveryKeySchema,
});
export type AppLockRecoveryRedeemResponse = z.infer<typeof AppLockRecoveryRedeemResponseSchema>;

export const AppLockMailSecuritySchema = z.enum(['tls', 'starttls', 'none']);
export type AppLockMailSecurity = z.infer<typeof AppLockMailSecuritySchema>;

export const AppLockMailSettingsInputSchema = z.object({
    /** Account-wide recovery recipient shared by every device lock. */
    recoveryEmail: AppLockRecoveryEmailSchema.optional(),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    /** `tls`: TLS from the start (usually port 465). `starttls`: upgrade after connecting (usually 587). */
    security: AppLockMailSecuritySchema,
    /** Empty when the SMTP server needs no login. */
    username: z.string().trim().max(254),
    /** Omit to keep the saved password. */
    password: z.string().max(1024).optional(),
    fromAddress: z.string().trim().min(3).max(320),
});
export type AppLockMailSettingsInput = z.infer<typeof AppLockMailSettingsInputSchema>;

export const AppLockMailSettingsSchema = z.object({
    /** The one account-wide recipient used for every device's reset code and test email. */
    recoveryEmail: AppLockRecoveryEmailSchema.nullable(),
    host: z.string(),
    port: z.number().int(),
    security: AppLockMailSecuritySchema,
    username: z.string(),
    fromAddress: z.string(),
    hasPassword: z.boolean(),
});
export type AppLockMailSettings = z.infer<typeof AppLockMailSettingsSchema>;

export const AppLockMailSettingsResponseSchema = z.object({
    settings: AppLockMailSettingsSchema.nullable(),
});
export type AppLockMailSettingsResponse = z.infer<typeof AppLockMailSettingsResponseSchema>;

export const APP_LOCK_RECOVERY_ERROR_CODES = [
    'mail_not_configured',
    'invalid_code',
    'code_expired',
    'too_many_attempts',
    'cooldown',
    'not_found',
    'email_failed',
] as const;
export type AppLockRecoveryErrorCode = (typeof APP_LOCK_RECOVERY_ERROR_CODES)[number];

export const AppLockRecoveryErrorResponseSchema = z.object({
    error: z.enum(APP_LOCK_RECOVERY_ERROR_CODES),
    /** Seconds until another code may be requested, for `cooldown`. */
    retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type AppLockRecoveryErrorResponse = z.infer<typeof AppLockRecoveryErrorResponseSchema>;
