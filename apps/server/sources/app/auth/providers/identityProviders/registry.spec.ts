import { describe, expect, it, vi } from "vitest";

const resolveProviderModules = vi.fn();

vi.mock("@/app/auth/providers/providerModules", () => ({
    resolveProviderModules: (...args: any[]) => resolveProviderModules(...args),
}));

describe("identityProviders registry", () => {
    it("matches provider IDs case-insensitively", async () => {
        resolveProviderModules.mockReturnValueOnce([
            {
                id: "github",
                identity: {
                    id: "GitHub",
                    connect: async () => {},
                    disconnect: async () => {},
                },
            },
        ]);

        const { findIdentityProviderById } = await import("./registry");
        const provider = findIdentityProviderById(process.env, "github");
        expect(provider?.id).toBe("GitHub");
    });
});
