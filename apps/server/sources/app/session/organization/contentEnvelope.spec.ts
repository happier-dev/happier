import { describe, expect, it, vi } from "vitest";

import type { SessionOrganizationTx } from "./types";
import {
    areSessionOrganizationDisplayEnvelopesAllowedForAccount,
    parseSessionOrganizationDisplayEnvelope,
    serializeSessionOrganizationDisplayEnvelope,
} from "./contentEnvelope";

function createTx(account: unknown): SessionOrganizationTx {
    return {
        account: {
            findUnique: vi.fn(async () => account),
        },
    } as unknown as SessionOrganizationTx;
}

describe("Session Organization content envelope", () => {
    it("rejects encrypted display content for a plain Account", async () => {
        const allowed =
            await areSessionOrganizationDisplayEnvelopesAllowedForAccount({
                tx: createTx({
                    publicKey: null,
                    encryptionMode: "plain",
                    contentPublicKey: null,
                    contentPublicKeySig: null,
                }),
                accountId: "account-1",
                displays: [{
                    t: "encrypted",
                    c: "ciphertext",
                }],
            });

        expect(allowed).toBe(false);
    });

    it("rejects display content when E2EE Account binding is unavailable", async () => {
        const allowed =
            await areSessionOrganizationDisplayEnvelopesAllowedForAccount({
                tx: createTx({
                    publicKey: null,
                    encryptionMode: "e2ee",
                    contentPublicKey: null,
                    contentPublicKeySig: null,
                }),
                accountId: "account-1",
                displays: [{
                    t: "encrypted",
                    c: "ciphertext",
                }],
            });

        expect(allowed).toBe(false);
    });

    it.each([
        "{",
        JSON.stringify({ t: "future", value: "unreadable" }),
        JSON.stringify({ t: "plain" }),
    ])("preserves malformed stored display as typed unreadable state", (value) => {
        expect(parseSessionOrganizationDisplayEnvelope(value)).toEqual({
            status: "unreadable",
            reason: "invalid_stored_display",
        });
    });

    it("preserves an absent display as a ready null value", () => {
        expect(parseSessionOrganizationDisplayEnvelope(null)).toEqual({
            status: "ready",
            display: null,
        });
    });

    it("rejects an omitted plain display value before persistence", () => {
        expect(() => serializeSessionOrganizationDisplayEnvelope(
            { t: "plain" } as never,
        )).toThrow();
    });
});
