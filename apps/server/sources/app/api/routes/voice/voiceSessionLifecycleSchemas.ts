import { z } from "zod";

export const voiceSessionLeaseIdSchema = z.string().trim().min(1).max(256);

function isUnicodeScalarString(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            index += 1;
            continue;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
    }
    return true;
}

function opaqueVoiceIdentifierSchema(maxUnicodeScalars: number) {
    return z.string()
        .refine(isUnicodeScalarString, "Identifier must contain valid Unicode")
        .refine((value) => value.trim().length > 0, "Identifier must not be blank")
        .refine(
            (value) => [...value].length <= maxUnicodeScalars,
            `Identifier must contain at most ${maxUnicodeScalars} Unicode characters`,
        );
}

// `providerConversationId` is written verbatim to the portable MySQL
// `VARCHAR(191)` identity columns. Keep its public boundary within that
// storage contract rather than accepting a value that later fails durably.
export const voiceProviderConversationIdSchema = opaqueVoiceIdentifierSchema(191);
export const voiceSessionCorrelationIdSchema = opaqueVoiceIdentifierSchema(512);

export const voiceSessionLifecycleBodySchema = z.object({
    leaseId: voiceSessionLeaseIdSchema,
    providerConversationId: voiceProviderConversationIdSchema,
});

export type VoiceSessionLifecycleBody = z.infer<typeof voiceSessionLifecycleBodySchema>;

export const voiceSessionReleaseBodySchema = z.object({
    leaseId: voiceSessionLeaseIdSchema,
});

export type VoiceSessionReleaseBody = z.infer<typeof voiceSessionReleaseBodySchema>;
