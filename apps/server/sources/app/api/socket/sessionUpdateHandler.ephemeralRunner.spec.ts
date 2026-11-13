import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1,
    ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1,
} from "@happier-dev/protocol";

import { sessionUpdateHandler } from "./sessionUpdateHandler";

// The feature decision reads the stored Home rows (the database boundary): none is stored.
vi.mock("@/storage/db", async (importOriginal) => {
    const homeSnapshot = {
        ...(await import("@/app/home/settings/homeConfigSnapshot.testkit")).homeConfigSnapshotPostgresQueryMock,
        homeSettings: { findUnique: async () => null },
        homeGovernancePolicy: { findUnique: async () => null },
    };
    return {
        ...await importOriginal<typeof import("@/storage/db")>(),
        db: (await import("../testkit/dbMocks")).createDbTransactionMock(() => homeSnapshot).wrapDb(homeSnapshot),
    };
});

describe("sessionUpdateHandler ephemeral Runner admission", () => {
    beforeEach(() => vi.stubEnv("HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED", "1"));
    afterEach(() => vi.unstubAllEnvs());

    it("exposes only message input and disconnect cleanup to an API-token viewer", () => {
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        // Socket registration is the network boundary; handler logic remains real.
        const socket = { data: { clientType: "session-scoped", sessionId: "session-13" },
            on: (event: string, listener: (...args: unknown[]) => unknown) => handlers.set(event, listener) };
        sessionUpdateHandler("account-13", socket as never,
            { connectionType: "session-scoped", socket, userId: "account-13", sessionId: "session-13" } as never,
            undefined, { principalKind: "api-token-session-viewer", principal: {
                accountId: "account-13", credentialId: "token-13", principalId: "token-13",
                authority: "account_automation", expiresAt: null, authenticationEvidence: undefined,
                grant: { v: 1, actions: { families: [], ids: ["session.transcript.get", "session.message.send"] },
                    targets: { sessions: ["session-13"], machines: [] }, approve: false, origins: [],
                    models: null, permissionModes: null, create: null }, parentTokenId: null, embedConfig: null,
            } });
        expect([...handlers.keys()].sort()).toEqual(["disconnect", "message"]);
    });

    it("keeps personal Account attention operations outside the Session runtime principal", async () => {
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        const socket = {
            data: {
                clientType: "session-scoped",
                sessionId: "session-13",
                machineId: "machine-13",
            },
            on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
                handlers.set(event, handler);
            }),
        };
        const connection = {
            connectionType: "session-scoped" as const,
            socket,
            userId: "account-13",
            sessionId: "session-13",
        };
        sessionUpdateHandler(
            "account-13",
            socket as never,
            connection as never,
            undefined,
            {
                principalKind: "ephemeral-session-runner",
                principal: {
                    kind: "ephemeral_session_runner",
                    authority: "session_runtime",
                    accountId: "account-13",
                    activationId: "00000000-0000-4000-8000-000000000013",
                    sessionId: "session-13",
                    machineId: "machine-13",
                    installationId: "installation-13",
                    installationPublicKey: "a".repeat(43),
                    creatorTokenEpoch: 0,
                },
            },
        );

        const voiceAck = vi.fn();
        await handlers.get(ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1)?.(
            { v: 1, voiceSessionId: "session-13" },
            voiceAck,
        );
        expect(voiceAck).toHaveBeenCalledWith({ ok: false, v: 1, error: "forbidden" });

        const readAck = vi.fn();
        await handlers.get("update-read-cursor")?.(
            { sid: "session-13", operation: "mark-read" },
            readAck,
        );
        expect(readAck).toHaveBeenCalledWith({ result: "forbidden" });
    });

    it.each([
        ["generic Session publisher", undefined],
        ["wrong runtime kind", async () => ({
            ok: true as const,
            parentSessionId: "session-13",
            occurrenceId: "occurrence-13",
            intent: "agent" as const,
            runtimeState: "active_turn" as const,
        })],
        ["wrong hidden Voice Session", async () => ({
            ok: true as const,
            parentSessionId: "another-session",
            occurrenceId: "occurrence-13",
            intent: "voice_agent" as const,
            runtimeState: "active_turn" as const,
        })],
        ["stale or terminal Run", async () => ({
            ok: false as const,
            reasonCode: "execution_run_terminal" as const,
        })],
    ] as const)("rejects Account Voice observation from a %s", async (_label, resolveExecutionRunCurrentness) => {
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        const socket = {
            data: {
                clientType: "session-scoped",
                sessionId: "session-13",
                machineId: "machine-13",
            },
            on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
        };
        const runAsCurrentPublisherInTx = vi.fn();
        sessionUpdateHandler(
            "account-13",
            socket as never,
            { connectionType: "session-scoped", socket, userId: "account-13", sessionId: "session-13" } as never,
            {
                presence: { runAsCurrentPublisherInTx } as never,
                binding: { accountId: "account-13", machineId: "machine-13", sessionId: "session-13" },
            },
            undefined,
            resolveExecutionRunCurrentness ? { resolveExecutionRunCurrentness } : undefined,
        );

        const ack = vi.fn();
        await handlers.get(ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1)?.(
            { v: 1, voiceSessionId: "session-13", executionRunId: "voice-run-13" },
            ack,
        );
        expect(ack).toHaveBeenCalledWith({ ok: false, v: 1, error: "forbidden" });
        expect(runAsCurrentPublisherInTx).not.toHaveBeenCalled();

        const acknowledge = vi.fn();
        await handlers.get(ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1)?.(
            {
                v: 1,
                voiceSessionId: "session-13",
                executionRunId: "voice-run-13",
                expectedExecutionRunOccurrenceId: "occurrence-13",
                sourceSessionId: "source-13",
                expectedPublisherGeneration: "1",
                expected: null,
                observed: { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null },
                consumed: { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null },
                acceptance: { localInputId: "voice-input-13", userMessageSeq: 1 },
            },
            acknowledge,
        );
        expect(acknowledge).toHaveBeenCalledWith({ ok: false, v: 1, error: "forbidden" });
        expect(runAsCurrentPublisherInTx).not.toHaveBeenCalled();
    });
});
