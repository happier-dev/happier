import { describe, expect, it } from "vitest";

import {
    VoiceProviderConversationIdentityCollisionError,
    assertVoiceProviderConversationIdentityExactMatch,
    deriveVoiceProviderConversationKey,
} from "./voiceProviderConversationIdentity";
import {
    voiceProviderConversationIdSchema,
    voiceSessionCorrelationIdSchema,
} from "./voiceSessionLifecycleSchemas";

describe("voice provider conversation identity", () => {
    it("derives the documented domain-separated byte-exact SHA-256 key", () => {
        expect(deriveVoiceProviderConversationKey({
            providerId: "elevenlabs_agents",
            providerConversationId: "conv_123",
        })).toBe("1d2a26a3611be882c1cd1eabffc9755e33b531fdb13ffc4c7386b947489b60a4");
        expect(deriveVoiceProviderConversationKey({ providerId: "a", providerConversationId: "bc" }))
            .not.toBe(deriveVoiceProviderConversationKey({ providerId: "ab", providerConversationId: "c" }));
        expect(deriveVoiceProviderConversationKey({ providerId: "é", providerConversationId: "会話" }))
            .toBe("c758784fc0e71a10f989200847c9155f7b9c6c9cdcf98fa7fa7d0d6167f2341f");
    });

    it("fails closed when a digest-key hit has a different exact raw identity", () => {
        const expected = {
            providerId: "elevenlabs_agents",
            providerConversationId: "conv_expected",
            providerConversationKey: "a".repeat(64),
        };
        expect(() => assertVoiceProviderConversationIdentityExactMatch({
            expected,
            stored: {
                ...expected,
                providerConversationId: "conv_collision",
            },
        })).toThrow(VoiceProviderConversationIdentityCollisionError);
    });

    it("keeps provider conversation ids within the portable persistence limit without narrowing session correlation ids", () => {
        const providerConversationId = ` ${"🙂".repeat(189)} `;
        const sessionCorrelationId = `  ${"🙂".repeat(508)}  `;

        expect([...providerConversationId]).toHaveLength(191);
        expect(voiceProviderConversationIdSchema.parse(providerConversationId)).toBe(providerConversationId);
        expect(voiceProviderConversationIdSchema.safeParse("🙂".repeat(192)).success).toBe(false);

        expect([...sessionCorrelationId]).toHaveLength(512);
        expect(voiceSessionCorrelationIdSchema.parse(sessionCorrelationId)).toBe(sessionCorrelationId);
        expect(voiceSessionCorrelationIdSchema.safeParse("🙂".repeat(513)).success).toBe(false);
        expect(voiceProviderConversationIdSchema.safeParse("   ").success).toBe(false);
        expect(voiceSessionCorrelationIdSchema.safeParse("   ").success).toBe(false);
    });
});
