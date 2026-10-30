import { describe, expect, it } from "vitest";

import {
    createDisabledAuthEmailDelivery,
    createSmtpAuthEmailDelivery,
    type AuthEmailSmtpConfig,
    type AuthEmailSmtpEnvelope,
} from "./authEmailAdapters";
import { describeAuthEmailDeliveryFailure } from "./authEmailDelivery";
import type { AuthEmailMessage } from "./authEmailDelivery";

const config: AuthEmailSmtpConfig = {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    username: "mailer",
    password: "secret-password",
    fromAddress: "no-reply@happier.dev",
    fromName: "Happier",
};

const reset: AuthEmailMessage = {
    kind: "plain_password_reset",
    to: { address: "Alice@Example.com", normalizedEmail: "alice@example.com" },
    resetUrl: "https://app.happier.dev/auth/password/reset/BBBB",
    expiresAt: new Date("2026-09-05T01:00:00.000Z"),
};

function createRecordingTransport(behavior?: () => Promise<void>) {
    const sent: AuthEmailSmtpEnvelope[] = [];
    return {
        sent,
        transport: {
            async send(envelope: AuthEmailSmtpEnvelope) {
                sent.push(envelope);
                if (behavior) await behavior();
            },
        },
    };
}

describe("auth email adapters", () => {
    it("reports an unconfigured deployment honestly instead of faking success", async () => {
        const result = await createDisabledAuthEmailDelivery().deliver(reset);

        expect(result).toEqual({
            status: "failed",
            reason: "not_configured",
            detail: "no auth email transport is configured",
        });
    });

    it("submits one rendered multipart envelope to the configured transport", async () => {
        const { sent, transport } = createRecordingTransport();

        const result = await createSmtpAuthEmailDelivery({ config, transport }).deliver(reset);

        expect(result).toEqual({ status: "sent" });
        expect(sent).toHaveLength(1);
        expect(sent[0].from).toBe("Happier <no-reply@happier.dev>");
        expect(sent[0].to).toBe("Alice@Example.com");
        expect(sent[0].subject).toBe("Reset your Happier password");
        expect(sent[0].text).toContain(reset.resetUrl);
        expect(sent[0].html).toContain(reset.resetUrl);
    });

    it("classifies an incomplete render as a render failure and never submits it", async () => {
        const { sent, transport } = createRecordingTransport();

        const result = await createSmtpAuthEmailDelivery({ config, transport }).deliver({
            kind: "invitation",
            to: reset.to,
            joinUrl: "https://app.happier.dev/join/" + "A".repeat(10_000),
            homeName: "Home",
            teamName: null,
            inviterLabel: null,
            requestedRole: null,
            sharesSessionHistory: false,
            emailBound: true,
            expiresAt: new Date("2026-09-12T00:00:00.000Z"),
        });

        expect(result.status).toBe("failed");
        expect(result).toMatchObject({ reason: "render_failed" });
        expect(sent).toHaveLength(0);
    });

    it("summarizes failures without disclosing the recipient, bearer URL, or credentials", async () => {
        const { transport } = createRecordingTransport(async () => {
            throw new Error(`SMTP rejected ${reset.to.address} ${reset.resetUrl} secret-password`);
        });
        const result = await createSmtpAuthEmailDelivery({ config, transport }).deliver(reset);

        expect(result).toEqual({
            status: "failed",
            reason: "transport_failed",
            detail: "SMTP submission failed",
        });
        expect(JSON.stringify(result)).not.toContain(reset.resetUrl);
        expect(JSON.stringify(result)).not.toContain("secret-password");
        const summary = describeAuthEmailDeliveryFailure(reset, result);
        expect(summary).toBe("auth-email plain_password_reset failed (transport_failed)");
        expect(summary).not.toContain("alice@example.com");
        expect(summary).not.toContain(reset.resetUrl);
        expect(summary).not.toContain("secret-password");
    });
});
