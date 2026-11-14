import { cleanupExpiredAccountEncryptionTransitions } from '@/app/encryption/accountEncryptionTransitionCoordinator';
import {
    ageOverduePluginWebhookDeliveriesV1,
    recoverExpiredPluginWebhookClaimsV1,
} from '@/app/plugins/webhooks/claimStore';
import { retireExpiredPluginWebhookCredentialsV1 } from '@/app/plugins/webhooks/credentialStore';
import { purgeExpiredPluginWebhookDeliveriesV1 } from '@/app/plugins/webhooks/retention';
import type { RetentionRule, RetentionRuleResult } from '@/app/retention/runtime/retentionRuleRegistry';
import { log } from '@/utils/logging/log';

/** The webhook stores accept at most this many rows per pass. */
const MAX_WEBHOOK_BATCH_SIZE = 500;

function webhookBatchSize(batchSize: number): number {
    return Math.max(1, Math.min(batchSize, MAX_WEBHOOK_BATCH_SIZE));
}

function intrinsicRule(
    id: string,
    pass: (batchSize: number) => Promise<Readonly<{ changed: number; full: boolean }>>,
): RetentionRule {
    return {
        id,
        run: async ({ batchSize }): Promise<RetentionRuleResult> => {
            try {
                const result = await pass(webhookBatchSize(batchSize));
                return { id, deleted: result.changed, hasMore: result.full };
            } catch {
                // These passes touch ciphertext metadata only. Keep the diagnostic to the
                // pass id so a database error cannot copy query parameters into logs, and
                // let the sweep's other rules run; the next sweep retries.
                log(
                    { module: 'retention', level: 'warn', errorCode: 'intrinsic_expiry_pass_failed', rule: id },
                    'Intrinsic expiry pass failed',
                );
                return { id, deleted: 0, hasMore: false };
            }
        },
    };
}

/**
 * Expiry that each record carries itself (lease, acceptance window, payload/metadata
 * deadlines, transition expiry). No operator policy, switch or dry run governs it, so
 * it runs on every hourly sweep. Every deadline stays authoritative where it is read
 * (claim selection, credential verification, status reads, transition admission);
 * these passes only persist what those readers already treat as expired.
 */
export function createIntrinsicExpiryRetentionRules(): readonly RetentionRule[] {
    return [
        intrinsicRule('pluginWebhookClaimRecovery', async (batchSize) => {
            const result = await recoverExpiredPluginWebhookClaimsV1({ batchSize });
            const changed = result.requeued + result.deadLettered;
            return { changed, full: changed >= batchSize };
        }),
        intrinsicRule('pluginWebhookDeliveryAging', async (batchSize) => {
            const result = await ageOverduePluginWebhookDeliveriesV1({ batchSize });
            return { changed: result.deadLettered, full: result.deadLettered >= batchSize };
        }),
        intrinsicRule('pluginWebhookCredentialRetirement', async (batchSize) => {
            const result = await retireExpiredPluginWebhookCredentialsV1({ batchSize });
            return { changed: result.retired, full: result.retired >= batchSize };
        }),
        intrinsicRule('pluginWebhookDeliveryPurge', async (batchSize) => {
            const result = await purgeExpiredPluginWebhookDeliveriesV1({ batchSize });
            const changed = result.payloadsPurged + result.metadataDeleted + result.tombstonesDeleted;
            return { changed, full: changed >= batchSize };
        }),
        intrinsicRule('accountEncryptionTransitionExpiry', async () => {
            // One bounded chunk of the earliest expired transition per call; the sweep
            // calls again while a chunk made progress.
            const result = await cleanupExpiredAccountEncryptionTransitions();
            const changed = result.expiredTransitionCount + result.removedStageCount;
            return { changed, full: changed > 0 };
        }),
    ];
}
