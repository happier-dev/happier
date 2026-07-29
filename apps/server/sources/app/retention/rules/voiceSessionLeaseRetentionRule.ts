import { resolveEffectiveRetentionDomains } from "@/app/retention/config/retentionPolicyState";
import { pruneExpiredVoiceSessionLeases } from "@/app/voice/pruneExpiredVoiceSessionLeases";
import type { RetentionRule } from "@/app/retention/runtime/retentionRuleRegistry";

export function createVoiceSessionLeaseRetentionRule(): RetentionRule {
    return {
        id: "voiceSessionLeases",
        run: async ({ policy, batchSize, dryRun, maxDeletesPerRulePerRun, now }) => {
            const domainPolicy = resolveEffectiveRetentionDomains(policy).voiceSessionLeases;
            if (domainPolicy.mode === "keep_forever") {
                return { id: "voiceSessionLeases", deleted: 0 };
            }

            const cutoff = new Date(now.getTime() - domainPolicy.days * 24 * 60 * 60 * 1000);
            const limit = Math.max(1, Math.min(batchSize, maxDeletesPerRulePerRun));
            const deleted = await pruneExpiredVoiceSessionLeases({
                cutoff,
                limit,
                dryRun,
            });
            return { id: "voiceSessionLeases", deleted };
        },
    };
}
