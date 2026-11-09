import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { updateSessionMetadataEnvelopeTuple } from "@/app/session/sessionWriteService";
import { SessionOwnerMetadataEnvelopeV1Schema } from "@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1";
import { readAcceptedSessionTeamCredentialProviderModelBindingInTx, writeSessionTeamCredentialBindingsInTx } from "./sessionBinding";
import { createPlannedSessionTeamCredentialFixture as fixture, TEST_AUTHENTICATION } from "./sessionBinding.testkit";

describe("CLI model-intent to Home Team witness contraction (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-cli-team-witness-", initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1" } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each([true, false])("contracts a Team model witness through the real CLI model-intent producer and Home writer (V2 intent: %s)", async hasTeamIntent => {
        const current = await fixture("personal_allowed");
        const { createModelIntentMetadataCasCandidate } = await import("@happier-dev/agents/session/state/metadataWriters");
        const { buildSessionMetadataEnvelopeFields } = await import("../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields");
        const { updateSessionMetadataWithRetry } = await import("../../../../../cli/src/session/metadata/updateSessionMetadataWithRetry");
        const transport = await import("../../../../../cli/src/session/transport/http/sessionsHttp");
        const credentials = { token: "test-recipient-token", encryption: null };
        const agentTargetKey = "agent:happier.agent.codex/codex";
        const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: "plain",
            metadata: { flavor: "codex", ...(hasTeamIntent ? { modelSelectionIntentV2: { v: 2, updatedAt: 10, ref: {
                source: "team_resource", teamId: current.team.id, resourceId: current.resource.id,
                expectedResourceRevision: current.resource.revision, deliveryMode: "brokered",
                agentTargetKey, modelId: "same-model",
            } } } : { modelSelectionIntentV1: { v: 1, updatedAt: 10,
                selection: { agentTargetKey, providerConnectionId: null, modelId: "same-model" } } }) },
            agentState: null, storedContentMode: "plain" });
        const session = await db.session.create({ data: {
            accountId: current.creator.id, tag: `cli-native-contraction-${crypto.randomUUID()}`, encryptionMode: "plain",
            metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext,
            ownerMetadata: JSON.stringify(fields.ownerMetadata), agentState: null,
        } });
        await expect(inTx(tx => writeSessionTeamCredentialBindingsInTx(tx, {
            sessionId: session.id, accountId: current.creator.id, authentication: TEST_AUTHENTICATION,
            intents: [{ v: 1, slot: { kind: "provider_model" }, resourceId: current.resource.id,
                expectedResourceRevision: current.resource.revision, deliveryMode: "brokered" }],
        }))).resolves.toEqual({ ok: true });
        const acceptedTeamCredentialBinding = await inTx(tx => readAcceptedSessionTeamCredentialProviderModelBindingInTx(tx, session.id));
        // Substitute only the HTTP boundary. The actual CLI producer, strict
        // wire consumer, Home tuple/witness owners and SQLite transaction run.
        const patch = vi.spyOn(transport, "patchSessionMetadataEnvelopeTuple").mockImplementation(async input => {
            const written = await updateSessionMetadataEnvelopeTuple({ ...input.patch,
                actorUserId: current.creator.id, sessionId: session.id, authentication: TEST_AUTHENTICATION });
            if (!written.ok) throw new Error(written.error);
            return { success: true, metadataLayoutVersion: 1,
                sharedMetadata: written.sharedMetadata, agentState: written.agentState };
        });
        try {
            const candidate = createModelIntentMetadataCasCandidate({ nowMs: () => 20,
                selection: { agentTargetKey, providerConnectionId: null, modelId: "same-model" } });
            await updateSessionMetadataWithRetry({ token: credentials.token, credentials, sessionId: session.id,
                accountEncryptionCurrentness: { mode: "plain", version: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: "unavailable", reason: "plain_account" } },
                rawSession: { ...session, acceptedTeamCredentialBinding,
                    ownerMetadata: fields.ownerMetadata, encryptionMode: "plain", dataEncryptionKey: null },
                sessionExpectation: { kind: "inactive_model_intent" }, updater: candidate.update,
            });
            await expect(db.sessionTeamCredentialBinding.count({ where: { sessionId: session.id } })).resolves.toBe(0);
            const stored = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { ownerMetadata: true } });
            const envelope = SessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(stored.ownerMetadata!));
            if (envelope.t !== "plain") throw new Error("Expected a plain fixture owner envelope");
            expect(envelope.v.runtime).not.toHaveProperty("modelSelectionIntentV2");
            expect(envelope.v.runtime?.modelSelectionIntentV1?.selection).toMatchObject({
                providerConnectionId: null, modelId: "same-model",
            });
            expect(patch).toHaveBeenCalledTimes(1);
        } finally { patch.mockRestore(); }
    });
});
