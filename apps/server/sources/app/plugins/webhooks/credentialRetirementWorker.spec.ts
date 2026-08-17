import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    enabled: vi.fn(),
    recover: vi.fn(),
    ageOverdue: vi.fn(),
    retire: vi.fn(),
    purge: vi.fn(),
    cleanupTransitions: vi.fn(),
    log: vi.fn(),
}));

vi.mock("@/app/features/catalog/serverFeatureGate", () => ({
    isServerFeatureEnabledForRequest: mocks.enabled,
}));
vi.mock("./credentialStore", () => ({
    retireExpiredPluginWebhookCredentialsV1: mocks.retire,
}));
vi.mock("./claimStore", () => ({
    recoverExpiredPluginWebhookClaimsV1: mocks.recover,
    ageOverduePluginWebhookDeliveriesV1: mocks.ageOverdue,
}));
vi.mock("./retention", () => ({
    purgeExpiredPluginWebhookDeliveriesV1: mocks.purge,
}));
vi.mock("@/app/encryption/accountEncryptionTransitionCoordinator", () => ({
    cleanupExpiredAccountEncryptionTransitions: mocks.cleanupTransitions,
}));
vi.mock("@/utils/logging/log", () => ({
    log: mocks.log,
}));

import { startPluginWebhookCredentialRetirementWorker } from "./credentialRetirementWorker";

describe("plugin webhook credential retirement worker", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.enabled.mockReturnValue(true);
        mocks.recover.mockResolvedValue({ requeued: 0, deadLettered: 0 });
        mocks.ageOverdue.mockResolvedValue({ markedOffline: 0, deadLettered: 0 });
        mocks.retire.mockResolvedValue({ retired: 0 });
        mocks.purge.mockResolvedValue({ payloadsPurged: 0, metadataDeleted: 0 });
        mocks.cleanupTransitions.mockResolvedValue({
            expiredTransitionCount: 0,
            removedStageCount: 0,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("continues cleanup when ingress is disabled so retained ciphertext still expires", async () => {
        mocks.enabled.mockReturnValue(false);

        const worker = startPluginWebhookCredentialRetirementWorker({
            intervalMs: 1_000,
        });
        expect(worker).not.toBeNull();
        await vi.advanceTimersByTimeAsync(0);

        expect(mocks.enabled).not.toHaveBeenCalled();
        expect(mocks.retire).toHaveBeenCalledTimes(1);
        expect(mocks.recover).toHaveBeenCalledTimes(1);
        expect(mocks.ageOverdue).toHaveBeenCalledTimes(1);
        expect(mocks.purge).toHaveBeenCalledTimes(1);
        worker!.stop();
    });

    it("runs on startup and on the bounded interval, then stops without owning durability", async () => {
        const worker = startPluginWebhookCredentialRetirementWorker({
            intervalMs: 1_000,
        });
        expect(worker).not.toBeNull();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.retire).toHaveBeenCalledTimes(1);
        expect(mocks.retire).toHaveBeenLastCalledWith({ batchSize: 500 });
        expect(mocks.recover).toHaveBeenLastCalledWith({ batchSize: 500 });
        expect(mocks.ageOverdue).toHaveBeenLastCalledWith({ batchSize: 500 });
        expect(mocks.purge).toHaveBeenLastCalledWith({ batchSize: 500 });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(mocks.retire).toHaveBeenCalledTimes(2);
        expect(mocks.recover).toHaveBeenCalledTimes(2);
        expect(mocks.ageOverdue).toHaveBeenCalledTimes(2);
        expect(mocks.purge).toHaveBeenCalledTimes(2);

        worker!.stop();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mocks.retire).toHaveBeenCalledTimes(2);
        expect(mocks.recover).toHaveBeenCalledTimes(2);
        expect(mocks.ageOverdue).toHaveBeenCalledTimes(2);
        expect(mocks.purge).toHaveBeenCalledTimes(2);
    });

    it("resumes bounded Account transition stage scrubbing on startup and each interval", async () => {
        const worker = startPluginWebhookCredentialRetirementWorker({
            intervalMs: 1_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.cleanupTransitions).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(mocks.cleanupTransitions).toHaveBeenCalledTimes(2);

        worker!.stop();
    });

    it("contains a failed pass and retries later without logging credential material", async () => {
        mocks.retire
            .mockRejectedValueOnce(new Error("database unavailable"))
            .mockResolvedValueOnce({ retired: 1 });

        const worker = startPluginWebhookCredentialRetirementWorker({
            intervalMs: 1_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.log).toHaveBeenCalledWith(
            expect.objectContaining({
                module: "plugin.webhooks.credentialRetirement",
                level: "warn",
                errorCode: "credential_retirement_pass_failed",
            }),
            "Plugin webhook credential retirement pass failed",
        );

        await vi.advanceTimersByTimeAsync(1_000);
        expect(mocks.retire).toHaveBeenCalledTimes(2);
        worker!.stop();
    });
});
