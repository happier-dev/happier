import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importSubject() {
    vi.resetModules();
    return await import("./rpcMethodAvailability");
}

describe("resolveRpcMethodAvailabilityGraceMs", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("uses a longer startup grace for direct and external daemon RPC registration", async () => {
        vi.stubEnv("HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS", "750");
        vi.stubEnv("HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS", "");
        vi.stubEnv("HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS", "");

        const { resolveRpcMethodAvailabilityGraceMs } = await importSubject();

        expect(
            resolveRpcMethodAvailabilityGraceMs(`machine-1:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`),
        ).toBe(15_000);
        expect(
            resolveRpcMethodAvailabilityGraceMs(`machine-1:${RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY}`),
        ).toBe(15_000);
        expect(resolveRpcMethodAvailabilityGraceMs(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(15_000);
        expect(resolveRpcMethodAvailabilityGraceMs(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY)).toBe(15_000);
        expect(resolveRpcMethodAvailabilityGraceMs(`machine-1:${RPC_METHODS.STOP_SESSION}`)).toBe(10_000);
        expect(resolveRpcMethodAvailabilityGraceMs("sess_1:execution.run.stream.start")).toBe(750);
    });

    it("allows the machine Stop registration grace to be tuned independently", async () => {
        vi.stubEnv("HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS", "750");
        vi.stubEnv("HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS", "1500");

        const { resolveRpcMethodAvailabilityGraceMs } = await importSubject();

        expect(resolveRpcMethodAvailabilityGraceMs(`machine-1:${RPC_METHODS.STOP_SESSION}`)).toBe(1_500);
        expect(resolveRpcMethodAvailabilityGraceMs("sess_1:execution.run.stream.start")).toBe(750);
    });

    it("uses the effective startup overlay loaded after import", async () => {
        const subject = await importSubject();
        const { loadStartupHomeEnv } = await import('@/app/home/settings/startupHomeEnv');
        await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {
            HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 900,
            HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 50,
            HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 2000,
            HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 12_000,
            HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 20_000,
        }, secrets: {} }), log: () => {} });
        expect(subject.resolveRpcMethodAvailabilityGraceMs('session-one:unrelated')).toBe(900);
        expect(subject.resolveRpcMethodAvailabilityPollMs()).toBe(50);
        expect(subject.resolveRpcClusterFetchTimeoutMs('session-one:unrelated')).toBe(2000);
        expect(subject.resolveRpcMethodAvailabilityGraceMs(`machine-one:${RPC_METHODS.STOP_SESSION}`)).toBe(12_000);
        expect(subject.resolveRpcMethodAvailabilityGraceMs(`machine-one:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`)).toBe(20_000);
    });
});
