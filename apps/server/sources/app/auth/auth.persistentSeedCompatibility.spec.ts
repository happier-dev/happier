import { afterEach, describe, expect, it, vi } from "vitest";

import { restoreEnv, snapshotEnv } from "@/app/api/testkit/env";

describe("auth (persistent seed compatibility)", () => {
    const envBackup = snapshotEnv();

    afterEach(() => {
        restoreEnv(envBackup);
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it("retries persistent token init when runtime key import rejects the seed", async () => {
        process.env.HANDY_MASTER_SECRET = "fallback-seed";

        let generatorCalls = 0;
        const mockGenerator = {
            publicKey: new Uint8Array([1, 2, 3]),
            new: vi.fn(async () => "token-1"),
        };
        const mockVerifier = {
            verify: vi.fn(async () => ({ user: "user-1", extras: { role: "admin" } })),
        };

        vi.doMock("privacy-kit", async (importOriginal) => {
            const actual = await importOriginal<typeof import("privacy-kit")>();
            return {
                ...actual,
                createPersistentTokenGenerator: vi.fn(async () => {
                    generatorCalls += 1;
                    if (generatorCalls === 1) {
                        throw new DOMException(
                            "Data provided to an operation does not meet requirements",
                            "DataError",
                        );
                    }
                    return mockGenerator;
                }),
                createPersistentTokenVerifier: vi.fn(async () => mockVerifier),
            };
        });

        const { auth } = await import("./auth");
        await expect(auth.init()).resolves.toBeUndefined();
        expect(generatorCalls).toBeGreaterThan(1);

        const token = await auth.createToken("user-1", { role: "admin" });
        expect(token).toBe("token-1");
        await expect(auth.verifyToken(token)).resolves.toEqual({
            userId: "user-1",
            extras: { role: "admin" },
        });
    });
});
