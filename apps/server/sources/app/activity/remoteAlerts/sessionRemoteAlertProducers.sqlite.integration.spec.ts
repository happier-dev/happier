import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    deriveAccountRemoteAlertPolicyV1,
    type ActivityRemoteAlertV2,
    type DeviceRemoteAlertPolicyV1,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { createSessionPublisherPresence, expireSessionPublisherCandidates, type CurrentSessionPublisherAuthority } from "@/app/presence/sessionPublisherPresence";
import { isProjectedSessionStalledV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { buildAgentEventLocalId } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { setAccountSessionFollow } from '@/app/session/follow/accountFollowService';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';

const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: "ok" }))));

vi.mock("expo-server-sdk", () => {
    class Expo {
        static isExpoPushToken() { return true; }
        chunkPushNotifications(messages: unknown[]) { return [messages]; }
        async sendPushNotificationsAsync(chunk: unknown[]) { return await sendPushNotificationsAsyncSpy(chunk); }
        async getPushNotificationReceiptsAsync() { return {}; }
    }
    return { __esModule: true, Expo };
});

const { setSessionResponsibility: setSessionResponsibilityWithAuthentication } = await import("@/app/session/access/sessionResponsibilityService");
const { publishSessionReadyProjectionUpdate } = await import("@/app/session/ready/publishSessionReadyProjectionUpdate");
const {
    applySessionTurnMutation: applySessionTurnMutationWithAuthentication,
    createSessionMessage,
    updateSessionAgentState,
} = await import("@/app/session/sessionWriteService");
const { machineUpdateHandler } = await import("@/app/api/socket/machineUpdateHandler");
const { sessionUpdateHandler } = await import("@/app/api/socket/sessionUpdateHandler");

const presentUserAuthentication = createPresentUserSessionAccessAuthentication();

async function setSessionResponsibility(
    input: Omit<Parameters<typeof setSessionResponsibilityWithAuthentication>[0], "authentication">,
) {
    return await setSessionResponsibilityWithAuthentication({
        ...input,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
    });
}

async function applySessionTurnMutation(
    input: Omit<Parameters<typeof applySessionTurnMutationWithAuthentication>[0], "authentication">,
) {
    return await applySessionTurnMutationWithAuthentication({
        ...input,
        authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
    });
}

const DEVICE_POLICY: DeviceRemoteAlertPolicyV1 = {
    v: 1, enabled: true, nativeConsumer: "ios_service_extension_v1",
    quietHoursOverride: { mode: "account" }, foregroundBehavior: "account",
    previewCeiling: "account", soundVolume: 1,
};

async function enrollRemoteAlerts(accountId: string): Promise<string> {
    const settings = JSON.stringify({
        sessionRemoteAlertsEnabled: true,
        attentionDeliveryPolicyV1: DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    });
    const policy = deriveAccountRemoteAlertPolicyV1(JSON.parse(settings));
    const account = await db.account.update({
        where: { id: accountId }, data: { settings, settingsVersion: { increment: 1 } },
        select: { settingsVersion: true },
    });
    await db.account.update({
        where: { id: accountId },
        data: { remoteAlertPolicy: { settingsVersion: account.settingsVersion, policy } },
    });
    const token = `ExponentPushToken[${accountId}]`;
    await db.accountPushToken.create({ data: { accountId, token, remoteAlerts: DEVICE_POLICY } });
    return token;
}

async function registerRuntimePublisher(params: Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
}>): Promise<CurrentSessionPublisherAuthority> {
    await db.accessKey.create({ data: { ...params, data: "encrypted" } });
    const registration = await createSessionPublisherPresence().registerPublisher({
        socket: {},
        binding: params,
        completeActivitySnapshot: { state: "unknown", activeCount: 0 },
    });
    if (registration.status !== "registered") throw new Error("expected publisher registration");
    return { ...params, committedFence: registration.committedFence };
}

function readSubmittedAlerts(): ActivityRemoteAlertV2[] {
    return sendPushNotificationsAsyncSpy.mock.calls
        .flatMap(([chunk]) => chunk as Array<{ data: ActivityRemoteAlertV2 }>)
        .map((message) => message.data)
        .filter((data): data is ActivityRemoteAlertV2 => data?.type === "activity_alert" && data.v === 2);
}

async function submittedAlerts(): Promise<ActivityRemoteAlertV2[]> {
    // Producers schedule the transport after commit and may schedule multiple
    // attention deliveries. Wait for
    // the call set to settle instead of returning after the first transport.
    let lastCount = -1;
    let stablePasses = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const count = sendPushNotificationsAsyncSpy.mock.calls.length;
        stablePasses = count === lastCount ? stablePasses + 1 : 0;
        if (count > 0 && stablePasses >= 3) break;
        lastCount = count;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return readSubmittedAlerts();
}

function submittedBodies(): string[] {
    return sendPushNotificationsAsyncSpy.mock.calls.flatMap(([messages]) =>
        (messages as Array<{ body?: string }>).flatMap((message) =>
            typeof message.body === "string" ? [message.body] : []));
}

function submittedTokens(): string[] {
    return sendPushNotificationsAsyncSpy.mock.calls
        .flatMap(([chunk]) => chunk as Array<{ to: string; data?: { type?: string } }>)
        .filter((message) => message.data?.type === "activity_alert")
        .map((message) => message.to);
}

describe("committed session mutations produce Home remote alerts", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "remote-alert-producers-", initAuth: false,
            env: {
                HAPPIER_SERVER_IDENTITY_ID: "srv_home_a",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "true",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => { sendPushNotificationsAsyncSpy.mockClear(); });

    it.each([undefined, 'rich_sender', 'home_required'] as const)('threads exact socket sender declaration %s through committed transcript messages', async declaration => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const follower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', kind: 'persistent' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: follower.id, accessLevel: 'view' } });
        await db.accountSessionFollow.createMany({ data: [owner, follower].map(account => ({ accountId: account.id,
            sessionId: session.id, following: true,
            followPolicy: JSON.stringify({ preset: 'custom', events: { message: { delivery: 'interrupt' },
                failed_or_stopped: { delivery: 'interrupt' } } }) })) });
        await Promise.all([owner, follower].map(account => enrollRemoteAlerts(account.id)));
        const socket = createFakeSocket({ data: { authAuthority: 'present_user', clientType: 'session-scoped', sessionId: session.id } });
        const presence = createSessionPublisherPresence();
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
        const registration = await presence.registerPublisher({ socket, binding,
            completeActivitySnapshot: { state: 'unknown', activeCount: 0 } });
        expect(registration.status).toBe('registered');
        const transportSocket = socket as unknown as Parameters<typeof sessionUpdateHandler>[1];
        sessionUpdateHandler(owner.id, transportSocket, { connectionType: 'session-scoped', socket: transportSocket,
            userId: owner.id, sessionId: session.id }, { presence, binding });
        const stateAck = vi.fn();
        await getSocketHandler(socket, 'update-state')({ sid: session.id, agentState: '{}', expectedVersion: 0,
            activitySummaryV1: { ...(declaration ? { ownerActivityDelivery: declaration } : {}) } }, stateAck);
        expect(stateAck).toHaveBeenCalledWith(expect.objectContaining({ result: 'success' }));
        // Later ordinary snapshots need not repeat the host's sender declaration.
        await getSocketHandler(socket, 'update-state')({ sid: session.id, agentState: '{}', expectedVersion: 1,
            activitySummaryV1: {} }, stateAck);
        expect(stateAck).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'success' }));
        const acknowledgement = vi.fn();
        await getSocketHandler(socket, 'transcript-observation-v1')({ v: 1, sessionId: session.id,
            localId: `agent-${randomUUID()}`, messageRole: 'agent', sidechainId: null,
            createdAt: Date.now(), updatedAt: Date.now(), provenance: { kind: 'non_dependent', source: 'external' },
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Committed answer' } } },
        }, acknowledgement);
        expect(acknowledgement).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: 'observed', didWrite: true }));
        const alerts = (await submittedAlerts()).filter(alert => alert.sessionId === session.id && alert.event.type === 'message');
        expect(alerts.map(alert => alert.accountId).sort()).toEqual((declaration === 'rich_sender' ? [follower.id] : [owner.id, follower.id]).sort());
        sendPushNotificationsAsyncSpy.mockClear();
        const legacyAck = vi.fn();
        await getSocketHandler(socket, 'message')({ sid: session.id, localId: `legacy-agent-${randomUUID()}`, messageRole: 'agent',
            message: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Legacy ingress answer' } } } }, legacyAck);
        expect(legacyAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true, didWrite: true }));
        await vi.waitFor(() => expect(readSubmittedAlerts()
            .filter(alert => alert.sessionId === session.id && alert.event.type === 'message')
            .map(alert => alert.accountId).sort()).toEqual((declaration === 'rich_sender' ? [follower.id] : [owner.id, follower.id]).sort()));
        sendPushNotificationsAsyncSpy.mockClear();
        const userAck = vi.fn();
        await getSocketHandler(socket, 'transcript-observation-v1')({ v: 1, sessionId: session.id,
            localId: `observed-user-${randomUUID()}`, messageRole: 'user', sidechainId: null,
            createdAt: Date.now(), updatedAt: Date.now(), provenance: { kind: 'non_dependent', source: 'external' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Native observed input without a human receipt' } } },
        }, userAck);
        expect(userAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: 'observed', didWrite: true }));
        // Badge/wake transport can settle before this after-commit material
        // alert; wait for the exact owned output, not another channel's count.
        await vi.waitFor(() => expect(readSubmittedAlerts()
            .filter(alert => alert.sessionId === session.id && alert.event.type === 'message')
            .map(alert => alert.accountId).sort()).toEqual([owner.id, follower.id].sort()));
        sendPushNotificationsAsyncSpy.mockClear();
        const turnId = randomUUID();
        const turnAck = vi.fn();
        await getSocketHandler(socket, 'session-turn-mutation')({ v: 1, sessionId: session.id,
            mutationId: randomUUID(), action: 'begin', turnId, observedAt: Date.now() }, turnAck);
        expect(turnAck).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'success', applied: true }));
        const observedAt = Date.now();
        await getSocketHandler(socket, 'session-turn-mutation')({ v: 1, sessionId: session.id,
            mutationId: randomUUID(), action: 'fail', turnId, observedAt, issue: {
                v: 1, scope: 'primary_session', status: 'failed', code: 'opencode_prompt_submission_failed',
                source: 'agent_session_error', occurredAt: observedAt, provider: 'opencode', sanitizedPreview: 'test',
            } }, turnAck);
        expect(turnAck).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'success', applied: true }));
        const terminalAlerts = (await submittedAlerts()).filter(alert => alert.sessionId === session.id && alert.event.type === 'failed');
        expect(terminalAlerts.map(alert => alert.accountId).sort()).toEqual((declaration === 'rich_sender' ? [follower.id] : [owner.id, follower.id]).sort());
    });

    it.each(['important', 'quiet', 'off'] as const)('publishes one exact presence/Turn stalled original at %s treatment and settles on recovery', async preset => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const presence = createSessionPublisherPresence();
        const socket = {};
        const registered = await presence.registerPublisher({ socket, binding: { accountId: owner.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } });
        if (registered.status !== 'registered') throw new Error('Expected real publisher');
        const turnId = randomUUID();
        expect(await applySessionTurnMutation({ actorUserId: owner.id, mutation: { v: 1, sessionId: session.id,
            mutationId: randomUUID(), action: 'begin', turnId, observedAt: Date.now() } })).toMatchObject({ ok: true });
        await setAccountSessionFollow({ accountId: owner.id, sessionId: session.id, authentication: presentUserAuthentication,
            preferences: { policy: preset === 'off' ? { preset: 'custom', events: { stalled: { delivery: 'off' } } } : { preset } } });
        await enrollRemoteAlerts(owner.id);
        const messagesBefore = await db.sessionMessage.count({ where: { sessionId: session.id } });
        const candidates = [{ sessionId: session.id, observedFence: registered.committedFence }];
        expect(await expireSessionPublisherCandidates({ candidates })).toMatchObject([{ status: 'expired' }]);
        const alerts = await submittedAlerts();
        expect(alerts.filter(alert => alert.sessionId === session.id)).toEqual(preset === 'important' ? [expect.objectContaining({
            event: { type: 'source_unavailable', stalledOccurrence: { turnId, publisherFence: registered.committedFence.getTime() } },
        })] : []);
        expect(await expireSessionPublisherCandidates({ candidates })).toEqual([{ status: 'stale', sessionId: session.id }]);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(messagesBefore);
        expect(isProjectedSessionStalledV1(await db.session.findUniqueOrThrow({ where: { id: session.id } }))).toBe(true);
        expect(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
        // The Inbox/Work source is the existing projection, not a retained notice.
        expect(isProjectedSessionStalledV1(await db.session.findUniqueOrThrow({ where: { id: session.id } }))).toBe(false);
        expect((await submittedAlerts()).filter(alert => alert.sessionId === session.id)).toHaveLength(preset === 'important' ? 1 : 0);
    });

    it('withdraws a stalled original when recovery wins during dispatch preparation', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        const presence = createSessionPublisherPresence();
        const socket = {};
        const registered = await presence.registerPublisher({ socket, binding: { accountId: owner.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } });
        if (registered.status !== 'registered') throw new Error('Expected real publisher');
        expect(await applySessionTurnMutation({ actorUserId: owner.id, mutation: { v: 1, sessionId: session.id,
            mutationId: randomUUID(), action: 'begin', turnId: randomUUID(), observedAt: Date.now() } })).toMatchObject({ ok: true });
        await enrollRemoteAlerts(owner.id);
        // A real DB boundary delays preparation; all policy/presence logic remains real.
        const tokenDelegate = db.accountPushToken;
        const originalFindTokens = tokenDelegate.findMany;
        const findTokens = originalFindTokens.bind(tokenDelegate);
        let recovered = false;
        const gate = vi.spyOn(tokenDelegate, 'findMany').mockImplementation(args => Object.assign((async () => {
            const tokens = await findTokens(args);
            if (!recovered && args?.select?.remoteAlerts === true) {
                expect(await presence.touchPublisher({ socket })).toMatchObject({ status: 'touched' });
                recovered = true;
            }
            return tokens;
        })(), { [Symbol.toStringTag]: 'PrismaPromise' as const })); // Preserve the DB adapter's public promise brand at this boundary.
        try {
            await expireSessionPublisherCandidates({ candidates: [{ sessionId: session.id, observedFence: registered.committedFence }] });
            await vi.waitFor(() => expect(recovered).toBe(true));
            expect((await submittedAlerts()).filter(alert => alert.sessionId === session.id)).toEqual([]);
        } finally {
            gate.mockRestore();
            // Prisma exposes virtual methods without their value in the own
            // descriptor; Vitest restoration alone shadows the real method.
            Object.defineProperty(tokenDelegate, 'findMany', { configurable: true, writable: true, value: originalFindTokens });
        }
    });

    it.each(['plain', 'e2ee'] as const)('routes committed %s Goal/update originals through the same personal policy and exact message reference', async encryptionMode => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode } });
        const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: viewer.id, accessLevel: 'view' } });
        const publisherAuthority = await registerRuntimePublisher({ accountId: owner.id, machineId: machine.id, sessionId: session.id });
        await enrollRemoteAlerts(viewer.id);
        await setAccountSessionFollow({ accountId: viewer.id, sessionId: session.id, authentication: presentUserAuthentication,
            preferences: { policy: { preset: 'custom', events: { update_posted: { delivery: 'interrupt' } } } } });
        const publish = (type: 'goal-changed' | 'worker-report', localId = buildAgentEventLocalId(type, [randomUUID()])) =>
            createSessionMessage({ inputAdmission: 'transcriptOnly', actorUserId: owner.id, sessionId: session.id,
                publisherAuthority, localId, messageRole: 'event',
                content: encryptionMode === 'plain' ? { t: 'plain', v: { role: 'agent', content: { type: 'event', id: localId,
                    data: type === 'goal-changed' ? { type } : { type, summary: 'Private published result' } } } }
                    : { t: 'encrypted', c: 'sealed-original' } });
        expect(await publish('goal-changed')).toMatchObject({ ok: true, didWrite: true });
        expect(await submittedAlerts()).toEqual([]);
        const localId = buildAgentEventLocalId('worker-report', [randomUUID()]);
        const published = await publish('worker-report', localId);
        expect(published).toMatchObject({ ok: true, didWrite: true });
        if (!published.ok) throw new Error('Expected committed original');
        expect(await submittedAlerts()).toEqual([expect.objectContaining({ accountId: viewer.id, sessionId: session.id,
            event: { type: 'message', sequenceDomain: 'session_transcript', messageSeq: published.message.seq } })]);
        expect(submittedBodies().join(' ')).not.toContain('Private published result');
        sendPushNotificationsAsyncSpy.mockClear();
        expect(await publish('worker-report', localId)).toMatchObject({ ok: true, didWrite: false });
        expect(await submittedAlerts()).toEqual([]);
    });

    it("alerts the assignment target through default rules without enrolling Follow or read state", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const assignee = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: assignee.id, accessLevel: "view",
        } });
        await enrollRemoteAlerts(owner.id);
        await enrollRemoteAlerts(assignee.id);

        const result = await setSessionResponsibility({
            actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: assignee.id,
        });
        expect(result).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        expect(await submittedAlerts()).toEqual([expect.objectContaining({
            sessionId: session.id, accountId: assignee.id, event: { type: "assigned" },
        })]);
        expect(submittedBodies()).toEqual(["A session was assigned to you."]);
        const where = { accountId_sessionId: { accountId: assignee.id, sessionId: session.id } };
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        expect(await db.accountSessionReadState.findUnique({ where })).toBeNull();

        // Re-submitting the current desired state is a no-op and alerts nobody.
        sendPushNotificationsAsyncSpy.mockClear();
        await setSessionResponsibility({ actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: assignee.id });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sendPushNotificationsAsyncSpy.mock.calls).toEqual([]);

        // A different applicable operational default is the same canonical rule
        // contract, rather than an assignment-Boolean fallback in this producer.
        await setSessionResponsibility({ actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: null });
        await db.account.update({ where: { id: assignee.id }, data: {
            sessionAutoFollowAssigned: false, sessionAutoFollowDirect: true,
        } });
        await setSessionResponsibility({ actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: assignee.id });
        expect(await submittedAlerts()).toEqual([expect.objectContaining({ accountId: assignee.id, event: { type: 'assigned' } })]);
        expect(await db.accountSessionFollow.findUnique({ where })).toBeNull();
        expect(await db.accountSessionReadState.findUnique({ where })).toBeNull();
    });

    it("does not claim assignment caused Follow when the assignee already followed", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const assignee = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: assignee.id, accessLevel: "view",
        } });
        await db.accountSessionFollow.create({ data: {
            sessionId: session.id, accountId: assignee.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        await enrollRemoteAlerts(assignee.id);

        const result = await setSessionResponsibility({
            actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: assignee.id,
        });
        expect(result).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        expect(await submittedAlerts()).toHaveLength(1);
        expect(submittedBodies()).toEqual(["A session was assigned to you."]);
    });

    it.each([
        ["disabled auto-Follow", false],
        ["explicit Unfollow", true],
    ] as const)("keeps assignment in-app but sends no remote alert after %s", async (_scenario, explicitUnfollow) => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const assignee = await db.account.create({
            data: {
                publicKey: randomUUID(),
                sessionAutoFollowAssigned: explicitUnfollow,
            },
        });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: assignee.id, accessLevel: "view",
        } });
        if (explicitUnfollow) {
            await db.accountSessionFollow.create({ data: {
                sessionId: session.id,
                accountId: assignee.id,
                following: false,
                followPolicy: null,
            } });
        }
        await enrollRemoteAlerts(assignee.id);

        const result = await setSessionResponsibility({
            actorAccountId: owner.id,
            sessionId: session.id,
            responsibleAccountId: assignee.id,
        });
        expect(result).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sendPushNotificationsAsyncSpy.mock.calls).toEqual([]);
        expect(await db.session.findUnique({
            where: { id: session.id },
            select: { responsibleAccountId: true },
        })).toEqual({ responsibleAccountId: assignee.id });
    });

    it("does not notify or enroll the actor about their own self-assignment", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await enrollRemoteAlerts(owner.id);

        const result = await setSessionResponsibility({
            actorAccountId: owner.id, sessionId: session.id, responsibleAccountId: owner.id,
        });
        expect(result).toMatchObject({ ok: true, changed: true, autoFollowed: false });
        // Self-assignment has no one-shot self notification.
        // The canonical badge coalescer may still publish its content-free
        // projection wake for the responsibility change; that is not an
        // Activity alert and must not be suppressed by this producer contract.
        expect(await submittedAlerts()).toEqual([]);
        const follow = await db.accountSessionFollow.findUnique({
            where: { accountId_sessionId: { accountId: owner.id, sessionId: session.id } },
        });
        expect(follow).toBeNull();
    });

    it.each(['top-level', 'offline-manager'] as const)(
        'presents an Important owner alert only after a %s turn settles', async kind => {
            const owner = await db.account.create({ data: { publicKey: randomUUID() } });
            const observedAt = BigInt(Date.now());
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: '{}', active: true,
                latestTurnId: 'lead-summary', latestTurnStatus: 'completed', latestTurnStatusObservedAt: observedAt,
                runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: observedAt, runtimeActivityRevision: 1n,
            } });
            await enrollRemoteAlerts(owner.id);
            let runtimeComposition: Parameters<typeof publishSessionReadyProjectionUpdate>[0]['runtimeComposition'];
            if (kind === 'offline-manager') {
                const lead = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', active: false } });
                await db.session.update({ where: { id: session.id }, data: { originKind: 'session', originSessionId: lead.id } });
                await db.sessionFollowEdge.create({ data: {
                    sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
                    sourceSessionId: session.id, destinationSessionId: lead.id, relation: 'manager',
                    managerSourceSessionId: session.id, policyJson: '{"preset":"important"}',
                } });
                const machine = await db.machine.create({ data: {
                    id: `machine-${randomUUID()}`, accountId: owner.id, metadata: '{}', kind: 'persistent',
                } });
                const publisherAuthority = await registerRuntimePublisher({
                    accountId: owner.id, machineId: machine.id, sessionId: session.id,
                });
                runtimeComposition = { publisherAuthority, ownerActivityDelivery: 'rich_sender' };
                await db.session.update({ where: { id: session.id }, data: {
                    runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
                } });
            }
            const publish = (seq: number) => publishSessionReadyProjectionUpdate({
                sessionId: session.id, readyProjection: { latestReadyEventSeq: seq, latestReadyEventAt: Date.now() },
                runtimeComposition,
            });
            await publish(8);
            await db.session.update({ where: { id: session.id }, data: {
                runtimeActivityState: 'idle', runtimeActivityActiveCount: 0, runtimeActivityRevision: 2n,
            } });
            await publish(9);

            expect((await submittedAlerts()).filter(alert => alert.sessionId === session.id)).toEqual([
                expect.objectContaining({ accountId: owner.id,
                    event: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 9 } }),
            ]);
        });

    it("alerts a follower on ready and leaves the owner to a trusted persistent runtime's rich sender", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const follower = await db.account.create({ data: { publicKey: randomUUID() } });
        const machine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`, accountId: owner.id, metadata: "{}", kind: "persistent",
        } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id, accessLevel: "view",
        } });
        await db.accountSessionFollow.create({ data: {
            sessionId: session.id, accountId: follower.id, following: true,
            followPolicy: JSON.stringify({ preset: 'everything' }),
        } });
        await db.accountSessionFollow.create({ data: {
            sessionId: session.id, accountId: owner.id, following: true,
            followPolicy: JSON.stringify({ preset: 'everything' }),
        } });
        await enrollRemoteAlerts(owner.id);
        await enrollRemoteAlerts(follower.id);
        const publisherAuthority = await registerRuntimePublisher({
            accountId: owner.id, machineId: machine.id, sessionId: session.id,
        });

        await publishSessionReadyProjectionUpdate({
            sessionId: session.id,
            readyProjection: { latestReadyEventSeq: 9, latestReadyEventAt: Date.now() },
            runtimeComposition: {
                publisherAuthority,
                ownerActivityDelivery: "rich_sender",
            },
        });

        expect(await submittedAlerts()).toEqual([expect.objectContaining({
            sessionId: session.id, accountId: follower.id,
            event: { type: "ready", sequenceDomain: "session_transcript", messageSeq: 9 },
        })]);
    });

    it.each(["ephemeral_session_runner", null] as const)(
        "keeps the Session owner and eligible collaborator on the Home leg when the committed ready event has %s rich-sender custody",
        async (machineKind) => {
            const owner = await db.account.create({ data: { publicKey: randomUUID() } });
            const follower = await db.account.create({ data: { publicKey: randomUUID() } });
            const machine = machineKind === null ? null : await db.machine.create({ data: {
                id: `machine-${randomUUID()}`, accountId: owner.id, metadata: "{}", kind: machineKind,
            } });
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
            await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id, accessLevel: "view",
            } });
            await db.accountSessionFollow.create({ data: {
                sessionId: session.id, accountId: follower.id, following: true,
                followPolicy: JSON.stringify({ preset: 'everything' }),
            } });
            await db.accountSessionFollow.create({ data: { sessionId: session.id, accountId: owner.id,
                following: true, followPolicy: JSON.stringify({ preset: 'everything' }) } });
            const [ownerToken, followerToken] = await Promise.all([
                enrollRemoteAlerts(owner.id),
                enrollRemoteAlerts(follower.id),
            ]);

            await publishSessionReadyProjectionUpdate({
                sessionId: session.id,
                readyProjection: { latestReadyEventSeq: 10, latestReadyEventAt: Date.now() },
                ...(machine ? { runtimeComposition: {
                    publisherAuthority: {
                        accountId: owner.id, machineId: machine.id, sessionId: session.id,
                        committedFence: session.lastActiveAt,
                    },
                    ownerActivityDelivery: "rich_sender" as const,
                } } : {}),
            });

            expect(await submittedAlerts()).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    sessionId: session.id, accountId: owner.id,
                    event: { type: "ready", sequenceDomain: "session_transcript", messageSeq: 10 },
                }),
                expect.objectContaining({
                    sessionId: session.id, accountId: follower.id,
                    event: { type: "ready", sequenceDomain: "session_transcript", messageSeq: 10 },
                }),
            ]));
            expect(submittedTokens().sort()).toEqual([ownerToken, followerToken].sort());
        },
    );

    it.each(["permission", "user_action"] as const)("alerts an eligible follower after a new %s occurrence commits", async (requestKind) => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const follower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const machine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`, accountId: owner.id, metadata: "{}", kind: "persistent",
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id,
            accessLevel: "edit", canApprovePermissions: true,
        } });
        await db.accountSessionFollow.create({ data: {
            sessionId: session.id, accountId: follower.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        await Promise.all([enrollRemoteAlerts(owner.id), enrollRemoteAlerts(follower.id)]);
        const publisherAuthority = await registerRuntimePublisher({
            accountId: owner.id, machineId: machine.id, sessionId: session.id,
        });
        const turnId = `turn-${randomUUID()}`;
        expect(await applySessionTurnMutation({
            actorUserId: owner.id,
            mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin",
                turnId, observedAt: Date.now(),
            },
        })).toMatchObject({ ok: true });
        const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const occurrence = {
            requestId: randomUUID(), sourceTurnId: turnId, requestKind, occurredAt: Date.now(),
        };
        const update = {
            actorUserId: owner.id, sessionId: session.id,
            expectedVersion: current.agentStateVersion, agentStateCiphertext: "new-request-state",
            pendingPermissionRequestCount: requestKind === "permission" ? 1 : 0,
            pendingUserActionRequestCount: requestKind === "user_action" ? 1 : 0,
            userActionRequiredOccurrences: [occurrence],
            runtimeComposition: {
                publisherAuthority,
                ownerActivityDelivery: "rich_sender" as const,
            },
        };
        expect(await updateSessionAgentState(update)).toMatchObject({ ok: true, version: current.agentStateVersion + 1 });

        expect(await submittedAlerts()).toEqual([expect.objectContaining({
            sessionId: session.id, accountId: follower.id,
            event: { type: requestKind === "permission" ? "permission_request" : "user_action_request", requestId: occurrence.requestId, turnId },
        })]);

        sendPushNotificationsAsyncSpy.mockClear();
        // A lost acknowledgement retries the same CAS. A refreshed producer
        // sends no occurrence for an already known request, even if state or
        // summary counts change. Neither path establishes a new alert.
        expect(await updateSessionAgentState(update)).toMatchObject({ ok: false, error: "version-mismatch" });
        expect(await updateSessionAgentState({
            ...update, expectedVersion: current.agentStateVersion + 1,
            agentStateCiphertext: "refreshed-request-state", userActionRequiredOccurrences: [],
            pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 2,
        })).toMatchObject({ ok: true });
        expect(await submittedAlerts()).toEqual([]);

        // A schema-valid request for a missing or superseded turn is not a
        // current main-turn occurrence, regardless of its pending summary.
        expect(await updateSessionAgentState({
            ...update, expectedVersion: current.agentStateVersion + 2,
            userActionRequiredOccurrences: [{ ...occurrence, sourceTurnId: "missing-turn" }],
        })).toMatchObject({ ok: true });
        expect(await submittedAlerts()).toEqual([]);

        const nextTurnId = `turn-${randomUUID()}`;
        expect(await applySessionTurnMutation({
            actorUserId: owner.id,
            mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin",
                turnId: nextTurnId, observedAt: Date.now(),
            },
        })).toMatchObject({ ok: true });
        const nextTurn = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(await updateSessionAgentState({
            ...update, expectedVersion: nextTurn.agentStateVersion,
            userActionRequiredOccurrences: [{ ...occurrence, requestId: randomUUID() }],
        })).toMatchObject({ ok: true });
        expect(await submittedAlerts()).toEqual([]);

        expect(await applySessionTurnMutation({
            actorUserId: owner.id,
            mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action: "complete",
                turnId: nextTurnId, observedAt: Date.now(),
            },
        })).toMatchObject({ ok: true });
        const settled = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(await updateSessionAgentState({
            ...update, expectedVersion: settled.agentStateVersion,
            userActionRequiredOccurrences: [{ ...occurrence, sourceTurnId: nextTurnId, requestId: randomUUID() }],
        })).toMatchObject({ ok: true });
        expect(await submittedAlerts()).toEqual([]);
    });

    it.each(["permission", "user_action"] as const)(
        "keeps a Runner-owned %s occurrence on the Home leg for the owner and eligible collaborator",
        async (requestKind) => {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const follower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const machine = await db.machine.create({ data: {
                id: `runner-${randomUUID()}`, accountId: owner.id, metadata: "{}", kind: "ephemeral_session_runner",
            } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id,
                accessLevel: "edit", canApprovePermissions: true,
            } });
            await db.accountSessionFollow.create({ data: {
                sessionId: session.id, accountId: follower.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
            } });
            const [ownerToken, followerToken] = await Promise.all([
                enrollRemoteAlerts(owner.id),
                enrollRemoteAlerts(follower.id),
            ]);
            const turnId = `turn-${randomUUID()}`;
            expect(await applySessionTurnMutation({ actorUserId: owner.id, mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin", turnId, observedAt: Date.now(),
            } })).toMatchObject({ ok: true });
            const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            const requestId = randomUUID();
            expect(await updateSessionAgentState({
                actorUserId: owner.id,
                sessionId: session.id,
                expectedVersion: current.agentStateVersion,
                agentStateCiphertext: "runner-request-state",
                pendingPermissionRequestCount: requestKind === "permission" ? 1 : 0,
                pendingUserActionRequestCount: requestKind === "user_action" ? 1 : 0,
                userActionRequiredOccurrences: [{
                    requestId, sourceTurnId: turnId, requestKind, occurredAt: Date.now(),
                }],
                runtimeComposition: {
                    publisherAuthority: {
                        accountId: owner.id, machineId: machine.id, sessionId: session.id,
                        committedFence: session.lastActiveAt,
                    },
                    ownerActivityDelivery: "rich_sender",
                },
            })).toMatchObject({ ok: true });

            const eventType = requestKind === "permission" ? "permission_request" : "user_action_request";
            expect(await submittedAlerts()).toEqual(expect.arrayContaining([
                expect.objectContaining({ accountId: owner.id, sessionId: session.id, event: { type: eventType, requestId, turnId } }),
                expect.objectContaining({ accountId: follower.id, sessionId: session.id, event: { type: eventType, requestId, turnId } }),
            ]));
            expect(submittedTokens().sort()).toEqual([ownerToken, followerToken].sort());
        },
    );

    // Released publishers omitted the newer sender declaration, so their
    // terminal alerts remain Home-owned on persistent Machines and Runners.
    it.each([
        { action: "fail", machineKind: "persistent", expectedOwnerAlert: true },
        { action: "cancel", machineKind: "persistent", expectedOwnerAlert: true },
        { action: "fail", machineKind: "ephemeral_session_runner", expectedOwnerAlert: true },
        { action: "cancel", machineKind: "ephemeral_session_runner", expectedOwnerAlert: true },
    ] as const)(
        "routes a committed $action turn through the $machineKind runtime's actual delivery composition",
        async ({ action, machineKind, expectedOwnerAlert }) => {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const follower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            const machine = await db.machine.create({ data: {
                id: `machine-${randomUUID()}`, accountId: owner.id, metadata: "{}", kind: machineKind,
            } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id, accessLevel: "view",
            } });
            await db.accountSessionFollow.create({ data: {
                sessionId: session.id, accountId: follower.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
            } });
            const [ownerToken, followerToken] = await Promise.all([
                enrollRemoteAlerts(owner.id),
                enrollRemoteAlerts(follower.id),
            ]);
            const publisherAuthority = await registerRuntimePublisher({
                accountId: owner.id, machineId: machine.id, sessionId: session.id,
            });
            const turnId = `turn-${randomUUID()}`;
            expect(await applySessionTurnMutation({ actorUserId: owner.id, mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action: "begin", turnId, observedAt: Date.now(),
            } })).toMatchObject({ ok: true, didApply: true });
            const observedAt = Date.now();
            expect(await applySessionTurnMutation({ actorUserId: owner.id, mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action, turnId, observedAt,
                ...(action === "fail" ? { issue: {
                    v: 1 as const, scope: "primary_session" as const, status: "failed" as const,
                    code: "opencode_prompt_submission_failed" as const, source: "agent_session_error" as const,
                    occurredAt: observedAt, provider: "opencode", sanitizedPreview: "test",
                } } : {}),
            }, runtimeComposition: {
                publisherAuthority,
                ownerActivityDelivery: "rich_sender",
            } })).toMatchObject({ ok: true, didApply: true });

            const alerts = await submittedAlerts();
            expect(alerts).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    sessionId: session.id, accountId: follower.id,
                    event: { type: action === "fail" ? "failed" : "cancelled", turnId },
                }),
                ...(expectedOwnerAlert
                    ? [expect.objectContaining({
                        sessionId: session.id, accountId: owner.id,
                        event: { type: action === "fail" ? "failed" : "cancelled", turnId },
                    })]
                    : []),
            ]));
            expect(submittedTokens().sort()).toEqual(
                (expectedOwnerAlert ? [ownerToken, followerToken] : [followerToken]).sort(),
            );
        },
    );

    it.each([
        ['stopped', 'cancelled'],
        ['failed', 'failed'],
    ] as const)("sends one %s wake-exit push for each admitted Follow preset", async (outcome, event) => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: "{}", kind: "persistent",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
        await db.accessKey.create({ data: { ...binding, data: "encrypted" } });
        const followers = await Promise.all((['everything', 'important', 'quiet'] as const).map(async preset => {
            const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
            await db.sessionGrant.create({ data: { principalKind: 'account',
                sessionId: session.id, createdByAccountId: owner.id, accountId: account.id, accessLevel: "view",
            } });
            await setAccountSessionFollow({
                accountId: account.id, sessionId: session.id, authentication: presentUserAuthentication,
                preferences: { policy: { preset } },
            });
            return { accountId: account.id, token: await enrollRemoteAlerts(account.id), preset };
        }));

        const socket = {};
        const now = Date.now();
        const presence = createSessionPublisherPresence();
        const pendingUntil = now + 120_000;
        const idle = { state: 'idle' as const, activeCount: 0 };
        expect(await presence.registerPublisher({
            socket, binding, completeActivitySnapshot: { ...idle, scheduledWake: { pendingUntil } },
        })).toMatchObject({ status: 'registered' });
        const turnId = randomUUID();
        for (const [action, observedAt] of [['begin', now], ['complete', now + 1]] as const) {
            expect(await applySessionTurnMutation({ actorUserId: owner.id, mutation: {
                v: 1, sessionId: session.id, mutationId: randomUUID(), action, turnId, observedAt,
            } })).toMatchObject({ ok: true, didApply: true });
        }

        const terminal = { ...idle, scheduledWake: { pendingUntil, outcome } };
        expect(await presence.publishSnapshot({ socket, binding, completeSnapshot: terminal }))
            .toMatchObject({ status: 'applied' });
        expect(await presence.publishSnapshot({ socket, binding, completeSnapshot: terminal }))
            .toMatchObject({ status: 'unchanged' });
        expect(await presence.closePublisher({ socket })).toMatchObject({ status: 'closed' });
        const admitted = followers.filter(({ preset }) => preset !== 'quiet');
        const alerts = await submittedAlerts();
        expect(alerts).toHaveLength(admitted.length);
        expect(alerts).toEqual(expect.arrayContaining(admitted.map(({ accountId }) => expect.objectContaining({
            sessionId: session.id, accountId, event: { type: event, turnId },
        }))));
        expect(submittedTokens().sort()).toEqual(admitted.map(({ token }) => token).sort());
    });

    it("alerts Everything and Custom human-message followers after an authenticated human post but never alerts the author", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const author = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const allMessages = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const customHuman = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.sessionGrant.createMany({ data: ([author, allMessages, customHuman].map((account) => ({
            sessionId: session.id, createdByAccountId: owner.id, accountId: account.id, accessLevel: "edit" as const,
        }))).map(data => ({ ...data, principalKind: 'account' })) });
        await db.accountSessionFollow.createMany({ data: [
            { sessionId: session.id, accountId: author.id, following: true, followPolicy: JSON.stringify({ preset: "everything" }) },
            { sessionId: session.id, accountId: allMessages.id, following: true, followPolicy: JSON.stringify({ preset: "everything" }) },
            { sessionId: session.id, accountId: customHuman.id, following: true,
                followPolicy: JSON.stringify({ preset: 'custom', events: { person_wrote: { delivery: 'interrupt' } } }) },
        ] });
        const [authorToken, allMessagesToken, customHumanToken] = await Promise.all(
            [author, allMessages, customHuman].map((account) => enrollRemoteAlerts(account.id)),
        );

        const result = await createSessionMessage({
            inputAdmission: "authenticatedAccount",
            authentication: presentUserAuthentication,
            actorUserId: author.id,
            sessionId: session.id,
            localId: `human-${randomUUID()}`,
            messageRole: "user",
            content: { t: "plain", v: { role: "user", content: { type: "text", text: "Review this" } } },
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, didWrite: true });

        expect(await submittedAlerts()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                sessionId: session.id,
                accountId: allMessages.id,
                event: { type: "human_message", sequenceDomain: "session_transcript", messageSeq: 1 },
            }),
            expect.objectContaining({
                sessionId: session.id,
                accountId: customHuman.id,
                event: { type: "human_message", sequenceDomain: "session_transcript", messageSeq: 1 },
            }),
        ]));
        expect(submittedTokens().sort()).toEqual([allMessagesToken, customHumanToken].sort());
        expect(submittedTokens()).not.toContain(authorToken);
    });

    it("alerts Custom interrupting Message followers for a newly committed attention-bearing Agent message", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const allMessages = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const important = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.sessionGrant.createMany({ data: ([allMessages, important].map((account) => ({
            sessionId: session.id, createdByAccountId: owner.id, accountId: account.id, accessLevel: "view" as const,
        }))).map(data => ({ ...data, principalKind: 'account' })) });
        await db.accountSessionFollow.createMany({ data: [
            { sessionId: session.id, accountId: allMessages.id, following: true,
                followPolicy: JSON.stringify({ preset: 'custom', events: { message: { delivery: 'interrupt' } } }) },
            { sessionId: session.id, accountId: important.id, following: true, followPolicy: JSON.stringify({ preset: "important" }) },
        ] });
        await Promise.all([allMessages, important].map((account) => enrollRemoteAlerts(account.id)));

        const result = await createSessionMessage({
            inputAdmission: "authenticatedAccount",
            authentication: presentUserAuthentication,
            actorUserId: owner.id,
            sessionId: session.id,
            localId: `agent-${randomUUID()}`,
            messageRole: "agent",
            content: { t: "plain", v: { role: "agent", content: { type: "text", text: "Implemented" } } },
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, didWrite: true });

        expect(await submittedAlerts()).toEqual([expect.objectContaining({
            sessionId: session.id,
            accountId: allMessages.id,
            event: { type: "message", sequenceDomain: "session_transcript", messageSeq: 1 },
        })]);
    });

    it("accepts source-unavailable only from the exact current Session Machine binding", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const follower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: `machine-${randomUUID()}`, accountId: owner.id, metadata: "{}" } });
        const unboundMachine = await db.machine.create({ data: { id: `machine-${randomUUID()}`, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
        } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: "opaque" } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: follower.id, accessLevel: "view",
        } });
        await db.accountSessionFollow.create({ data: {
            sessionId: session.id, accountId: follower.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        } });
        const followerToken = await enrollRemoteAlerts(follower.id);
        const options = { operationSocketBatchLimits: { ok: true as const, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } };

        const forgedSocket = createFakeSocket({ data: { clientType: "machine-scoped", machineId: unboundMachine.id } });
        machineUpdateHandler(owner.id, forgedSocket as never, options);
        await getSocketHandler(forgedSocket, "external-session-source-unavailable")({
            v: 1, type: "external-session-source-unavailable", sessionId: session.id,
            machineId: unboundMachine.id, observedAtMs: Date.now(),
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();

        const sourceSocket = createFakeSocket({ data: { clientType: "machine-scoped", machineId: machine.id } });
        machineUpdateHandler(owner.id, sourceSocket as never, options);
        await getSocketHandler(sourceSocket, "external-session-source-unavailable")({
            v: 1, type: "external-session-source-unavailable", sessionId: session.id,
            machineId: machine.id, observedAtMs: Date.now(),
        });
        // External-source repair has no exact in-flight Turn/fence witness.
        // It remains a quiet update, not a fabricated interrupting stalled event.
        expect(await submittedAlerts()).toEqual([]);
        expect(sendPushNotificationsAsyncSpy.mock.calls.flatMap(([messages]) => messages)).toEqual([
            expect.objectContaining({ to: followerToken, _contentAvailable: true,
                data: { type: 'session_changed', serverId: 'srv_home_a', sessionId: session.id } }),
        ]);
    });

});
