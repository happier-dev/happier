import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
    deriveAccountRemoteAlertPolicyV1,
    type DeviceRemoteAlertPolicyV1,
} from "@happier-dev/protocol";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setAccountSessionFollow, removeAccountSessionFollow, acceptAccountSessionFollowOnceDelivery } from '@/app/session/follow/accountFollowService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { parsePersistedPersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { listSessionPersonalEventRecipients } from '@/app/session/personal/eventEligibility';
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";

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

const { resolveSessionActivityRemoteAlertDisposition, submitSessionActivityRemoteAlerts } = await import("./submitSessionActivityRemoteAlerts");
const { updateSessionAgentState } = await import("@/app/session/sessionWriteService");

const DEVICE_POLICY: DeviceRemoteAlertPolicyV1 = {
    v: 1,
    enabled: true,
    nativeConsumer: "ios_service_extension_v1",
    quietHoursOverride: { mode: "account" },
    foregroundBehavior: "account",
    previewCeiling: "title_only",
    soundVolume: 1,
};

function accountSettingsWithRemoteAlerts(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        sessionRemoteAlertsEnabled: true,
        attentionDeliveryPolicyV1: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1, ...overrides },
    });
}

async function enrollRemoteAlerts(accountId: string, settings: string, device: DeviceRemoteAlertPolicyV1 | null = DEVICE_POLICY) {
    const policy = deriveAccountRemoteAlertPolicyV1(JSON.parse(settings));
    const account = await db.account.update({
        where: { id: accountId },
        data: { settings, settingsVersion: { increment: 1 } },
        select: { settingsVersion: true },
    });
    await db.account.update({
        where: { id: accountId },
        data: { remoteAlertPolicy: { settingsVersion: account.settingsVersion, policy } },
    });
    const token = `ExponentPushToken[${accountId}]`;
    await db.accountPushToken.create({
        data: { accountId, token, ...(device === null ? {} : { remoteAlerts: device }) },
    });
    return token;
}

function submittedTokens(): string[] {
    return sendPushNotificationsAsyncSpy.mock.calls
        .flatMap(([chunk]) => chunk as Array<{ to: string }>)
        .map((message) => message.to);
}

function submittedPayloads(): Array<Record<string, unknown>> {
    return sendPushNotificationsAsyncSpy.mock.calls
        .flatMap(([chunk]) => chunk as Array<Record<string, unknown>>);
}

function payloadDataType(message: Record<string, unknown>): string | undefined {
    return (message.data as { type?: string } | undefined)?.type;
}

/** OS-visible alerts only; the content-free wake is a separate delivery leg. */
function submittedAlertPayloads(): Array<Record<string, unknown>> {
    return submittedPayloads().filter((message) => payloadDataType(message) === "activity_alert");
}

function submittedWakePayloads(): Array<Record<string, unknown>> {
    return submittedPayloads().filter((message) => payloadDataType(message) === "session_changed");
}

describe("Home remote alert submission (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "remote-alerts-", initAuth: false,
            env: {
                HAPPIER_SERVER_IDENTITY_ID: "srv_home_a",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "true",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(() => { sendPushNotificationsAsyncSpy.mockClear(); eventRouter.clearIo(); });

    async function fixture(policy: 'important' | 'everything' = 'everything') {
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const follower = await db.account.create({ data: { publicKey: randomUUID() } });
        const reader = await db.account.create({ data: { publicKey: randomUUID() } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        await db.sessionShare.createMany({
            data: [follower, reader].map((account) => ({
                sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: account.id, accessLevel: "view" as const,
            })),
        });
        // Channel/transport tests select Everything explicitly; Important's
        // deliberately quiet completion is exercised by its own contract below.
        await db.accountSessionFollow.createMany({
            data: [owner, follower].map(account => ({ sessionId: session.id, accountId: account.id,
                following: true, followPolicy: JSON.stringify({ preset: policy }) })),
        });
        return { owner, follower, reader, session };
    }

    it('applies HTTP receiver mute and Undo to personal eligibility and remote alerts without changing Follow', async () => {
        const { owner, follower, session } = await fixture();
        const other = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: other.id, sharedByUserId: owner.id,
            sharedWithUserId: follower.id, accessLevel: 'view' } });
        await db.accountSessionFollow.create({ data: { accountId: follower.id, sessionId: other.id,
            following: true, followPolicy: JSON.stringify({ preset: 'everything' }) } });
        const ownerToken = await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        const followerToken = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        const app = createAuthenticatedTestApp();
        registerSessionFollowRoutes(app);
        await app.ready();
        const headers = { 'x-test-user-id': follower.id };
        const url = '/v2/account/session-delivery-mutes';
        const scope = { kind: 'source', source: { kind: 'session', sessionId: session.id } };
        const event = { sessionId: session.id, event: 'ready' as const,
            committedMessage: { domain: 'session_transcript' as const, seq: 1 } };
        const recipientIds = async (sessionId: string) => (await listSessionPersonalEventRecipients({ sessionId, event: 'ready' }))
            .map(recipient => recipient.accountId).sort();
        // Account badge refresh is an independent tracked-source transport.
        // This contract owns the event alert and its companion content-free wake.
        const remoteTokens = () => [...submittedAlertPayloads(), ...submittedWakePayloads()].map(message => message.to);
        try {
            expect(await recipientIds(session.id)).toEqual([owner.id, follower.id].sort());
            const initialFollow = await db.accountSessionFollow.findUniqueOrThrow({ where: {
                accountId_sessionId: { accountId: follower.id, sessionId: session.id },
            } });
            const saved = await app.inject({ method: 'PUT', url, headers, payload: { scope } });
            expect([saved.statusCode, saved.json()]).toEqual([200, { changed: true, disposition: 'muted' }]);
            expect((await app.inject({ method: 'GET', url, headers })).json()).toEqual({ scopes: [scope] });
            expect(await recipientIds(session.id)).toEqual([owner.id]);
            expect(await recipientIds(other.id)).toEqual([owner.id, follower.id].sort());
            expect(await submitSessionActivityRemoteAlerts(event)).toEqual([owner.id]);
            expect(remoteTokens()).toContain(ownerToken);
            expect(remoteTokens()).not.toContain(followerToken);
            expect(await db.accountSessionFollow.findUniqueOrThrow({ where: {
                accountId_sessionId: { accountId: follower.id, sessionId: session.id },
            } })).toEqual(initialFollow);

            const removed = await app.inject({ method: 'DELETE', url, headers, payload: { scope } });
            expect([removed.statusCode, removed.json()]).toEqual([200, { changed: true, disposition: 'unmuted' }]);
            expect(await recipientIds(session.id)).toEqual([owner.id, follower.id].sort());
            sendPushNotificationsAsyncSpy.mockClear();
            expect([...(await submitSessionActivityRemoteAlerts(event))].sort()).toEqual([owner.id, follower.id].sort());
            expect(remoteTokens()).toContain(followerToken);

            await db.account.update({ where: { id: follower.id }, data: { deliveryMutes: '{invalid' } });
            expect(await recipientIds(session.id)).toEqual([owner.id]);
            sendPushNotificationsAsyncSpy.mockClear();
            expect(await submitSessionActivityRemoteAlerts(event)).toEqual([owner.id]);
            expect(remoteTokens()).not.toContain(followerToken);
        } finally { await app.close(); }
    });

    it('keeps Important completion quiet and uses the same source policy for an explicit Custom interruption', async () => {
        const { owner, follower, session } = await fixture('important');
        await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        const token = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        const submit = () => submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: 'ready', committedMessage: { domain: 'session_transcript', seq: 1 },
        });
        expect(await submit()).toEqual([]);
        expect(submittedAlertPayloads()).toEqual([]);
        await db.accountSessionFollow.update({
            where: { accountId_sessionId: { accountId: follower.id, sessionId: session.id } },
            data: { followPolicy: JSON.stringify({ preset: 'custom', events: { finished: { delivery: 'interrupt' } } }) },
        });
        sendPushNotificationsAsyncSpy.mockClear();
        expect(await submit()).toEqual([follower.id]);
        expect(submittedAlertPayloads()).toEqual([expect.objectContaining({ to: token,
            data: expect.objectContaining({ event: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: 1 } }),
        })]);
    });

    it('retains the committed request turn from the Agent-state writer through the Home push transport', async () => {
        const { owner, follower, session } = await fixture();
        // The real occurrence writer admits Account encryption currentness.
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'plain' } });
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: 'plain' } });
        await db.sessionShare.update({ where: { sessionId_sharedWithUserId: { sessionId: session.id, sharedWithUserId: follower.id } },
            data: { accessLevel: 'edit', canApprovePermissions: true } });
        const token = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        let expectedVersion = session.agentStateVersion;
        for (const turnId of ['turn-a', 'turn-b']) {
            sendPushNotificationsAsyncSpy.mockClear();
            await db.sessionTurn.create({ data: { sessionId: session.id, turnId, status: 'in_progress', startedAt: 1, updatedAt: 1 } });
            await db.session.update({ where: { id: session.id }, data: { latestTurnId: turnId, latestTurnStatus: 'in_progress' } });
            const occurredAt = Date.now();
            expect(await updateSessionAgentState({ actorUserId: owner.id, sessionId: session.id,
                expectedVersion, agentStateCiphertext: '{}', pendingPermissionRequestCount: 1,
                pendingRequestNewestCreatedAt: occurredAt,
                userActionRequiredOccurrences: [{ requestId: 'reused-request', sourceTurnId: turnId,
                    requestKind: 'permission', occurredAt }],
            })).toMatchObject({ ok: true, version: expectedVersion + 1 });
            expectedVersion += 1;
            await vi.waitFor(() => expect(submittedAlertPayloads()).toHaveLength(1));
            expect(submittedAlertPayloads()).toEqual([expect.objectContaining({ to: token,
                data: expect.objectContaining({ event: { type: 'permission_request', requestId: 'reused-request', turnId } }),
            })]);
        }
    });

    it('keeps a manager-handled one-shot quiet even when there is no persistent policy', async () => {
        const { owner, session } = await fixture();
        await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        const key = { accountId: owner.id, sessionId: session.id };
        const authentication = createPresentUserSessionAccessAuthentication();
        await removeAccountSessionFollow({ ...key, authentication });
        await setAccountSessionFollow({ ...key, authentication, preferences: { once: { kind: 'first_needs_you' } } });
        await db.session.update({ where: { id: session.id }, data: {
            agentStateVersion: 1, pendingUserActionRequestCount: 1,
        } });
        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: 'user_action_required', committedRequestId: 'manager-question',
            followEvent: { kind: 'needs_you', type: 'decision', mode: 'wait', handling: 'manager' },
            onceOccurrence: { event: 'user_action_required', requestId: 'manager-question', agentStateVersion: 1 },
        })).toEqual([]);
        expect(submittedAlertPayloads()).toEqual([]);
        const follow = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } });
        expect(parsePersistedPersonalFollowOnceV1(follow.notifyOnce)).toMatchObject({ state: 'fulfilled' });
        expect(follow).toMatchObject({ following: false, followPolicy: null });
    });

    it('delivers the committed terminal one-shot winner without enrolling ongoing Follow or replaying it', async () => {
        const { follower, session } = await fixture();
        const token = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        const key = { accountId: follower.id, sessionId: session.id };
        const authentication = createPresentUserSessionAccessAuthentication();
        await removeAccountSessionFollow({ ...key, authentication });
        await db.session.update({ where: { id: session.id }, data: { latestTurnId: 'once-turn', latestTurnStatus: 'in_progress' } });
        await setAccountSessionFollow({ ...key, authentication, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'once-turn' } } });
        const armed = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } });
        if (!armed.notifyOnce) throw new Error('Expected an armed one-shot');
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'once-turn', status: 'completed', startedAt: 1, updatedAt: 2, terminalAt: 2 } });
        const onceOccurrence = { event: 'ready' as const, turnId: 'once-turn', agentStateVersion: 0, transcriptSeq: 1 };
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, expectedOnce: armed.notifyOnce, occurrence: onceOccurrence })).toBe(true);
        const event = { sessionId: session.id, event: 'ready' as const, committedTurnId: 'once-turn',
            committedMessage: { domain: 'session_transcript' as const, seq: 1 }, onceOccurrence, onceOnly: true };
        expect(await submitSessionActivityRemoteAlerts({ ...event, acceptedOnceAccountIds: [follower.id] })).toEqual([follower.id]);
        expect(submittedAlertPayloads()).toEqual([expect.objectContaining({ to: token })]);
        expect(await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } }))
            .toMatchObject({ following: false, followPolicy: null });
        sendPushNotificationsAsyncSpy.mockClear();
        expect(await submitSessionActivityRemoteAlerts(event)).toEqual([]);
        expect(submittedAlertPayloads()).toEqual([]);
    });

    it("stops at the device read when no candidate of a transcript message has a push device", async () => {
        const { owner, follower, session } = await fixture();
        const requests: string[] = [];
        const stop = observeSqliteRequests({ before: request => { requests.push(`${request.model ?? "raw"}.${request.action}`); } });
        try {
            expect(await submitSessionActivityRemoteAlerts({
                sessionId: session.id, event: "message",
                committedMessage: { domain: "session_transcript", seq: 3 },
            })).toEqual([]);
        } finally { stop(); }
        console.info("REMOTE_ALERT_NO_DEVICE_REQUESTS", JSON.stringify(requests));
        // Recipient policy, mute and access are read only for Accounts that
        // have a device the alert could reach.
        expect(requests.filter(request => request.startsWith("Account."))).toEqual([]);
        expect(requests.filter(request => request.startsWith("AccountPushToken."))).toHaveLength(1);
        // Every transcript line submits this; with nobody to reach, only the eligibility owner reads the Session.
        expect(requests.filter(request => request.startsWith("Session."))).toHaveLength(1);
        expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
        // A candidate with a device still reaches its device, unchanged.
        const followerToken = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "message",
            committedMessage: { domain: "session_transcript", seq: 4 },
            sourceAccountId: owner.id,
        });
        expect(submittedTokens()).toEqual([followerToken]);
    });

    it("submits nothing while the sole Session Follow feature is disabled", async () => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = "false";
        try {
            expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id,
            event: "ready",
            committedMessage: { domain: "session_transcript", seq: 1 },
            })).toEqual([]);
            expect(submittedAlertPayloads()).toEqual([]);
            expect(submittedWakePayloads()).toEqual([]);
        } finally {
            process.env.HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED = "true";
        }
    });

    it("mutes opted-in Home alerts while a computer is focused but retains qualified sync wakes and fails open", async () => {
        const { follower, session } = await fixture();
        const token = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts({ mutePhoneWhenComputerFocused: true }));
        let focus: boolean | 'unavailable' = true;
        eventRouter.setIo({
            to: () => ({ emit() {}, disconnectSockets() {} }),
            in: () => ({ fetchSockets: async () => {
                if (focus === 'unavailable') throw new Error('adapter unavailable');
                return [{ id: 'focus-socket', data: { clientType: 'user-scoped', clientPurpose: 'sync', uiFocus: { computer: true, focused: focus } } }];
            } }),
        });
        const submit = () => submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: 'ready', committedMessage: { domain: 'session_transcript', seq: 12 },
        });
        await submit();
        expect(submittedPayloads()).toContainEqual(expect.objectContaining({
            to: token, _contentAvailable: true,
            data: { type: 'session_changed', serverId: 'srv_home_a', sessionId: session.id, alert: 'muted' },
        }));
        expect(submittedPayloads().filter((payload) => payload.to === token).every((payload) => !('title' in payload))).toBe(true);
        for (const next of [false, 'unavailable'] as const) {
            focus = next;
            sendPushNotificationsAsyncSpy.mockClear();
            await submit();
            expect(submittedPayloads()).toContainEqual(expect.objectContaining({ to: token, title: 'Happier' }));
        }
        focus = true;
        const defaultSettings = accountSettingsWithRemoteAlerts();
        const defaultAccount = await db.account.update({ where: { id: follower.id }, data: {
            settings: defaultSettings, settingsVersion: { increment: 1 },
        } });
        await db.account.update({ where: { id: follower.id }, data: { remoteAlertPolicy: {
            settingsVersion: defaultAccount.settingsVersion, policy: deriveAccountRemoteAlertPolicyV1(JSON.parse(defaultSettings)),
        } } });
        sendPushNotificationsAsyncSpy.mockClear();
        await submit();
        expect(submittedPayloads()).toContainEqual(expect.objectContaining({ to: token, title: 'Happier' }));
        const wakeOnlySettings = { sessionRemoteAlertsEnabled: false,
            attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: true } };
        const wakeOnlyAccount = await db.account.update({ where: { id: follower.id }, data: {
            settings: JSON.stringify(wakeOnlySettings), settingsVersion: { increment: 1 },
        } });
        await db.account.update({ where: { id: follower.id }, data: { remoteAlertPolicy: {
            settingsVersion: wakeOnlyAccount.settingsVersion, policy: deriveAccountRemoteAlertPolicyV1(wakeOnlySettings),
        } } });
        sendPushNotificationsAsyncSpy.mockClear();
        await submit();
        expect(submittedPayloads().filter((payload) => payload.to === token)).toEqual([
            expect.objectContaining({ _contentAvailable: true,
                data: { type: 'session_changed', serverId: 'srv_home_a', sessionId: session.id, alert: 'muted' } }),
        ]);
    });

    it("submits a content-free alert to an enrolled eligible recipient and to nobody else", async () => {
        const { owner, follower, reader, session } = await fixture();
        const ownerMachine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`,
            accountId: owner.id,
            metadata: "{}",
            kind: "persistent",
        } });
        await db.accessKey.create({ data: {
            accountId: owner.id,
            machineId: ownerMachine.id,
            sessionId: session.id,
            data: "encrypted",
        } });
        const followerToken = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        await enrollRemoteAlerts(reader.id, accountSettingsWithRemoteAlerts());
        await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        const publisherBinding = { accountId: owner.id, machineId: ownerMachine.id, sessionId: session.id };
        const registration = await createSessionPublisherPresence().registerPublisher({
            socket: {},
            binding: publisherBinding,
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        });
        if (registration.status !== "registered") throw new Error("expected publisher registration");

        const submitted = await submitSessionActivityRemoteAlerts({
            sessionId: session.id,
            event: "ready",
            committedMessage: { domain: "session_transcript", seq: 12 },
            // The runtime Account keeps its existing rich sender for this event.
            runtimeComposition: {
                publisherAuthority: { ...publisherBinding, committedFence: registration.committedFence },
                ownerActivityDelivery: "rich_sender",
            },
        });

        expect(submitted).toEqual([follower.id]);
        expect(submittedTokens()).toEqual([followerToken]);
        const payload = submittedPayloads()[0];
        expect(payload?.data).toEqual({
            type: "activity_alert", v: 2,
            serverId: "srv_home_a", sessionId: session.id, accountId: follower.id,
            event: { type: "ready", sequenceDomain: "session_transcript", messageSeq: 12 },
            previewBehavior: "title_only",
        });
        expect(JSON.stringify(payload)).not.toContain(session.tag);
        expect(payload?.title).toBe("Happier");
        expect(payload?.mutableContent).toBe(true);
    });

    it.each(['failed', 'cancelled', 'message', 'human_message'] as const)('keeps legacy %s fallback and delegates only supported explicitly declared semantic alerts', async event => {
        const { owner, session } = await fixture();
        if (event === 'message') await db.accountSessionFollow.update({ where: {
            accountId_sessionId: { accountId: owner.id, sessionId: session.id },
        }, data: { followPolicy: JSON.stringify({ preset: 'custom', events: { message: { delivery: 'interrupt' } } }) } });
        const machine = await db.machine.create({ data: { id: `machine-${randomUUID()}`,
            accountId: owner.id, metadata: '{}', kind: 'persistent' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'encrypted' } });
        await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        const binding = { accountId: owner.id, machineId: machine.id, sessionId: session.id };
        const presence = createSessionPublisherPresence();
        const registration = await presence.registerPublisher({ socket: {}, binding,
            completeActivitySnapshot: { state: 'unknown', activeCount: 0 } });
        if (registration.status !== 'registered') throw new Error('Missing actual publisher');
        const runtimeComposition = { publisherAuthority: { ...binding, committedFence: registration.committedFence },
            ownerActivityDelivery: 'rich_sender' as const };
        expect(await submitSessionActivityRemoteAlerts({ sessionId: session.id, event,
            committedMessage: { domain: 'session_transcript', seq: 12 },
            committedTurnId: 'terminal-turn',
            runtimeComposition })).toContain(owner.id);
        const current = await submitSessionActivityRemoteAlerts({ sessionId: session.id, event,
            committedMessage: { domain: 'session_transcript', seq: 12 },
            committedTurnId: 'terminal-turn',
            runtimeComposition: { ...runtimeComposition, ownerActivityDeliveryWasReported: true } });
        if (event === 'human_message') expect(current).toContain(owner.id);
        else expect(current).not.toContain(owner.id);
    });

    it("includes the owner when an active persistent Machine's publisher authority was superseded", async () => {
        const { owner, session } = await fixture();
        const firstMachine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`,
            accountId: owner.id,
            metadata: "{}",
            kind: "persistent",
        } });
        const successorMachine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`,
            accountId: owner.id,
            metadata: "{}",
            kind: "persistent",
        } });
        await db.accessKey.createMany({ data: [firstMachine, successorMachine].map((machine) => ({
            accountId: owner.id,
            machineId: machine.id,
            sessionId: session.id,
            data: "encrypted",
        })) });
        const ownerToken = await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        const presence = createSessionPublisherPresence();
        const firstSocket = {};
        const firstBinding = { accountId: owner.id, machineId: firstMachine.id, sessionId: session.id };
        const firstRegistration = await presence.registerPublisher({
            socket: firstSocket,
            binding: firstBinding,
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        });
        expect(firstRegistration.status).toBe("registered");
        if (firstRegistration.status !== "registered") throw new Error("expected publisher registration");
        await presence.registerPublisher({
            socket: {},
            binding: { accountId: owner.id, machineId: successorMachine.id, sessionId: session.id },
            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
        });

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id,
            event: "ready",
            committedMessage: { domain: "session_transcript", seq: 13 },
            runtimeComposition: {
                publisherAuthority: { ...firstBinding, committedFence: firstRegistration.committedFence },
                ownerActivityDelivery: "rich_sender",
            },
        })).toContain(owner.id);
        expect(submittedTokens()).toContain(ownerToken);
        expect(await db.machine.findUniqueOrThrow({ where: { id: firstMachine.id } })).toMatchObject({
            active: true,
            replacedAt: null,
        });
    });

    it.each([
        ["default", "default", "default"],
        ["soft", "happier_soft.wav", "happier.default.soft.v1"],
        ["urgent", "happier_urgent.wav", "happier.default.urgent.v1"],
        ["none", undefined, "happier.default.silent.v1"],
        ["custom:private-file", undefined, "happier.default.silent.v1"],
    ] as const)("preserves %s sound policy at the Expo boundary", async (soundId, sound, channelId) => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts({
            sounds: { defaultSoundId: soundId, eventSoundIds: {}, volume: 1 },
        }));

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 5 },
        })).toEqual([follower.id]);
        const payload = submittedPayloads()[0];
        expect(payload?.sound).toBe(sound);
        expect(payload?.channelId).toBe(channelId);
        if (sound === undefined) expect(payload).not.toHaveProperty("sound");
        expect(JSON.stringify(payload)).not.toContain("custom:private-file");
    });

    it.each(["deliver", "silent", "suppress"] as const)("honors quiet-hours %s at submission", async (delivery) => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts({
            quietHours: { enabled: true, timezone: "UTC", windows: [{ startLocalTime: "22:00", endLocalTime: "07:00" }] },
            channels: {
                ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels,
                expo_push: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push, quietHoursBehavior: delivery },
            },
        }));

        const submitted = await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 6 },
            now: new Date("2026-09-06T23:00:00Z"),
        });
        if (delivery === "suppress") {
            expect(submitted).toEqual([]);
            // Quiet hours remove the OS-visible alert before submission. The device
            // still receives the content-free wake and applies the same policy to
            // its own local notification, so suppression is never an OS fallback.
            expect(submittedAlertPayloads()).toEqual([]);
            expect(submittedWakePayloads()).toHaveLength(1);
            expect(submittedWakePayloads()[0]).not.toHaveProperty("body");
            expect(submittedWakePayloads()[0]).not.toHaveProperty("sound");
            return;
        }
        expect(submitted).toEqual([follower.id]);
        expect(submittedPayloads()).toHaveLength(1);
        const payload = submittedPayloads()[0];
        expect(payload).toMatchObject({ title: "Happier", mutableContent: true });
        expect(payload?.sound).toBe(delivery === "silent" ? undefined : "happier_soft.wav");
        expect(payload?.channelId).toBe(delivery === "silent" ? "happier.default.silent.v1" : "happier.default.soft.v1");
        if (delivery === "silent") expect(payload).not.toHaveProperty("sound");
    });

    it.each([
        ["permission_required", "happier.permissionRequests.urgent.v1"],
        ["user_action_required", "happier.userActionRequests.urgent.v1"],
    ] as const)("uses the shared request sound/channel for %s", async (event, channelId) => {
        const { owner, session } = await fixture();
        await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        expect(await submitSessionActivityRemoteAlerts({ sessionId: session.id, event })).toEqual([owner.id]);
        expect(submittedPayloads()).toEqual([expect.objectContaining({
            sound: "happier_urgent.wav", channelId, mutableContent: true,
        })]);
    });

    it("never submits an OS-visible alert without a current Account projection or an enabled device registration", async () => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        // A later settings write advances the version and retires the old binding.
        await db.account.update({ where: { id: follower.id }, data: { settingsVersion: { increment: 1 } } });
        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 3 },
        })).toEqual([]);
        expect(submittedAlertPayloads()).toEqual([]);

        const fresh = await fixture();
        await enrollRemoteAlerts(fresh.follower.id, accountSettingsWithRemoteAlerts(), { ...DEVICE_POLICY, enabled: false });
        expect(await submitSessionActivityRemoteAlerts({
            sessionId: fresh.session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 3 },
        })).toEqual([]);

        const unregistered = await fixture();
        await enrollRemoteAlerts(unregistered.follower.id, accountSettingsWithRemoteAlerts(), null);
        expect(await submitSessionActivityRemoteAlerts({
            sessionId: unregistered.session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 3 },
        })).toEqual([]);
        expect(submittedAlertPayloads()).toEqual([]);
    });

    it("applies the recipient's own mute before submission rather than at an OS fallback", async () => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts({
            channels: {
                ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels,
                expo_push: { ...DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push, enabled: false },
            },
        }));
        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 4 },
        })).toEqual([]);
        expect(submittedAlertPayloads()).toEqual([]);
        // The wake carries no copy, so a muted channel can never become an OS alert.
        expect(submittedWakePayloads()[0]).not.toHaveProperty("body");
    });

    it("wakes an eligible recipient device this leg cannot alert, content-free", async () => {
        const { follower, session } = await fixture();
        const followerToken = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        // No current projection: the Home cannot decide this recipient's policy, so
        // it must hand the decision back to the device instead of staying silent.
        await db.account.update({ where: { id: follower.id }, data: { settingsVersion: { increment: 1 } } });

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 21 },
        })).toEqual([]);
        expect(submittedTokens()).toEqual([followerToken]);
        const payload = submittedPayloads()[0];
        expect(payload?.data).toEqual({
            type: "session_changed", serverId: "srv_home_a", sessionId: session.id,
        });
        expect(payload?._contentAvailable).toBe(true);
        expect(payload?.priority).toBe("normal");
        for (const field of ["title", "body", "sound", "channelId", "badge", "mutableContent"]) {
            expect(payload).not.toHaveProperty(field);
        }
        expect(JSON.stringify(payload)).not.toContain(session.tag);
    });

    it("gives one device exactly one leg for one committed event", async () => {
        const { follower, session } = await fixture();
        const followerToken = await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "ready", committedMessage: { domain: "session_transcript", seq: 22 },
        })).toEqual([follower.id]);
        expect(submittedTokens()).toEqual([followerToken]);
        expect(submittedWakePayloads()).toEqual([]);
        expect(submittedAlertPayloads()).toHaveLength(1);
    });

    it("alerts an assignment target through the follow_update family, including the Session owner", async () => {
        const { owner, session } = await fixture();
        const ownerToken = await enrollRemoteAlerts(owner.id, accountSettingsWithRemoteAlerts());
        await db.session.update({ where: { id: session.id }, data: { responsibleAccountId: owner.id } });

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "assigned", targetAccountIds: [owner.id],
        })).toEqual([owner.id]);
        expect(submittedTokens()).toEqual([ownerToken]);
        expect(submittedPayloads()[0]?.data).toMatchObject({ event: { type: "assigned" } });
        expect(submittedPayloads()[0]).toMatchObject({
            sound: "happier_soft.wav", channelId: "happier.default.soft.v1", mutableContent: true,
        });
    });

    it("keeps direct-share candidacy in-app only and submits no OS alert", async () => {
        const { reader, session } = await fixture();
        await enrollRemoteAlerts(reader.id, accountSettingsWithRemoteAlerts());

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id,
            event: "directly_shared",
            targetAccountIds: [reader.id],
        })).toEqual([]);
        expect(submittedTokens()).toEqual([]);
        expect(submittedPayloads()).toEqual([]);
    });

    it("classifies a direct share as a personal-only fact, not as an alert this Home failed to build", () => {
        // Deliberate, not a gap: access never creates tracking, unread or
        // notifications by itself, so a direct share earns no alert and no wake.
        expect(resolveSessionActivityRemoteAlertDisposition("directly_shared")).toEqual({ kind: "personal_only" });
        // An alerting kind whose committed producer this Home does not own is a
        // different outcome, and stays distinguishable from the deliberate one.
        expect(resolveSessionActivityRemoteAlertDisposition("human_message")).toEqual({ kind: "no_alert_event" });
        expect(resolveSessionActivityRemoteAlertDisposition("assigned")).toEqual({
            kind: "alert", event: { type: "assigned" },
        });
    });

    it("refuses an event kind whose content-free producer this Home does not own", async () => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());
        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id, event: "human_message",
        })).toEqual([]);
        expect(submittedTokens()).toEqual([]);
    });

    it("preserves the producer's sequence domain instead of treating a Discussion row as transcript content", async () => {
        const { follower, session } = await fixture();
        await enrollRemoteAlerts(follower.id, accountSettingsWithRemoteAlerts());

        expect(await submitSessionActivityRemoteAlerts({
            sessionId: session.id,
            event: "human_message",
            committedMessage: { domain: "discussion", discussionId: "discussion-a", seq: 7 },
        })).toEqual([follower.id]);
        expect(submittedPayloads()[0]?.data).toMatchObject({
            v: 2,
            event: {
                type: "human_message", sequenceDomain: "discussion", discussionId: "discussion-a", messageSeq: 7,
            },
        });
    });
});
