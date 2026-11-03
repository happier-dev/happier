import { describe, expect, it } from "vitest";
import { validateMachineReplacement, validateMachineReplacementTarget } from "./validateMachineReplacement";

describe("validateMachineReplacement Machine kind eligibility", () => {
    it.each(["oldMachine", "replacementMachine"] as const)("rejects an ephemeral %s", (ephemeralSide) => {
        const oldMachine = { id: "old", accountId: "owner", active: false, revokedAt: null, kind: "persistent" as const };
        const replacementMachine = { ...oldMachine, id: "new" };
        expect(validateMachineReplacement({
            accountId: "owner", oldMachine, replacementMachine, replacementMachineId: "new", source: "manual",
            [ephemeralSide]: { ...(ephemeralSide === "oldMachine" ? oldMachine : replacementMachine), kind: "ephemeral_session_runner" },
        })).toMatchObject({ ok: false, statusCode: 400 });
    });

    it("keeps legacy persistent projections eligible", () => {
        const oldMachine = { id: "old", accountId: "owner", active: false, revokedAt: null };
        expect(validateMachineReplacement({
            accountId: "owner", oldMachine, replacementMachine: { ...oldMachine, id: "new" },
            replacementMachineId: "new", source: "manual",
        })).toEqual({ ok: true });
    });
});

describe("validateMachineReplacementTarget Account-owned installation changes", () => {
    const oldMachine = { id: "old", accountId: "owner", active: false, revokedAt: null,
        installationId: "old-installation", installationPublicKey: new Uint8Array([1]), contentPublicKeyFingerprint: "account-key" };
    const replacementMachine = { ...oldMachine, id: "new", installationId: "fresh-installation", installationPublicKey: new Uint8Array([2]) };

    it("accepts a fresh installation for same-Account automatic replacement", () => {
        expect(validateMachineReplacementTarget({ oldMachine, replacementMachine }))
            .toEqual({ ok: true });
    });

    it("accepts a changed installation key for same-Account automatic replacement", () => {
        expect(validateMachineReplacementTarget({ oldMachine,
            replacementMachine: { ...replacementMachine, installationId: oldMachine.installationId } }))
            .toEqual({ ok: true });
    });

    it("refuses another Account even with the same installation", () => {
        expect(validateMachineReplacement({ accountId: oldMachine.accountId, oldMachine,
            replacementMachine: { ...oldMachine, id: "new", accountId: "other" },
            replacementMachineId: "new", source: "automatic" }))
            .toMatchObject({ ok: false, reason: "replacement_machine_not_found" });
    });

    it.each([
        { replacement: { revokedAt: new Date(1) }, reason: "replacement_machine_revoked" },
        { replacement: { replacedByMachineId: "another" }, reason: "replacement_machine_already_replaced" },
        { replacement: { contentPublicKeyFingerprint: "another-account-key" }, reason: "content_public_key_fingerprint_mismatch" },
    ])("rejects $reason after an installation change", ({ replacement, reason }) => {
        expect(validateMachineReplacementTarget({ oldMachine, replacementMachine: { ...replacementMachine, ...replacement } }))
            .toMatchObject({ ok: false, reason });
    });
});
