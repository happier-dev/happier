import { z } from "zod";
import * as privacyKit from "privacy-kit";

import {
    AccountSettingsStoredContentEnvelopeSchema,
    type AccountSettingsStoredContentEnvelope,
} from "@happier-dev/protocol";
import { decryptString, encryptString } from "@/modules/encrypt";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

const DbPlainSettingsWrapperSchema = z.discriminatedUnion("t", [
    z.object({ t: z.literal("plain"), v: z.unknown() }).strict(),
    z.object({ t: z.literal("sealed_v1"), c: z.string().min(1) }).strict(),
]);

export function openPlainAccountSettingsDbValue(params: {
    accountId: string;
    dbValue: string | null;
}): AccountSettingsStoredContentEnvelope | null {
    const { accountId, dbValue } = params;
    if (!dbValue) return null;

    let raw: unknown;
    try {
        raw = JSON.parse(dbValue);
    } catch {
        // Legacy fallback: if plaintext mode was enabled without migration, the DB may still contain ciphertext.
        return null;
    }

    const wrapper = DbPlainSettingsWrapperSchema.safeParse(raw);
    if (wrapper.success) {
        if (wrapper.data.t === "plain") {
            const envelope = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: "plain", v: wrapper.data.v });
            return envelope.success ? envelope.data : null;
        }

        // sealed_v1
        try {
            const bytes = privacyKit.decodeBase64(wrapper.data.c);
            const opened = decryptString(["storage", "account_settings", accountId, "v1"], bytes);
            const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse(JSON.parse(opened));
            if (parsed.success && parsed.data.t === "plain") return parsed.data;
            return null;
        } catch {
            return null;
        }
    }

    // If the DB stored a plain envelope directly, accept it.
    const envelope = AccountSettingsStoredContentEnvelopeSchema.safeParse(raw);
    if (envelope.success && envelope.data.t === "plain") return envelope.data;

    // If the DB stored raw settings JSON, wrap it.
    const wrapped = AccountSettingsStoredContentEnvelopeSchema.safeParse({ t: "plain", v: raw });
    return wrapped.success ? wrapped.data : null;
}

export function storePlainAccountSettingsDbValue(params: {
    accountId: string;
    content: AccountSettingsStoredContentEnvelope | null;
}): string | null {
    const { accountId, content } = params;
    if (!content) return null;
    if (content.t !== "plain") return null;

    const env = readEncryptionFeatureEnv(process.env);
    const atRest = env.plainAccountSettingsAtRest;
    const plaintext = JSON.stringify(content);

    if (atRest === "none") {
        return plaintext;
    }

    const sealed = privacyKit.encodeBase64(
        encryptString(["storage", "account_settings", accountId, "v1"], plaintext),
    );
    return JSON.stringify({ t: "sealed_v1", c: sealed });
}

