import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveAccountRemoteAlertPolicyV1, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    type DeviceRemoteAlertPolicyV1 } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { SessionInputMachineTargetV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { activityCache } from './sessionCache';
import { createMachinePresenceDeadlineOwner, stopLocalMachinePresenceTimeout } from './timeout';
import { inTx } from '@/storage/inTx';
import { writeAccountSettingsInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import { buildMachineOfflineAlertSettingMutation } from '@happier-dev/protocol/actions/settings/machineOfflineAlertSetting';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { MachineRemoteAlertV1Schema } from '@happier-dev/protocol/push/machineRemoteAlert';

// Only the external Expo delivery boundary is replaced; policy, presence,
// authentication, ownership and persistence run through their real owners.
const send = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok' }))));
vi.mock('expo-server-sdk', () => ({ Expo: class {
    static isExpoPushToken() { return true; }
    chunkPushNotifications(messages: unknown[]) { return [messages]; }
    async sendPushNotificationsAsync(messages: unknown[]) { return await send(messages); }
    async getPushNotificationReceiptsAsync() { return {}; }
} }));
const device: DeviceRemoteAlertPolicyV1 = { v: 1, enabled: true, nativeConsumer: 'ios_service_extension_v1',
    quietHoursOverride: { mode: 'account' }, foregroundBehavior: 'account', previewCeiling: 'title_only', soundVolume: 1 };
const config = { sessionTimeoutMs: 600_000, machineTimeoutMs: 600_000, tickMs: 60_000 };
const messages = () => send.mock.calls.flatMap(([batch]) => batch as Array<Record<string, unknown>>);

async function expireMachines(): Promise<void> {
    const deadlines = createMachinePresenceDeadlineOwner(config.machineTimeoutMs);
    try {
        await deadlines.start();
        await vi.waitFor(async () => expect(await db.machine.count({ where: {
            active: true, revokedAt: null, replacedByMachineId: null,
            lastActiveAt: { lte: new Date(Date.now() - config.machineTimeoutMs) },
        } })).toBe(0));
    } finally { await deadlines.stop(); }
}

describe('opted-in Machine offline presence alerts (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'machine-offline-alert-', initAuth: true, initEncrypt: true,
        env: { HANDY_MASTER_SECRET: 'machine-offline-alert-secret', AUTH_REQUIRED_LOGIN_PROVIDERS: '', SERVER_ROLE: 'all',
            HAPPIER_SERVER_IDENTITY_ID: 'srv_offline_home' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { await stopLocalMachinePresenceTimeout(); send.mockClear(); });
    const account = () => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    async function enroll(accountId: string, machineIds: string[]) {
        const row = await db.account.update({ where: { id: accountId }, data: { settingsVersion: { increment: 1 } } });
        await db.account.update({ where: { id: accountId }, data: { remoteAlertPolicy: { settingsVersion: row.settingsVersion,
            policy: deriveAccountRemoteAlertPolicyV1({ machineOfflineAlertsV1: { machineIds }, sessionRemoteAlertsEnabled: false }) } } });
        const token = `ExponentPushToken[${randomUUID()}]`;
        await db.accountPushToken.create({ data: { accountId, token, remoteAlerts: device } });
        return token;
    }
    async function machine(accountId: string, kind: 'persistent' | 'ephemeral_session_runner' = 'persistent') {
        return await db.machine.create({ data: { id: randomUUID(), accountId, kind,
            metadata: encodePlainMachineStoredContent({ host: 'private-machine-name', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: 'offline-installation', active: true, lastActiveAt: new Date(Date.now() - 700_000) } });
    }
    it('alerts only the enrolled owner for both Machine kinds without Sessions, once per timeout transition', async () => {
        const owner = await account();
        const outsider = await account();
        const [persistent, runner, unenrolled, fresh] = await Promise.all([
            machine(owner.id), machine(owner.id, 'ephemeral_session_runner'), machine(owner.id), machine(owner.id),
        ]);
        await db.machine.update({ where: { id: fresh.id }, data: { lastActiveAt: new Date() } });
        const token = await enroll(owner.id, [persistent.id, runner.id, fresh.id]);
        await enroll(outsider.id, [persistent.id, runner.id]);
        await expireMachines();
        expect(messages()).toHaveLength(2);
        expect(messages().map(message => message.to)).toEqual([token, token]);
        expect(messages().map(message => message.data)).toEqual(expect.arrayContaining([persistent, runner].map(row => ({
            type: 'machine_alert', v: 1, serverId: 'srv_offline_home', accountId: owner.id, machineId: row.id,
            phase: 'offline', previewBehavior: 'title_only',
        }))));
        expect(JSON.stringify(messages())).not.toContain('private-machine-name');
        expect(await db.machine.findUnique({ where: { id: unenrolled.id } })).toMatchObject({ active: false });
        await expireMachines();
        expect(messages()).toHaveLength(2);
        const sessionId = randomUUID();
        await db.session.create({ data: { id: sessionId, accountId: owner.id, tag: randomUUID(), metadata: '{}',
            active: true, thinking: true, thinkingAt: new Date(), lastActiveAt: new Date(),
            runtimeMachineTarget: SessionInputMachineTargetV1Schema.parse({ homeId: 'srv_offline_home',
                accountId: owner.id, sessionId, machineId: persistent.id, installationId: persistent.installationId }),
        } });
        await db.machine.update({ where: { id: persistent.id },
            data: { active: true, lastActiveAt: new Date(Date.now() - 700_000) } });
        await expireMachines();
        expect(messages()).toHaveLength(3);
        expect(messages()[2]).toMatchObject({ to: token, data: { machineId: persistent.id, phase: 'offline' } });
    });
    it.each(['stale', 'revoked', 'replaced', 'device_disabled'] as const)(
        'fails closed for an enrolled Machine with %s delivery authority', async loss => {
            const owner = await account();
            const row = await machine(owner.id);
            const token = await enroll(owner.id, [row.id]);
            if (loss === 'stale') await db.account.update({ where: { id: owner.id },
                data: { settingsVersion: { increment: 1 } } });
            if (loss === 'revoked') await db.machine.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
            if (loss === 'replaced') {
                const replacement = await machine(owner.id);
                await db.machine.update({ where: { id: row.id }, data: { replacedByMachineId: replacement.id } });
            }
            if (loss === 'device_disabled') await db.accountPushToken.update({
                where: { accountId_token: { accountId: owner.id, token } }, data: { remoteAlerts: { ...device, enabled: false } } });
            await expireMachines();
            expect(messages()).toEqual([]);
        },
    );
    it('sends content-free silent recovery on admitted alive, and fails closed after consent becomes stale', async () => {
        const owner = await account();
        const row = await machine(owner.id);
        await enroll(owner.id, [row.id]);
        await db.machine.update({ where: { id: row.id }, data: { active: false } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: row.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: row.installationId } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, socket as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
        try {
            await getSocketHandler(socket, 'machine-alive')({ machineId: row.id, time: Date.now() });
            expect(messages()).toHaveLength(1);
            expect(messages()[0]).toMatchObject({ data: { type: 'machine_alert', phase: 'recovered', machineId: row.id },
                _contentAvailable: true });
            for (const key of ['title', 'body', 'sound']) expect(messages()[0]).not.toHaveProperty(key);
            // LOCAL admission is committed synchronously. A continuing beat
            // is not a second recovery and does not repeat the dismissal push.
            await getSocketHandler(socket, 'machine-alive')({ machineId: row.id, time: Date.now() });
            expect(messages()).toHaveLength(1);
            for (const message of messages()) {
                expect(message).toMatchObject({ data: { phase: 'recovered' }, _contentAvailable: true });
                for (const key of ['title', 'body', 'sound']) expect(message).not.toHaveProperty(key);
            }
            send.mockClear();
            await db.account.update({ where: { id: owner.id }, data: { settingsVersion: { increment: 1 } } });
            await getSocketHandler(socket, 'machine-alive')({ machineId: row.id, time: Date.now() });
            expect(messages()).toEqual([]);
        } finally { activityCache.invalidateMachine(row.id); }
    });
    it.each([
        { online: false, optOut: false, deliveryDisabled: false },
        { online: true, optOut: false, deliveryDisabled: false },
        { online: false, optOut: true, deliveryDisabled: false },
        { online: false, optOut: false, deliveryDisabled: true },
    ])('composes settings enrollment ($online, optOut=$optOut, deliveryDisabled=$deliveryDisabled) with one requested return and quiet ordinary recovery', async ({ online, optOut, deliveryDisabled }) => {
        const owner = await account();
        const row = await machine(owner.id);
        const pushToken = `ExponentPushToken[${randomUUID()}]`;
        const initialCacheKeys = new Set((await db.simpleCache.findMany({ select: { key: true } })).map(item => item.key));
        let requestKeys: string[] = [];
        const recoveryRequests = () => db.simpleCache.count({ where: { key: { in: requestKeys } } });
        const visibleMessages = () => messages().filter(message => typeof message.body === 'string' && message.body.trim().length > 0);
        await db.accountPushToken.create({ data: { accountId: owner.id, token: pushToken, remoteAlerts: device } });
        await db.machine.update({ where: { id: row.id }, data: { active: online,
            lastActiveAt: online ? new Date() : row.lastActiveAt } });
        // UI and agent settings Actions share this keyed mutation producer.
        const enabledSettings = accountSettingsParse(buildMachineOfflineAlertSettingMutation(accountSettingsParse({}), row.id, true));
        const settings = deliveryDisabled ? accountSettingsParse({ ...enabledSettings, attentionDeliveryPolicyV1: {
            ...enabledSettings.attentionDeliveryPolicyV1, channels: { ...enabledSettings.attentionDeliveryPolicyV1.channels,
                expo_push: { ...enabledSettings.attentionDeliveryPolicyV1.channels.expo_push, enabled: false } },
        } }) : enabledSettings;
        const write = (expectedVersion: number, nextSettings: typeof settings) => inTx(async tx => {
            const result = await writeAccountSettingsInTx({ tx, accountId: owner.id, expectedVersion,
                next: { kind: 'v2', content: { t: 'plain', v: nextSettings }, remoteAlertPolicy: deriveAccountRemoteAlertPolicyV1(nextSettings) } });
            if (expectedVersion === 0 && result.status === 'success') {
                // Capture real producer state before post-commit publication,
                // without duplicating its private storage-key encoding.
                requestKeys = (await tx.simpleCache.findMany({ select: { key: true } }))
                    .map(item => item.key).filter(key => !initialCacheKeys.has(key));
            }
            return result;
        });
        expect(await write(0, settings)).toMatchObject({ status: 'success', version: 1 });
        // An unrelated settings save must retain, not re-arm, the same request.
        expect(await write(1, settings)).toMatchObject({ status: 'success', version: 2 });
        if (optOut) {
            const disabled = accountSettingsParse(buildMachineOfflineAlertSettingMutation(settings, row.id, false));
            expect(await write(2, disabled)).toMatchObject({ status: 'success', version: 3 });
        }
        await db.machine.update({ where: { id: row.id }, data: { active: false } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId: row.id,
            [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: row.installationId } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        machineUpdateHandler(owner.id, socket as unknown as Socket, { operationSocketBatchLimits: {
            ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
        try {
            const alive = getSocketHandler(socket, 'machine-alive');
            await Promise.all([alive({ machineId: row.id, time: Date.now() }), alive({ machineId: row.id, time: Date.now() })]);
            if (optOut || deliveryDisabled) {
                expect(messages()).toEqual([]);
                expect(await recoveryRequests()).toBe(0);
                if (deliveryDisabled) {
                    expect(await write(2, enabledSettings)).toMatchObject({ status: 'success', version: 3 });
                    await db.machine.update({ where: { id: row.id }, data: { active: false } });
                    await alive({ machineId: row.id, time: Date.now() });
                    expect(messages()).toHaveLength(1);
                    expect(visibleMessages()).toHaveLength(0);
                }
                return;
            }
            expect(messages().length).toBeGreaterThan(0);
            for (const message of messages()) {
                expect(message).toMatchObject({ to: pushToken });
                expect(MachineRemoteAlertV1Schema.parse(message.data)).toMatchObject({ phase: 'recovered', machineId: row.id });
            }
            expect(visibleMessages()).toHaveLength(online ? 0 : 1);
            expect(await recoveryRequests()).toBe(0);
            expect(JSON.stringify(messages())).not.toContain('private-machine-name');
            await alive({ machineId: row.id, time: Date.now() });
            expect(visibleMessages()).toHaveLength(online ? 0 : 1);
            // Re-saving consent after delivery and a later outage stay ordinary.
            expect(await write(2, settings)).toMatchObject({ status: 'success', version: 3 });
            await db.machine.update({ where: { id: row.id }, data: { active: false } });
            await alive({ machineId: row.id, time: Date.now() });
            expect(visibleMessages()).toHaveLength(online ? 0 : 1);
        } finally { activityCache.invalidateMachine(row.id); }
    });
});
