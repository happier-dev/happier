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

function opaqueVoiceIdentifierSchema() {
    return z.string()
        .refine(isUnicodeScalarString, "Identifier must contain valid Unicode")
        .refine((value) => value.trim().length > 0, "Identifier must not be blank")
        .refine((value) => [...value].length <= 512, "Identifier must contain at most 512 Unicode characters");
}

export const voiceProviderConversationIdSchema = opaqueVoiceIdentifierSchema();
export const voiceSessionCorrelationIdSchema = opaqueVoiceIdentifierSchema();

export const voiceSessionLifecycleBodySchema = z.object({
    leaseId: voiceSessionLeaseIdSchema,
    providerConversationId: voiceProviderConversationIdSchema,
});

export type VoiceSessionLifecycleBody = z.infer<typeof voiceSessionLifecycleBodySchema>;
