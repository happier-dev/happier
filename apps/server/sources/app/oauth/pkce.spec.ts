import { describe, expect, it } from "vitest";

describe("pkce", () => {
    it("generates a verifier with allowed characters and minimum length", async () => {
        const { generatePkceVerifier } = await import("./pkce");

        const verifier = generatePkceVerifier();
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
    });

    it("computes S256 challenges per RFC 7636 example", async () => {
        const { pkceChallengeS256 } = await import("./pkce");

        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        expect(pkceChallengeS256(verifier)).toBe(expected);
    });
});
