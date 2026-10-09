import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    createMachineLiveStreamRelayAuthorizationSigningInputV1,
    decodeBase64,
    encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import { machineLiveStreamRelayHandler } from './machineLiveStreamRelayHandler';

describe('Live stream current Machine admission (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-stream-machine-admission-' });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['revoke', 'installation-replacement', 'recipient-replacement-before-new-start'] as const)('keeps frame delivery current across %s', async (transition) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createMachine = () => db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'stream-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/stream', happyHomeDir: '/home/stream/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const source = await createMachine();
        const target = await createMachine();
        const socket = createFakeSocket({ id: randomUUID(), data: {
            clientType: 'machine-scoped', machineId: source.id, verifiedMachineInstallationId: source.installationId,
        } });
        const forwarded: unknown[] = [];
        const recipientInstallations = new Set([target.installationId]);
        const deliveredFrames: string[] = [];
        const key = tweetnacl.sign.keyPair();
        const caps = { maxBitrateBps: 64_000, maxFramesPerSecond: 12, maxFrameBytes: 32_000, maxDurationMs: 60_000, maxTotalBytes: 1000 };
        let streamId = randomUUID();
        const payload = {
            v: 1 as const, grantId: randomUUID(), accountId: owner.id, sourceMachineId: source.id, targetMachineId: target.id,
            flowKind: 'live_stream' as const, routeKind: 'server_relay' as const, streamId, streamFamily: 'screen',
            ...caps, iat: 900, exp: 61_000, aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
        };
        const authorization = { payload, signature: {
            keyId: 'current-admission', alg: 'Ed25519' as const,
            valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload), 'utf8'), key.secretKey)).toString('base64url'),
        } };
        machineLiveStreamRelayHandler(owner.id, socket as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], {
            io: { to: (room) => ({ emit: (_event, envelope) => {
                for (const installationId of recipientInstallations) {
                    if (room !== `machine:${target.id}:${owner.id}` && room !== `machine:${target.id}:${owner.id}:installation:${installationId}`) continue;
                    forwarded.push(envelope);
                    if (envelope && typeof envelope === 'object' && 'message' in envelope
                        && envelope.message && typeof envelope.message === 'object' && 'kind' in envelope.message && envelope.message.kind === 'frame') {
                        deliveredFrames.push(installationId);
                    }
                }
            } }) },
            nowMs: () => 1000, serverRoutedLiveStreamEnabled: true,
            relayCaps: { ...caps, maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1 },
            relayAuthorizationTrustRoots: [{ keyId: 'current-admission', publicKeyBase64Url: Buffer.from(key.publicKey).toString('base64url') }],
            resolveAccountEncryptionMode: async () => {
                const account = await db.account.findUnique({ where: { id: owner.id }, select: { encryptionMode: true } });
                return account?.encryptionMode === 'plain' || account?.encryptionMode === 'e2ee' ? account.encryptionMode : null;
            },
            readMachineAdmission: (machineId) => resolveMachineAdmission({ actorAccountId: owner.id, machineId }),
        });
        const send = getSocketHandler(socket, MACHINE_LIVE_STREAM_SOCKET_EVENT);
        const envelope = { v: 1, sourceMachineId: source.id, targetMachineId: target.id } as const;
        const start = () => {
            const currentPayload = { ...payload, streamId };
            return send({ ...envelope, message: { kind: 'start', startRequest: {
                v: 1, streamId, streamFamily: 'screen', routeKind: 'server_relay', sourceMachineId: source.id, targetMachineId: target.id,
                ...caps, authorization: { ...authorization, payload: currentPayload, signature: { ...authorization.signature,
                    valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(currentPayload), 'utf8'), key.secretKey)).toString('base64url'),
                } },
            } } });
        };
        try {
            await start();
            const frame = (sequence: number) => ({ ...envelope, message: { kind: 'frame', frame: {
                v: 1, streamId, sequence, timestampMs: 1000, payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
                payload: { t: 'plain', v: Buffer.from('abc').toString('base64') }, payloadSizeBytes: 3,
            } } });
            await send(frame(1));
            expect(forwarded).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ kind: 'frame' }) }));
            if (transition === 'recipient-replacement-before-new-start') {
                await send({ ...envelope, message: { kind: 'control', control: { v: 1, streamId, kind: 'stop', reasonCode: 'test' } } });
                const installationId = randomUUID();
                await db.machine.update({ where: { id: target.id }, data: { installationId } });
                recipientInstallations.add(installationId);
                streamId = randomUUID();
                await start();
                deliveredFrames.length = 0;
                await send(frame(1));
                expect(deliveredFrames).toEqual([installationId]);
                return;
            } else if (transition === 'revoke') {
                await db.machine.update({ where: { id: source.id }, data: { revokedAt: new Date() } });
            } else {
                await db.machine.update({ where: { id: source.id }, data: { installationId: randomUUID() } });
            }
            forwarded.length = 0;
            await send(frame(2));
            expect(forwarded).not.toContainEqual(expect.objectContaining({ message: expect.objectContaining({ kind: 'frame' }) }));
        } finally {
            await getSocketHandler(socket, 'disconnect')();
        }
    });
});
