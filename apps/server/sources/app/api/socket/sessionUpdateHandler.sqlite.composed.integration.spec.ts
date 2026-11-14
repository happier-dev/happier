import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Expo } from "expo-server-sdk";

import {
    SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX,
    DISCUSSION_AGENT_POST_EVENT_V1,
    DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1,
} from "@happier-dev/protocol";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { resolvePresenceTimeoutConfig, runPresenceTimeoutTick } from "@/app/presence/timeout";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { eventRouter, type ClientConnection } from "@/app/events/eventRouter";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import {
    createAuthenticatedFakeSocket,
    createFakeSocket,
    getSocketHandler,
} from "@/app/api/testkit/socketHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { deriveSessionSystemRecordAddressKeys } from "@/app/session/systemRecords/sessionSystemRecordAddressKeys";
import { encodeSessionSystemRecordRevision } from "@/app/session/systemRecords/sessionSystemRecordRevision";
import { createDiscussion } from "@/app/discussions/mutations";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setHomeSettings } from '@/app/home/settings/homeSettings';
import { logger } from '@/utils/logging/log';
import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY } from "@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1";
import {
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    SessionTranscriptObservationAckV1Schema,
    SessionTranscriptObservationInputSchema,
} from "@happier-dev/protocol/sessions/messages/transcriptObservationV1";

const authentication = createPresentUserSessionAccessAuthentication();

describe("session update handler on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-update-handler-",
            sqliteConnectionLimit: 1,
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it("publishes released legacy partial changes through the current-view owner and keeps equal state silent", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const participant = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: "plain", metadata: "{}", agentState: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: participant.id, accessLevel: "view" } });
        await db.accountPushToken.create({ data: { accountId: owner.id,
            token: "ExponentPushToken[metadata-owner-badge]" } });
        const socket = createAuthenticatedFakeSocket();
        const connection: ClientConnection = { connectionType: "user-scoped", userId: owner.id,
            socket: socket as unknown as ClientConnection["socket"] };
        sessionUpdateHandler(owner.id, connection.socket, connection);
        // Observe the socket-delivery boundary after real admission, SQLite CAS and projection.
        const emit = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => undefined);
        // Wait for the real asynchronous badge path at its external push boundary
        // before closing SQLite; no background query may outlive this fixture.
        const push = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync")
            .mockResolvedValue([{ status: "ok", id: "metadata-owner-badge" }]);
        try {
            const metadata = JSON.stringify({ name: "Private owner title" });
            const metadataAck: unknown[] = [];
            await getSocketHandler(socket, "update-metadata")({ sid: session.id, metadata, expectedVersion: 0 },
                (ack: unknown) => metadataAck.push(ack));
            expect(metadataAck).toEqual([{ result: "success", version: 1, metadata }]);
            expect(emit.mock.calls.filter(([publication]) => publication.payload.body.t === 'update-session').map(([publication]) => ({ userId: publication.userId,
                body: publication.payload.body, sender: publication.skipSenderConnection }))).toEqual([
                expect.objectContaining({ userId: owner.id, sender: connection,
                    body: expect.objectContaining({ t: "update-session", id: session.id,
                        metadata: { value: metadata, version: 1 }, agentState: undefined }) }),
            ]);
            emit.mockClear();
            const equalAck: unknown[] = [];
            await getSocketHandler(socket, "update-state")({ sid: session.id, agentState: "{}", expectedVersion: 0 },
                (ack: unknown) => equalAck.push(ack));
            expect(equalAck).toEqual([{ result: "success", version: 0, agentState: "{}" }]);
            expect(emit).not.toHaveBeenCalled();
            const agentState = JSON.stringify({ requests: { question: { kind: "user_action", createdAt: 100 } } });
            const stateAck: unknown[] = [];
            await getSocketHandler(socket, "update-state")({ sid: session.id, agentState, expectedVersion: 0,
                activitySummaryV1: { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1,
                    pendingRequestNewestCreatedAt: 100 } }, (ack: unknown) => stateAck.push(ack));
            expect(stateAck).toEqual([{ result: "success", version: 1, agentState }]);
            expect(emit.mock.calls.filter(([publication]) => publication.payload.body.t === 'update-session').map(([publication]) => ({ userId: publication.userId,
                body: publication.payload.body, sender: publication.skipSenderConnection }))).toEqual([
                expect.objectContaining({ userId: owner.id, sender: connection,
                    body: expect.objectContaining({ t: "update-session", id: session.id, metadata: undefined,
                        agentState: { value: agentState, version: 1 }, pendingUserActionRequestCount: 1 }) }),
            ]);
            await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1), { timeout: 10_000 });
        } finally { emit.mockRestore(); push.mockRestore(); }
    });

    it("recovers the original capability notice after Home commits but its ACK is lost", async () => {
        type TranscriptObservation = ReturnType<typeof SessionTranscriptObservationInputSchema.parse>;
        const noticeEvent = {
            type: "message" as const, message: "An optional MCP server could not be prepared.",
            [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: { v: 1 as const, items: [{
                kind: "mcp_server" as const, itemId: "optional-tracker", name: "Tracker",
                code: "mcp_unavailable", detail: "catalog_unavailable",
            }] },
        };
        // Load the actual CLI modules through Vitest's cross-package boundary,
        // as the Follow compositions do. Server compilation keeps its own alias
        // and rootDir; runtime still exercises the real producer and disk journal.
        const [
            { reloadConfiguration },
            { prepareSessionEventMessageViaPort },
            { loadSessionClientDurableMutationOutbox },
            { resolveTranscriptMessageAppendMutationId },
        ] = await Promise.all([
            vi.importActual<{ reloadConfiguration(): void }>("../../../../../cli/src/configuration"),
            vi.importActual<{
                prepareSessionEventMessageViaPort(
                    port: { buildOutboundSessionMessagePayload(content: unknown): TranscriptObservation["content"] },
                    event: typeof noticeEvent,
                ): { payload: TranscriptObservation["content"]; localId: string; messageRole: NonNullable<TranscriptObservation["messageRole"]> };
            }>("../../../../../cli/src/api/session/client/transcript/sendMessages"),
            vi.importActual<{
                loadSessionClientDurableMutationOutbox(sessionId: string): Promise<readonly unknown[]>;
            }>("../../../../../cli/src/api/session/client/transport/mutations/sessionClientDurableMutationPersistence"),
            vi.importActual<{
                resolveTranscriptMessageAppendMutationId(input: { sessionId: string; localId: string }): string;
            }>("../../../../../cli/src/api/session/client/transport/mutations/sessionClientDurableMutationTypes"),
        ]);
        const previousCliHome = process.env.HAPPIER_HOME_DIR;
        process.env.HAPPIER_HOME_DIR = join(harness.baseDir, "capability-notice-cli");
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        reloadConfiguration();
        const handles: { close(): Promise<void> }[] = [];
        let releaseLostAck!: () => void;
        const loseAck = new Promise<void>(resolve => { releaseLostAck = resolve; });
        let committedAtHome!: () => void;
        const homeCommitted = new Promise<void>(resolve => { committedAtHome = resolve; });
        try {
            const owner = await db.account.create({
                data: { publicKey: `notice-owner-${randomUUID()}`, encryptionMode: "plain" },
            });
            const machineId = `notice-machine-${randomUUID()}`;
            await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: `notice-${randomUUID()}`, encryptionMode: "plain", metadata: "{}",
            } });
            await db.accessKey.create({ data: {
                accountId: owner.id, machineId, sessionId: session.id, data: "encrypted",
            } });
            const presence = createSessionPublisherPresence();
            const attempts: ReturnType<typeof SessionTranscriptObservationInputSchema.parse>[] = [];
            const homeAcks: ReturnType<typeof SessionTranscriptObservationAckV1Schema.parse>[] = [];
            const connectPublisher = async (dropAck: boolean) => {
                const socket = createAuthenticatedFakeSocket({ id: `notice-socket-${randomUUID()}` });
                sessionUpdateHandler(owner.id, socket as never, {
                    connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id,
                } as never, { presence, binding: { accountId: owner.id, machineId, sessionId: session.id } });
                const claimAcks: unknown[] = [];
                await getSocketHandler(socket, "session-runtime-activity-snapshot")({
                    sessionId: session.id, mutationId: randomUUID(), snapshot: { state: "idle", activeCount: 0 },
                }, (ack: unknown) => claimAcks.push(ack));
                expect(claimAcks).toEqual([expect.objectContaining({
                    status: expect.stringMatching(/^(applied|unchanged)$/u), sessionId: session.id,
                })]);
                // Only Socket.IO transport is substituted. The registered Home
                // handler, publisher admission, transcript writer and SQL dedup stay real.
                const transport: {
                    connected: boolean;
                    emit(): void;
                    emitWithAck(event: string, payload: unknown): Promise<unknown>;
                } = {
                    connected: true,
                    emit: () => undefined,
                    async emitWithAck(event: string, payload: unknown) {
                        expect(event).toBe(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1);
                        attempts.push(SessionTranscriptObservationInputSchema.parse(payload));
                        let response: unknown;
                        await getSocketHandler(socket, event)(payload, (ack: unknown) => { response = ack; });
                        const ack = SessionTranscriptObservationAckV1Schema.parse(response);
                        homeAcks.push(ack);
                        if (dropAck) {
                            committedAtHome();
                            await loseAck;
                            transport.connected = false;
                            socket.connected = false;
                            throw new Error("connection closed after Home committed and before ACK delivery");
                        }
                        return ack;
                    },
                };
                return transport;
            };
            const firstSocket = await connectPublisher(true);
            const contract = (socket: typeof firstSocket, epoch: number) => ({
                mode: "session_sync_v2_pending_input_v1" as const,
                runtimeActivity: "v2" as const, pendingInput: "v1" as const,
                publisherAuthority: "indeterminate" as const, sessionConnectionEpoch: epoch, socket,
                transcriptTransport: { mode: "session_transcript_observation_v1" as const },
            });
            const outboxParams = {
                token: "transport-fixture", sessionId: session.id, flushOnReady: false,
                getSocket: () => firstSocket, requestReconnect: () => undefined,
            };
            const prepareNotice = () => prepareSessionEventMessageViaPort({
                buildOutboundSessionMessagePayload: content => ({ t: "plain", v: content }),
            }, noticeEvent);
            const prepared = prepareNotice();
            const now = Date.now();
            const mutation = {
                v: 1 as const, sessionId: session.id,
                mutationId: resolveTranscriptMessageAppendMutationId({ sessionId: session.id, localId: prepared.localId }),
                source: "transcript_message_append" as const, localId: prepared.localId, sidechainId: null,
                messageRole: prepared.messageRole, content: prepared.payload, createdAt: now, updatedAt: now,
                provenance: { kind: "non_dependent" as const, source: "background" as const },
            };
            type NoticeOutbox = {
                enqueueTranscriptMessage(input: typeof mutation, options: { awaitDelivery: boolean }): Promise<{
                    persisted: boolean; delivered: boolean; localId?: string;
                }>;
                setSessionSyncPendingInputServerContract(input: ReturnType<typeof contract>): Promise<void>;
                activateDelivery(): Promise<void>;
                awaitReady(): Promise<void>;
                flush(reason: "flush"): Promise<void>;
                close(): Promise<void>;
            };
            const { createRuntimeSessionClientDurableMutationOutbox } = await vi.importActual<{
                createRuntimeSessionClientDurableMutationOutbox(params: typeof outboxParams & { initiallyActive?: boolean }): NoticeOutbox;
            }>("../../../../../cli/src/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox");
            const first = createRuntimeSessionClientDurableMutationOutbox(outboxParams);
            handles.push(first);
            await first.setSessionSyncPendingInputServerContract(contract(firstSocket, 1));

            // The optional caller resumes from durable custody while the real
            // Home ACK is still unavailable; it installs no delivery observer.
            expect(await first.enqueueTranscriptMessage(mutation, { awaitDelivery: false })).toMatchObject({
                persisted: true, delivered: false, localId: prepared.localId,
            });
            await homeCommitted;
            const committed = await db.sessionMessage.findUniqueOrThrow({ where: {
                sessionId_localId: { sessionId: session.id, localId: prepared.localId },
            } });
            expect(committed.content).toEqual(prepared.payload);
            expect(committed.content).toMatchObject({ t: "plain", v: { content: { data: {
                [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: {
                    v: 1, items: [{ kind: "mcp_server", itemId: "optional-tracker", code: "mcp_unavailable" }],
                },
            } } } });
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([expect.objectContaining({
                mutationId: mutation.mutationId, payload: expect.objectContaining({ localId: prepared.localId }),
            })]);

            releaseLostAck();
            await first.flush("flush");
            await first.close();
            handles.pop();
            expect(homeAcks).toEqual([expect.objectContaining({ ok: true, didWrite: true, localId: prepared.localId })]);
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([expect.objectContaining({
                mutationId: mutation.mutationId, attempts: 1,
            })]);

            const recoveredSocket = await connectPublisher(false);
            const recovered = createRuntimeSessionClientDurableMutationOutbox({
                ...outboxParams, initiallyActive: false, getSocket: () => recoveredSocket,
            });
            handles.push(recovered);
            await recovered.awaitReady();
            await recovered.setSessionSyncPendingInputServerContract(contract(recoveredSocket, 2));
            expect(prepareNotice().localId).toBe(prepared.localId);
            // Do not enqueue another event: the replacement handle must recover
            // and dequeue the original persisted mutation itself.
            await recovered.activateDelivery();
            await recovered.flush("flush");

            expect(attempts.map(attempt => attempt.localId)).toEqual([prepared.localId, prepared.localId]);
            expect(homeAcks).toEqual([
                expect.objectContaining({ ok: true, id: committed.id, seq: committed.seq, didWrite: true }),
                expect.objectContaining({ ok: true, id: committed.id, seq: committed.seq, didWrite: false }),
            ]);
            expect(await db.sessionMessage.findMany({ where: { sessionId: session.id },
                select: { id: true, seq: true, localId: true, content: true, rowRevision: true },
            })).toEqual([{
                id: committed.id, seq: committed.seq, localId: prepared.localId,
                content: committed.content, rowRevision: committed.rowRevision,
            }]);
            expect(await loadSessionClientDurableMutationOutbox(session.id)).toEqual([]);
        } finally {
            releaseLostAck();
            try {
                for (const handle of handles) await handle.close();
            } finally {
                if (previousCliHome === undefined) delete process.env.HAPPIER_HOME_DIR;
                else process.env.HAPPIER_HOME_DIR = previousCliHome;
                reloadConfiguration();
            }
        }
    });

    it('reads saved live message diagnostics on the next socket event without reconnecting', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain', homeRole: 'owner' }, select: { id: true } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: `session-${randomUUID()}`, encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) }, select: { id: true } });
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(owner.id, socket as never, { connectionType: 'user-scoped', socket, userId: owner.id } as never);
        const diagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        try {
            const saved = await setHomeSettings({ actorAccountId: owner.id, write: { expectedRevision: 0, values: { HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: true } } });
            expect(saved.status).toBe('applied');
            await getSocketHandler(socket, 'message')({ sid: session.id, localId: randomUUID(), messageRole: 'user', message: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Hello' } } } });
            expect(diagnostic.mock.calls.some(([, message]) => typeof message === 'string' && message.startsWith('Received message from socket'))).toBe(true);
            diagnostic.mockClear();
            expect((await setHomeSettings({ actorAccountId: owner.id, write: { expectedRevision: 1, values: { HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: false } } })).status).toBe('applied');
            await getSocketHandler(socket, 'message')({ sid: session.id, localId: randomUUID(), messageRole: 'user', message: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Again' } } } });
            expect(diagnostic.mock.calls.some(([, message]) => typeof message === 'string' && message.startsWith('Received message from socket'))).toBe(false);
        } finally {
            diagnostic.mockRestore();
            await db.homeSettings.deleteMany({});
        }
    });

    it("ACKs the canonical Runtime Activity publisher claim only after active reachability commits", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const socket = createAuthenticatedFakeSocket();
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence: createSessionPublisherPresence(),
                binding: {
                    accountId: owner.id,
                    machineId,
                    sessionId: session.id,
                },
            },
        );

        const acknowledgements: unknown[] = [];
        // Logging is the output boundary; publisher custody and SQLite stay real.
        const trace = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        try {
            await getSocketHandler(socket, "session-runtime-activity-snapshot")({
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "unknown", activeCount: 0 },
            }, (value: unknown) => acknowledgements.push(value));

            expect(acknowledgements).toEqual([expect.objectContaining({
                status: "unchanged",
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                projection: expect.objectContaining({
                    state: "unknown",
                    activeCount: 0,
                }),
            })]);
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { active: true },
            })).resolves.toEqual({ active: true });
            const records = trace.mock.calls.map(([record]) => record).filter(
                (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
            );
            const ingress = records.find(record => record?.phase === 'socket.session-runtime-activity-snapshot');
            expect(ingress).toEqual(expect.objectContaining({
                sessionId: session.id, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            }));
            expect(records).toEqual(expect.arrayContaining([
                expect.objectContaining({ phase: 'session.runtime_activity.commit', requestId: ingress?.requestId }),
                expect.objectContaining({ phase: 'session.runtime_activity.publish', requestId: ingress?.requestId }),
            ]));
        } finally {
            trace.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it("posts Agent Discussion provenance only through the exact current Session publisher", async () => {
        process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = "1";
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const created = await createDiscussion({
            authentication,
            actorAccountId: owner.id,
            request: {
                creationLocalId: `discussion-${randomUUID()}`,
                titleContent: { t: "plain", v: { v: 1, title: "Runtime" } },
                firstMessage: {
                    localId: `message-${randomUUID()}`,
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Start" }] } },
                    mentionedAccountIds: [],
                },
            },
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket({
            id: "discussion-current-publisher",
            data: { authAuthority: "account_automation" },
        });
        sessionUpdateHandler(
            owner.id,
            socket as never,
            { connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id } as never,
            { presence, binding: { accountId: owner.id, machineId, sessionId: session.id } },
        );

        const beforeClaim: unknown[] = [];
        const atomicCreate = { v: 1 as const, operation: 'create' as const, sessionId: session.id, toolCallId: 'create-tool', request: {
            creationLocalId: `agent-create-${randomUUID()}`,
            titleContent: { t: 'plain' as const, v: { v: 1, title: 'Atomic runtime creation' } },
            firstMessage: { localId: `first-${randomUUID()}`, content: { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Agent first post' }] } }, mentionedAccountIds: [] },
        } };
        await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)(atomicCreate, (value: unknown) => beforeClaim.push(value));
        await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            request: {
                localId: "agent-before-claim",
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "No" }] } },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => beforeClaim.push(value));
        expect(beforeClaim).toEqual(Array.from({ length: 2 }, () => ({ ok: false, v: 1, error: "discussion_post_denied" })));

        const overBudget: unknown[] = [];
        await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            request: {
                localId: "agent-over-budget",
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        parts: [{ t: "text", text: "x".repeat(DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1) }],
                    },
                },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => overBudget.push(value));
        expect(overBudget).toEqual([{ ok: false, v: 1, error: "discussion_invalid_content" }]);
        expect(await db.discussionMessage.count({ where: { localId: "agent-over-budget" } })).toBe(0);

        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const atomicAcknowledgements: unknown[] = [];
        for (let retry = 0; retry < 2; retry++) await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)(atomicCreate,
            (value: unknown) => atomicAcknowledgements.push(value));
        expect(atomicAcknowledgements).toHaveLength(2);
        expect(atomicAcknowledgements[0]).toMatchObject({ v: 1, ok: true, value: {
            discussion: { messageSeq: 1 }, firstMessage: { seq: 1, producerV1: {
                v: 1, kind: 'agent', sessionId: session.id, toolCallId: 'create-tool',
            } },
        } });
        expect(atomicAcknowledgements[1]).toEqual(atomicAcknowledgements[0]);
        const atomicRow = await db.discussion.findUniqueOrThrow({ where: { createdByAccountId_creationLocalId: {
            createdByAccountId: owner.id, creationLocalId: atomicCreate.request.creationLocalId,
        } } });
        expect(await db.discussionParticipant.count({ where: { discussionId: atomicRow.id } })).toBe(0);
        expect(await db.discussionMessage.count({ where: { discussionId: atomicRow.id } })).toBe(1);

        const nonParticipant: unknown[] = [];
        await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            request: {
                localId: "agent-without-participant",
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Not invited" }] } },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => nonParticipant.push(value));
        expect(nonParticipant).toEqual([{ ok: false, v: 1, error: "discussion_post_denied" }]);
        expect(await db.discussionMessage.count({ where: { localId: "agent-without-participant" } })).toBe(0);

        await db.discussionParticipant.create({
            data: { discussionId: created.value.discussion.id, participantSlotId: session.id, sessionId: session.id, answerPolicy: "when_addressed" },
        });

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            runId: "run-1",
            toolCallId: "tool-1",
            request: {
                localId: "agent-after-claim",
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Done" }] } },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => acknowledgements.push(value));

        expect(acknowledgements).toEqual([expect.objectContaining({
            ok: true,
            v: 1,
            value: expect.objectContaining({
                message: expect.objectContaining({
                    authorAccountId: owner.id,
                    producerV1: {
                        v: 1,
                        kind: "agent",
                        sessionId: session.id,
                        runId: "run-1",
                        toolCallId: "tool-1",
                    },
                }),
            }),
        })]);
    });

    it("advertises transcript observation support before the Antigravity publisher claim without admitting observations", async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence,
                binding: {
                    accountId: owner.id,
                    machineId,
                    sessionId: session.id,
                },
            },
        );

        const observation = {
            v: 1 as const,
            sessionId: session.id,
            localId: `antigravity-${randomUUID()}`,
            messageRole: "agent" as const,
            content: "antigravity-ciphertext",
            createdAt: Date.parse("2026-07-28T18:00:02.000Z"),
            updatedAt: Date.parse("2026-07-28T18:00:02.000Z"),
            provenance: {
                kind: "non_dependent" as const,
                source: "external" as const,
            },
        };

        const capabilityAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: session.id },
            (value: unknown) => capabilityAcks.push(value),
        );
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 2, sessionId: session.id },
            (value: unknown) => capabilityAcks.push(value),
        );
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 2, sessionId: session.id, invented: true },
            (value: unknown) => capabilityAcks.push(value),
        );

        const preclaimObservationAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            observation,
            (value: unknown) => preclaimObservationAcks.push(value),
        );
        const preclaimCount = await db.sessionMessage.count({
            where: { sessionId: session.id },
        });

        const claimAcks: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")(
            {
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "idle", activeCount: 0 },
            },
            (value: unknown) => claimAcks.push(value),
        );

        const claimedObservationAcks: unknown[] = [];
        const trace = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        try {
            await getSocketHandler(socket, "transcript-observation-v1")(
                observation,
                (value: unknown) => {
                    expect(trace).toHaveBeenCalledWith(expect.objectContaining({
                        phase: 'socket.transcript-observation.ack', sessionId: session.id,
                        requestId: expect.any(String),
                    }), '[web-latency]');
                    claimedObservationAcks.push(value);
                },
            );
        } finally { trace.mockRestore(); vi.unstubAllEnvs(); }

        expect(capabilityAcks).toEqual([{
            ok: true,
            capability: "session-transcript-observation-v1",
        }, {
            ok: true,
            capability: "session-transcript-observation-v2",
        }, { ok: false, error: "invalid_session" }]);
        expect(preclaimObservationAcks).toEqual([{
            ok: false,
            error: "forbidden",
        }]);
        expect(preclaimCount).toBe(0);
        expect(claimAcks).toEqual([expect.objectContaining({
            status: "applied",
            sessionId: session.id,
        })]);
        expect(claimedObservationAcks).toEqual([expect.objectContaining({
            ok: true,
            status: "observed",
            localId: observation.localId,
            didWrite: true,
        })]);
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: {
                localId: true,
                messageRole: true,
                content: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                transcriptObservationProvenance: true,
            },
        })).resolves.toEqual([{
            localId: observation.localId,
            messageRole: "agent",
            content: { t: "encrypted", c: "antigravity-ciphertext" },
            sourceCreatedAt: new Date(observation.createdAt),
            sourceUpdatedAt: new Date(observation.updatedAt),
            transcriptObservationProvenance: {
                kind: "non_dependent",
                source: "external",
            },
        }]);

        const references = [];
        for (const itemId of ['visual-first', 'visual-second']) {
            const surfaceRecord = await db.sessionSystemRecord.create({ data: {
                sessionId: session.id, accountId: owner.id, ownerKind: "host", pluginId: null,
                namespace: "surface", kind: "item.v1", localId: itemId, version: 1,
                content: { t: "encrypted", c: "item-ciphertext" },
                ...deriveSessionSystemRecordAddressKeys({ ownerKind: "host", pluginId: null,
                    namespace: "surface", localId: itemId }),
            } });
            references.push({ v: 1 as const, itemId,
                itemRevision: encodeSessionSystemRecordRevision(surfaceRecord),
                sourceAddress: { serverId: "home-1", sessionId: session.id },
                sourceItemId: itemId, sourceItemRevision: encodeSessionSystemRecordRevision(surfaceRecord) });
        }
        const surfaceItemReference = { v: 1 as const, references };
        const submitted = { v: 1, references: [references[0], { ...references[0], itemId: 'missing' }, references[1]] };
        const visualLocalId = `visual-${randomUUID()}`;
        const visualAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            { ...observation, v: 2, localId: visualLocalId, surfaceItemReference: submitted },
            (value: unknown) => visualAcks.push(value),
        );
        expect(visualAcks).toEqual([expect.objectContaining({ ok: true, status: "observed", localId: visualLocalId })]);
        await expect(db.sessionMessage.findFirst({ where: { sessionId: session.id, localId: visualLocalId },
            select: { content: true, surfaceItemReference: true } })).resolves.toEqual({
            content: { t: "encrypted", c: "antigravity-ciphertext" }, surfaceItemReference,
        });
    });

    it("refuses a reserved Agent-transition divider localId from the current transcript-observation publisher", async () => {
        // Being the claimed publisher grants the right to mirror provider output, not the
        // right to mint the owner-only transition divider. The identical observation with an
        // ordinary localId is admitted below, so this proves the refusal is the reserved
        // namespace rather than any authorization state.
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            { presence, binding: { accountId: owner.id, machineId, sessionId: session.id } },
        );

        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: session.id },
            () => {},
        );
        await getSocketHandler(socket, "session-runtime-activity-snapshot")(
            {
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "idle", activeCount: 0 },
            },
            () => {},
        );

        const baseObservation = {
            v: 1 as const,
            sessionId: session.id,
            messageRole: "agent" as const,
            content: "divider-ciphertext",
            createdAt: Date.parse("2026-07-28T18:00:02.000Z"),
            updatedAt: Date.parse("2026-07-28T18:00:02.000Z"),
            provenance: { kind: "non_dependent" as const, source: "external" as const },
        };

        const reservedAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            {
                ...baseObservation,
                localId: `${SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}${randomUUID()}`,
            },
            (value: unknown) => reservedAcks.push(value),
        );

        expect(reservedAcks).toEqual([{ ok: false, error: "invalid_observation" }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);

        const ordinaryLocalId = `ordinary-${randomUUID()}`;
        const ordinaryAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            { ...baseObservation, localId: ordinaryLocalId },
            (value: unknown) => ordinaryAcks.push(value),
        );

        expect(ordinaryAcks).toEqual([expect.objectContaining({
            ok: true,
            localId: ordinaryLocalId,
            didWrite: true,
        })]);
    });

    it("rejects active metadata publication from a publisher superseded after its runtime effect", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        let now = new Date("2026-07-22T07:00:01.000Z");
        const presence = createSessionPublisherPresence({ now: () => now });
        const bindPublisher = (socketId: string) => {
            const socket = createAuthenticatedFakeSocket({ id: socketId });
            sessionUpdateHandler(
                owner.id,
                socket as never,
                {
                    connectionType: "session-scoped",
                    socket,
                    userId: owner.id,
                    sessionId: session.id,
                } as never,
                {
                    presence,
                    binding: {
                        accountId: owner.id,
                        machineId,
                        sessionId: session.id,
                    },
                },
            );
            return socket;
        };
        const predecessor = bindPublisher("predecessor");
        const successor = bindPublisher("successor");

        const predecessorClaim: unknown[] = [];
        await getSocketHandler(predecessor, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => predecessorClaim.push(value));
        expect(predecessorClaim).toEqual([expect.objectContaining({
            status: "applied",
        })]);

        now = new Date(now.getTime() + 1_000);
        const successorClaim: unknown[] = [];
        await getSocketHandler(successor, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => successorClaim.push(value));
        expect(successorClaim).toEqual([expect.objectContaining({
            status: "unchanged",
        })]);

        const stalePublication: unknown[] = [];
        await getSocketHandler(predecessor, "update-metadata")({
            sid: session.id,
            expectedVersion: 0,
            metadata: JSON.stringify({
                sessionModelsV1: {
                    v: 1,
                    agentId: "opencode",
                    updatedAt: 1,
                    currentModelId: "next-model",
                    availableModels: [{ id: "next-model", name: "Next model" }],
                },
            }),
        }, (value: unknown) => stalePublication.push(value));

        expect(stalePublication).toEqual([{ result: "publisher-superseded" }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadata: true, metadataVersion: true },
        })).resolves.toEqual({
            metadata: "{}",
            metadataVersion: 0,
        });
    });

    it("closes the exact current publisher through the canonical runtime-activity close event", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const turnId = `turn-${randomUUID()}`;
        await expect(applySessionTurnMutation({
            actorUserId: owner.id,
            authentication,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId,
                observedAt: Date.now() - 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence: createSessionPublisherPresence(),
                binding: { accountId: owner.id, machineId, sessionId: session.id },
            },
        );

        const snapshotAcknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: "activity-1",
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => snapshotAcknowledgements.push(value));
        expect(snapshotAcknowledgements).toEqual([expect.objectContaining({
            status: "applied",
            sessionId: session.id,
            mutationId: "activity-1",
            projection: expect.objectContaining({ state: "idle", activeCount: 0 }),
        })]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-close")(
            { sessionId: session.id },
            (value: unknown) => acknowledgements.push(value),
        );

        expect(acknowledgements).toEqual([{ status: "closed", sessionId: session.id }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                latestTurnId: true,
                latestTurnStatus: true,
                thinking: true,
            },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
            latestTurnId: turnId,
            latestTurnStatus: "cancelled",
            thinking: false,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: "cancelled" });
    });

    async function createReleasedAliveSession(
        now: () => number,
        presence = createSessionPublisherPresence({ now: () => new Date(now()) }),
    ) {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const socket = createAuthenticatedFakeSocket();
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        sessionUpdateHandler(
            owner.id,
            socket as never,
            { connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id } as never,
            {
                presence,
                binding,
            },
        );
        const alive = getSocketHandler(socket, "session-alive");
        // cli-v0.2.12 / cli-v0.2.12-preview.1 at a357c655: createSessionAlivePayload.
        const heartbeat = async (thinking = false) => await alive({
            sid: session.id, time: now(), thinking, mode: "remote",
        });
        return { sessionId: session.id, heartbeat, socket, presence, binding };
    }

    it.each([
        { sessionTimeoutMs: 35_000, thinkingUntilMs: 0, idleSpacingMs: 15_000 },
        { sessionTimeoutMs: 60_000, thinkingUntilMs: 0, idleSpacingMs: 15_000 },
        { sessionTimeoutMs: 20_000, thinkingUntilMs: 8_000, idleSpacingMs: 16_000 },
    ])("keeps released heartbeats reachable with a $sessionTimeoutMs ms presence expiry after thinking until $thinkingUntilMs ms", async ({ sessionTimeoutMs, thinkingUntilMs, idleSpacingMs }) => {
        process.env.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS = String(sessionTimeoutMs);
        process.env.HAPPIER_PRESENCE_TIMEOUT_TICK_MS = "1000";
        const timeoutConfig = resolvePresenceTimeoutConfig();
        const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
        let clockMs = startedAt;
        const { sessionId, heartbeat } = await createReleasedAliveSession(() => clockMs);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let lastHeartbeatAtMs = startedAt;
        try {
            await heartbeat(thinkingUntilMs > 0);
            for (let elapsedMs = timeoutConfig.tickMs; elapsedMs <= sessionTimeoutMs * 2; elapsedMs += timeoutConfig.tickMs) {
                clockMs = startedAt + elapsedMs;
                // Expiry runs first so a coincident heartbeat cannot conceal an already stale fence.
                await runPresenceTimeoutTick(timeoutConfig);
                await expect(db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { active: true },
                })).resolves.toEqual({ active: true });
                await vi.advanceTimersByTimeAsync(timeoutConfig.tickMs);
                // The released 2s loop takes 16s to meet the 15s idle cadence after thinking.
                const heartbeatDue = elapsedMs <= thinkingUntilMs
                    ? elapsedMs % 2_000 === 0
                    : (elapsedMs - thinkingUntilMs) % idleSpacingMs === 0;
                if (heartbeatDue) {
                    lastHeartbeatAtMs = clockMs;
                    await heartbeat(elapsedMs < thinkingUntilMs);
                }
            }
            clockMs += sessionTimeoutMs / 2;
            await vi.advanceTimersByTimeAsync(sessionTimeoutMs / 2);
            await vi.waitFor(async () => {
                const persisted = await db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { lastActiveAt: true },
                });
                expect(persisted.lastActiveAt.getTime()).toBe(lastHeartbeatAtMs);
            });
            clockMs = lastHeartbeatAtMs + sessionTimeoutMs - 1;
            await runPresenceTimeoutTick(timeoutConfig);
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true },
            })).resolves.toEqual({ active: true });
            clockMs += 1;
            await runPresenceTimeoutTick(timeoutConfig);
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true },
            })).resolves.toEqual({ active: false });
        } finally {
            now.mockRestore();
            vi.useRealTimers();
        }
    });

    it("persists an active released heartbeat as the liveness deadline only: no fan-out to the owner or shared audience", async () => {
        let clockMs = Date.parse("2026-07-22T08:00:00.000Z");
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        const ephemerals = vi.spyOn(eventRouter, "emitEphemeral").mockImplementation(() => undefined);
        const updates = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => undefined);
        try {
            const { sessionId, heartbeat, binding } = await createReleasedAliveSession(() => clockMs);
            const viewer = await db.account.create({ data: { encryptionMode: "plain" }, select: { id: true } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId, createdByAccountId: binding.accountId,
                accountId: viewer.id, accessLevel: "view" } });
            await heartbeat();
            await expect(db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { active: true } }))
                .resolves.toEqual({ active: true });
            const readSeqs = () => db.account.findMany({ where: { id: { in: [binding.accountId, viewer.id] } },
                orderBy: { id: "asc" }, select: { id: true, seq: true } });
            const seqsBefore = await readSeqs();
            const changesBefore = await db.accountChange.count();
            ephemerals.mockClear();
            updates.mockClear();
            const heartbeats = 5;
            for (let beat = 0; beat < heartbeats; beat += 1) {
                clockMs += 61_000;
                await heartbeat();
            }
            await vi.waitFor(async () => {
                expect((await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { lastActiveAt: true } }))
                    .lastActiveAt.getTime()).toBe(clockMs);
            });
            // Idle liveness writes no Account cursor or change row for any recipient.
            expect(await readSeqs()).toEqual(seqsBefore);
            expect(await db.accountChange.count()).toBe(changesBefore);
            expect(updates).not.toHaveBeenCalled();
            // 2026-11-04 heartbeat ruling: online/offline transitions fan out
            // (registration, close and the deadline carry activeAt); an
            // active→active beat only moves the deadline. Per-beat UI work is zero.
            const activityFrames = ephemerals.mock.calls.map(([event]) => event)
                .filter(event => event.payload.type === "activity");
            expect(activityFrames.filter(event => event.userId === viewer.id)).toHaveLength(0);
            expect(activityFrames.filter(event => event.userId === binding.accountId)).toHaveLength(0);
        } finally {
            now.mockRestore();
            ephemerals.mockRestore();
            updates.mockRestore();
        }
    });

    it.each(["trailing", "session-runtime-activity-close", "session-end", "disconnect", "replacement"])(
        "settles the default released heartbeat window through %s without inventing liveness",
        async (transition) => {
            const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
            let clockMs = startedAt;
            const { sessionId, heartbeat, socket, presence, binding } = await createReleasedAliveSession(() => clockMs);
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
            try {
                await heartbeat();
                clockMs += 59_999;
                await heartbeat();
                await expect(db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { lastActiveAt: true },
                })).resolves.toEqual({ lastActiveAt: new Date(startedAt) });
                clockMs += 1;
                if (transition === "replacement") {
                    await presence.registerPublisher({ socket: {}, binding, completeActivitySnapshot: { state: "unknown", activeCount: 0 } });
                } else if (transition !== "trailing") {
                    await getSocketHandler(socket, transition)(transition === "session-runtime-activity-close"
                        ? { sessionId }
                        : { sid: sessionId, time: clockMs });
                    if (transition === "disconnect") await presence.forgetDisconnectedPublisher({ socket });
                    expect(vi.getTimerCount()).toBe(0);
                }
                await vi.advanceTimersByTimeAsync(60_000);
                await presence.runAsCurrentPublisher({ socket, operation: async () => null });
                await vi.waitFor(async () => {
                    const persisted = await db.session.findUniqueOrThrow({
                        where: { id: sessionId }, select: { active: true, lastActiveAt: true },
                    });
                    expect(persisted).toEqual({
                        active: transition === "trailing" || transition === "replacement" || transition === "disconnect",
                        lastActiveAt: new Date(startedAt + (transition === "trailing" ? 59_999 : transition === "replacement" ? 60_000 : 0)),
                    });
                });
                expect(vi.getTimerCount()).toBe(0);
                if (transition === "trailing") {
                    let lastReceivedAtMs = startedAt + 59_999;
                    for (let elapsedMs = 75_000; elapsedMs <= 180_000; elapsedMs += 15_000) {
                        clockMs = startedAt + elapsedMs;
                        await vi.advanceTimersByTimeAsync(15_000);
                        await presence.runAsCurrentPublisher({ socket, operation: async () => null });
                        await vi.waitFor(async () => {
                            const persisted = await db.session.findUniqueOrThrow({
                                where: { id: sessionId }, select: { lastActiveAt: true },
                            });
                            // The shorter canonical expiry can flush earlier than
                            // the former ten-minute default. Retain its contract:
                            // no invented observation and no healthy expiry gap.
                            expect(persisted.lastActiveAt.getTime(), `elapsed=${elapsedMs}`)
                                .toBeLessThanOrEqual(lastReceivedAtMs);
                            expect(clockMs - persisted.lastActiveAt.getTime())
                                .toBeLessThan(resolvePresenceTimeoutConfig().sessionTimeoutMs);
                        });
                        await heartbeat();
                        lastReceivedAtMs = clockMs;
                    }
                }
            } finally {
                await socket.handlers.get("disconnect")?.();
                now.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it.each([false, true])("retains in-flight released observations without reviving a replacement (replacement: %s)", async (replacePublisher) => {
        const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
        let clockMs = startedAt;
        const { sessionId, heartbeat, socket, presence, binding } = await createReleasedAliveSession(() => clockMs);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        try {
            await heartbeat();
            const holder = presence.runAsCurrentPublisher({ socket, operation: async () => {
                entered();
                await held;
            } });
            await started;
            clockMs = startedAt + 60_000;
            const inFlight = heartbeat();
            for (const offset of [1_000, 2_000]) {
                clockMs = startedAt + 60_000 + offset;
                await heartbeat();
            }
            clockMs = startedAt + 63_000;
            if (replacePublisher) {
                await presence.registerPublisher({ socket: {}, binding, completeActivitySnapshot: { state: "unknown", activeCount: 0 } });
            }
            release();
            await Promise.all([holder, inFlight]);
            clockMs = startedAt + 123_000;
            await vi.advanceTimersByTimeAsync(60_000);
            await presence.runAsCurrentPublisher({ socket, operation: async () => null });
            await vi.waitFor(async () => {
                const persisted = await db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { active: true, lastActiveAt: true },
                });
                expect(persisted).toEqual({ active: true, lastActiveAt: new Date(startedAt + (replacePublisher ? 63_000 : 62_000)) });
            });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            release();
            now.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each([false, true])("persists newest released liveness without rewriting the turn projection (new heartbeat: %s)", async (receiveNewerHeartbeat) => {
        const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
        let clockMs = startedAt;
        const presence = createSessionPublisherPresence({ now: () => new Date(clockMs) });
        const blocker = await createReleasedAliveSession(() => clockMs, presence);
        const target = await createReleasedAliveSession(() => clockMs, presence);
        // Even a heartbeat matching a durable historical turn is not a turn
        // mutation or repair request. Only the canonical turn writer projects it.
        const turnId = randomUUID();
        const terminalObservedAt = startedAt + 1_000;
        await db.sessionTurn.create({ data: {
            sessionId: target.sessionId, turnId, status: "completed",
            startedAt: BigInt(startedAt), updatedAt: BigInt(terminalObservedAt), terminalAt: BigInt(terminalObservedAt),
        } });
        await db.session.update({ where: { id: target.sessionId }, data: {
            latestTurnId: turnId, latestTurnStatus: "running", latestTurnStatusObservedAt: BigInt(startedAt),
        } });
        const observer = createAuthenticatedFakeSocket({ id: randomUUID() });
        const observerConnection: ClientConnection = {
            connectionType: "session-scoped", socket: observer as never,
            userId: target.binding.accountId, sessionId: target.sessionId,
        };
        eventRouter.clearIo();
        eventRouter.addConnection(target.binding.accountId, observerConnection);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        try {
            await blocker.heartbeat();
            const holder = presence.runAsCurrentPublisher({ socket: blocker.socket, operation: async () => {
                entered();
                await held;
            } });
            await started;
            clockMs += 60_000;
            const blockerAlive = blocker.heartbeat();
            await Promise.resolve();
            const targetAlive = target.heartbeat();
            clockMs += 10_000;
            if (receiveNewerHeartbeat) {
                await getSocketHandler(target.socket, "session-alive")({
                    sid: target.sessionId, time: clockMs, thinking: false,
                    latestTurnStatus: "completed", latestTurnStatusObservedAt: terminalObservedAt,
                });
            }
            // Waiting for admission does not constitute a new observation.
            clockMs += 10_000;
            release();
            await Promise.all([holder, blockerAlive, targetAlive]);
            const expectedObservationMs = startedAt + 60_000 + (receiveNewerHeartbeat ? 10_000 : 0);
            await expect(db.session.findUniqueOrThrow({
                where: { id: target.sessionId }, select: { active: true, lastActiveAt: true, latestTurnStatus: true },
            })).resolves.toEqual({
                active: true, lastActiveAt: new Date(expectedObservationMs),
                latestTurnStatus: "running",
            });
            await vi.waitFor(() => {
                const activeUpdates = observer.emit.mock.calls.flatMap(([event, payload]) => {
                    if (event !== "update") return [];
                    const parsed = UpdateContainerSchema.safeParse(payload);
                    return parsed.success && parsed.data.body.t === "update-session"
                        && parsed.data.body.id === target.sessionId && typeof parsed.data.body.activeAt === "number"
                        ? [parsed.data.body.activeAt] : [];
                });
                expect(activeUpdates).toEqual([expectedObservationMs]);
            });
        } finally {
            release();
            await getSocketHandler(target.socket, "disconnect")();
            eventRouter.removeConnection(target.binding.accountId, observerConnection);
            clock.mockRestore();
        }
    });

    it("does not register a disconnected socket after an accepted released heartbeat backlog", async () => {
        let clockMs = Date.parse("2026-07-22T08:00:00.000Z");
        const presence = createSessionPublisherPresence({ now: () => new Date(clockMs) });
        const blocker = await createReleasedAliveSession(() => clockMs, presence);
        const target = await createReleasedAliveSession(() => clockMs, presence);
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        try {
            await blocker.heartbeat();
            const holder = presence.runAsCurrentPublisher({ socket: blocker.socket, operation: async () => {
                entered();
                await held;
            } });
            await started;
            clockMs += 60_000;
            const blockerAlive = blocker.heartbeat();
            await Promise.resolve();
            const targetAlive = target.heartbeat();
            await target.socket.handlers.get("disconnect")?.();
            await presence.forgetDisconnectedPublisher({ socket: target.socket });
            release();
            await Promise.all([holder, blockerAlive, targetAlive]);
            await expect(db.session.findUniqueOrThrow({
                where: { id: target.sessionId }, select: { active: true },
            })).resolves.toEqual({ active: false });
        } finally {
            release();
            now.mockRestore();
        }
    });

    it.each([
        { sessionTimeoutMs: 600_000, retryCeilingMs: 60_000 },
        { sessionTimeoutMs: 35_000, retryCeilingMs: 17_500 },
    ])("bounds released alive retry backoff to $retryCeilingMs ms for a $sessionTimeoutMs ms presence expiry", async ({ sessionTimeoutMs, retryCeilingMs }) => {
        process.env.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS = String(sessionTimeoutMs);
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = "1000";
        process.env.HAPPIER_DB_TX_TIMEOUT_MS = "30000";
        let clockMs = Date.parse("2026-07-22T08:00:00.000Z");
        const { sessionId, heartbeat } = await createReleasedAliveSession(() => clockMs);
        const initial = await db.session.findUniqueOrThrow({
            where: { id: sessionId }, select: { active: true, lastActiveAt: true },
        });
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        try {
            let releaseHolder!: () => void;
            const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
            let resolveHolderEntered!: () => void;
            const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
            const holderReleased = new Error("release acquisition holder");
            const holder = inTx(async () => {
                resolveHolderEntered();
                await holderRelease;
                throw holderReleased;
            });
            await holderEntered;
            try {
                // Preserve the destination's 2s exponential base and force its existing ceiling.
                for (const advanceMs of [0, 0, 2_000, 4_000, 8_000, 16_000, 32_000]) {
                    clockMs += advanceMs;
                    await heartbeat();
                }
            } finally {
                releaseHolder();
                await expect(holder).rejects.toBe(holderReleased);
            }
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true, lastActiveAt: true },
            })).resolves.toEqual(initial);
            clockMs += retryCeilingMs - 1;
            await heartbeat();
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true, lastActiveAt: true },
            })).resolves.toEqual(initial);
            clockMs += 1;
            await heartbeat();
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true, lastActiveAt: true },
            })).resolves.toEqual({ active: true, lastActiveAt: new Date(clockMs) });
        } finally {
            now.mockRestore();
        }
    });

    it("does not let concurrent released alive sockets exhaust the single SQLite transaction connection", async () => {
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = "1000";

        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const presence = createSessionPublisherPresence();
        const sockets = [] as Array<Readonly<{ sessionId: string; alive: (value: unknown) => Promise<void> }>>;

        for (let index = 0; index < 12; index += 1) {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    active: false,
                    lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                    runtimeActivityState: "unknown",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: 0n,
                },
                select: { id: true },
            });
            await db.accessKey.create({
                data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
            });
            const socket = createAuthenticatedFakeSocket();
            sessionUpdateHandler(
                owner.id,
                socket as never,
                {
                    connectionType: "session-scoped",
                    socket,
                    userId: owner.id,
                    sessionId: session.id,
                } as never,
                {
                    presence,
                    binding: { accountId: owner.id, machineId, sessionId: session.id },
                },
            );
            const handler = getSocketHandler(socket, "session-alive");
            const alive = async (value: unknown): Promise<void> => {
                await handler(value);
            };
            sockets.push({ sessionId: session.id, alive });
        }

        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        let resolveHolderEntered!: () => void;
        const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
        const holder = inTx(async () => {
            resolveHolderEntered();
            await holderRelease;
        });
        await holderEntered;

        const releaseTimer = setTimeout(releaseHolder, 850);
        try {
            await Promise.all(sockets.map(({ sessionId, alive }) => alive({
                sid: sessionId,
                time: Date.now(),
                thinking: false,
            })));
        } finally {
            clearTimeout(releaseTimer);
            releaseHolder();
            await holder;
        }

        await expect(db.session.count({
            where: {
                id: { in: sockets.map(({ sessionId }) => sessionId) },
                active: true,
            },
        })).resolves.toBe(sockets.length);
    });

    it("orders exact close behind an already accepted released alive backlog", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const createSession = async () => {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    active: false,
                    lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                    runtimeActivityState: "unknown",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: 0n,
                },
                select: { id: true },
            });
            await db.accessKey.create({
                data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
            });
            return session;
        };
        const blocker = await createSession();
        const target = await createSession();
        const presence = createSessionPublisherPresence();
        const blockerSocket = createAuthenticatedFakeSocket();
        const targetSocket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            blockerSocket as never,
            {
                connectionType: "session-scoped",
                socket: blockerSocket,
                userId: owner.id,
                sessionId: blocker.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: blocker.id },
            },
        );
        sessionUpdateHandler(
            owner.id,
            targetSocket as never,
            {
                connectionType: "session-scoped",
                socket: targetSocket,
                userId: owner.id,
                sessionId: target.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: target.id },
            },
        );

        await getSocketHandler(blockerSocket, "session-runtime-activity-snapshot")({
            sessionId: blocker.id,
            mutationId: `runtime-activity-snapshot:${blocker.id}`,
            snapshot: { state: "active", activeCount: 1 },
        }, () => {});
        let resolveBlockerEntered!: () => void;
        const blockerEntered = new Promise<void>((resolve) => { resolveBlockerEntered = resolve; });
        let releaseBlocker!: () => void;
        const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const heldBlockerOperation = presence.runAsCurrentPublisher({
            socket: blockerSocket,
            operation: async () => {
                resolveBlockerEntered();
                await blockerRelease;
            },
        });
        await blockerEntered;

        const blockerAlive = getSocketHandler(blockerSocket, "session-alive")({
            sid: blocker.id,
            time: Date.now(),
            thinking: false,
        });
        await Promise.resolve();
        const targetAlive = getSocketHandler(targetSocket, "session-alive")({
            sid: target.id,
            time: Date.now(),
            thinking: false,
        });
        const closeAcknowledgements: unknown[] = [];
        const targetClose = getSocketHandler(targetSocket, "session-runtime-activity-close")(
            { sessionId: target.id },
            (value: unknown) => closeAcknowledgements.push(value),
        );

        releaseBlocker();
        await Promise.all([heldBlockerOperation, blockerAlive, targetAlive, targetClose]);

        expect(closeAcknowledgements).toEqual([{ status: "closed", sessionId: target.id }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: target.id },
            select: { active: true, runtimeActivityState: true },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: "unknown",
        });
    });

    it.each([
        { event: 'pending-delivery-accepted-v1', code: 'P2028' },
        { event: 'pending-materialize-next', code: 'P2024' },
        { event: 'pending-materialize-next', code: 'P2010' },
    ])("preserves the recovery outcome for $event ($code)", async ({ event, code }) => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-08-14T12:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });

        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: session.id },
            },
        );
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const previousMaxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        const transactionError = Object.assign(
            new Error(code === 'P2010' ? 'private-sql-fixture' : "Transaction API error: Unable to start a transaction in the given time."),
            { code, meta: code === 'P2010' ? { code: '57014', message: 'private-sql-fixture' }
                : { error: "Unable to start a transaction in the given time." } },
        );
        const originalTransaction = db.$transaction;
        const transaction = vi.fn().mockRejectedValueOnce(transactionError);
        const diagnostic = vi.spyOn(logger, 'error').mockImplementation(() => {});
        // Prisma's overloaded transaction boundary cannot be represented by one Vitest mock signature.
        db.$transaction = transaction as unknown as typeof db.$transaction;
        const unavailableAcknowledgements: unknown[] = [];
        try {
            await getSocketHandler(socket, event)(event === 'pending-materialize-next'
                ? { sid: session.id, deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready' }
                : { v: 1, sessionId: session.id, localId: 'pending-1' },
            (value: unknown) => unavailableAcknowledgements.push(value));
            if (code === 'P2010') {
                expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
                    module: 'websocket', event: 'pending-materialization-failed', phase: 'materialization',
                    sessionId: session.id, errorCode: 'P2010', sqlState: '57014',
                }), expect.any(String));
                expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-sql-fixture');
            }
        } finally {
            diagnostic.mockRestore();
            db.$transaction = originalTransaction;
            if (previousMaxRetries === undefined) {
                delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            } else {
                process.env.HAPPIER_DB_TX_MAX_RETRIES = previousMaxRetries;
            }
        }

        expect(unavailableAcknowledgements).toEqual([{
            ok: false,
            error: code === 'P2010' ? 'internal' : "transaction-unavailable",
            ...(code === 'P2010' ? {} : { retryAfterMs: 1_000 }),
            ...(event === 'pending-delivery-accepted-v1' ? { correlationId: expect.stringMatching(/^[A-Za-z0-9_.:-]{1,160}$/u) } : {}),
        }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);

        const continuedAcknowledgements: unknown[] = [];
        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: session.id,
            localId: "pending-1",
        }, (value: unknown) => continuedAcknowledgements.push(value));
        expect(continuedAcknowledgements).toEqual([{ ok: false, error: "not-found" }]);
    });
});
