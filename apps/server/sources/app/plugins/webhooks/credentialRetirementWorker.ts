import { log } from "@/utils/logging/log";
import {
    cleanupExpiredAccountEncryptionTransitions,
} from "@/app/encryption/accountEncryptionTransitionCoordinator";

import {
    ageOverduePluginWebhookDeliveriesV1,
    recoverExpiredPluginWebhookClaimsV1,
} from "./claimStore";
import { retireExpiredPluginWebhookCredentialsV1 } from "./credentialStore";
import { purgeExpiredPluginWebhookDeliveriesV1 } from "./retention";

const DEFAULT_PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_INTERVAL_MS_V1 = 60_000;
const PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1 = 500;

export function startPluginWebhookCredentialRetirementWorker(params: Readonly<{
    intervalMs?: number;
}> = {}): Readonly<{ stop: () => void }> | null {
    const intervalMs = params.intervalMs ?? DEFAULT_PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_INTERVAL_MS_V1;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new TypeError("Plugin webhook credential retirement interval must be a positive safe integer");
    }

    let stopped = false;
    let running = false;
    const run = async () => {
        if (stopped || running) return;
        running = true;
        try {
            await Promise.all([
                recoverExpiredPluginWebhookClaimsV1({
                    batchSize: PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1,
                }),
                ageOverduePluginWebhookDeliveriesV1({
                    batchSize: PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1,
                }),
                retireExpiredPluginWebhookCredentialsV1({
                    batchSize: PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1,
                }),
                purgeExpiredPluginWebhookDeliveriesV1({
                    batchSize: PLUGIN_WEBHOOK_CREDENTIAL_RETIREMENT_BATCH_SIZE_V1,
                }),
                // This is the incumbent unconditional worker lifecycle: on
                // restart and each pass it resumes one Account-owned bounded
                // transition scrub without inventing a second timer/owner.
                cleanupExpiredAccountEncryptionTransitions(),
            ]);
        } catch {
            // The pass handles only ciphertext metadata and never decrypts secrets. Keep the
            // diagnostic bounded so a future database error cannot copy query parameters.
            log(
                {
                    module: "plugin.webhooks.credentialRetirement",
                    level: "warn",
                    errorCode: "credential_retirement_pass_failed",
                },
                "Plugin webhook credential retirement pass failed",
            );
        } finally {
            running = false;
        }
    };

    // `acceptUntil` remains the durable authority. This timer merely prompts replicas to
    // perform the idempotent CAS cleanup; restart cannot re-enable an expired credential.
    void run();
    const timer = setInterval(() => {
        void run();
    }, intervalMs);
    timer.unref?.();

    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}
