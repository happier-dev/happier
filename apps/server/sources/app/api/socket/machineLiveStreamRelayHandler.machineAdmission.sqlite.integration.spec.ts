import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import Fastify from 'fastify';
import { MachineLiveStreamRelayAuthorizationV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonMachineLiveStreamSourceAdmitResponseV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { registerMachineLiveStreamSourceAdmissionHandler } from '../../../../../cli/src/daemon/peer/mediation/stream/sourceAdmission';
import { createMachineLiveStreamCaptureRegistry } from '../../../../../cli/src/daemon/peer/mediation/stream/captureRegistry';
import { createBrowserDaemonControlRoutes } from '../../../../../cli/src/daemon/browser/control/routes';
import { createBrowserDaemonControlBroker } from '../../../../../cli/src/daemon/browser/control/broker';
import { createBrowserSidecarCdpControlAdapter } from '../../../../../cli/src/daemon/browser/sidecar/controlAdapter';
import { registerBrowserLiveCapture } from '../../../../../cli/src/daemon/browser/capture/registration';
import { createBrowserCdpScreencastProducer } from '../../../../../cli/src/daemon/browser/capture/cdpScreencast';
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    createMachineLiveStreamRelayAuthorizationSigningInputV1,
    decodeBase64,
    encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { removeMachineAccessGrantInTx, resolveMachineAdmission, setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerPeerMediationGrantRoutes } from '@/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createPeerMediationViewerSocketOwnershipVerifier } from './viewerSocketOwnership';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import { getMachineInstallationSocketRoom } from '../socketRooms';
import { machineLiveStreamRelayHandler } from './machineLiveStreamRelayHandler';
import { createBaseStartRequest, createLiveStreamStartRequest } from '../../../../../ui/sources/sync/domains/machines/peer/mediation/stream/startRequest';
import { createMachineLiveStreamSocketTransport } from '../../../../../ui/sources/sync/domains/machines/peer/mediation/stream/socketTransport';

describe('Live stream current Machine admission (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-stream-machine-admission-', initAuth: true });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['owner-session-browser', 'manage-browser', 'guest-browser', 'guest-own-desktop'] as const)(
        'mints and consumes a viewer-bound grant through HTTP and relay START for %s', async (path) => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const actor = path === 'owner-session-browser' ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
            const installation = tweetnacl.sign.keyPair();
            const installationId = randomUUID();
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: owner.id, installationId, active: true,
                installationPublicKey: new Uint8Array(installation.publicKey),
                metadata: encodePlainMachineStoredContent({ host: 'stream-owner', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/stream', happyHomeDir: '/home/stream/.happier' }),
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 1,
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            } });
            if (actor.id !== owner.id) {
                await makeShareEligibleForTest(owner.id, actor.id);
                expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: machine.id,
                    principal: { kind: 'account', accountId: actor.id }, level: path === 'manage-browser' ? 'admin' : 'view',
                }))).toMatchObject({ kind: 'saved' });
            }
            const viewer = createFakeSocket({ id: randomUUID(), data: { userId: actor.id, clientType: 'user-scoped' } });
            // Socket.IO is the network boundary; its viewer ownership verifier stays real.
            const verifyViewerSocketOwnership = createPeerMediationViewerSocketOwnershipVerifier({
                sockets: { sockets: new Map([[viewer.id, viewer]]) },
            } as unknown as Parameters<typeof createPeerMediationViewerSocketOwnershipVerifier>[0]);
            const source = createFakeSocket({ id: randomUUID(), data: { clientType: 'machine-scoped', machineId: machine.id,
                verifiedMachineInstallationId: installationId } });
            const streamId = randomUUID();
            const streamFamily = path === 'guest-own-desktop' ? 'screen' : 'browser.streamed';
            const view = { browserSessionId: 'cmvzjl3en0042mcph0uf97bvt', viewId: 'QAR90B-reload12-main' };
            const sourceId = path === 'guest-own-desktop' ? 'personal-desktop' : browserViewKey(view);
            const sourceOccurrenceId = randomUUID();
            const payload = { version: 1 as const, machineId: machine.id, installationId, accountId: owner.id,
                liveStreamSourceAdmission: { homeServerIdentityId: await getOrCreateServerIdentityId(), actorAccountId: actor.id,
                    streamFamily, sourceId, sourceOccurrenceId } };
            let sourceAdmission = { payload, proof: signMachineInstallationProof({ payload, privateKey: installation.secretKey }) };
            let disposeBrowser: (() => void) | undefined;
            if (streamFamily === 'browser.streamed' && actor.id !== owner.id) {
                const registry = createMachineLiveStreamCaptureRegistry();
                // Chromium/CDP is the OS boundary; Browser discovery, custody and proof issuance stay real.
                const transport = { openPage: async () => ({ targetId: 'page', sessionId: 'cdp' }),
                    dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({}),
                    subscribeCdpEvents: () => () => {} };
                const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'browser', transport });
                const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
                    subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
                const producer = createBrowserCdpScreencastProducer({ contextCapture });
                const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => null });
                disposeBrowser = registration.dispose;
                const broker = createBrowserDaemonControlBroker();
                broker.registerAdapter(adapter);
                const browser = createBrowserDaemonControlRoutes({ broker, captureRegistry: registry });
                expect(await browser.dispatchCommand({ kind: 'openView', commandId: 'grantee-open', ...view,
                    platform: 'web', target: { kind: 'externalUrl', targetId: 'example', url: 'https://example.com' } }))
                    .toMatchObject({ status: 'dispatched' });
                const admission = await resolveMachineAdmission({ actorAccountId: actor.id, machineId: machine.id });
                if (admission.kind !== 'admitted') throw new Error('Expected Machine admission');
                const homeServerIdentityId = await getOrCreateServerIdentityId();
                let raw: unknown;
                registerMachineLiveStreamSourceAdmissionHandler({ registerHandler(method, handler) {
                    if (method === RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT) raw = handler({
                        protocolVersion: 1, machineId: machine.id, streamFamily, sourceId,
                    }, { signal: new AbortController().signal, callerAuthority: 'present_user', machineAdmission: admission });
                } }, { machineId: machine.id, resolveComputer: () => null, resolveBrowser: () => browser,
                    readHomeServerIdentityId: () => homeServerIdentityId,
                    readInstallationIdentity: () => ({ version: 1, installationId, createdAt: 0,
                        publicKey: Buffer.from(installation.publicKey).toString('base64url'), privateKey: Buffer.from(installation.secretKey).toString('base64url') }) });
                const result = DaemonMachineLiveStreamSourceAdmitResponseV1Schema.parse(await raw);
                expect(result).toMatchObject({ result: { ok: true } });
                if (!result.result.ok) throw new Error('Browser source admission refused');
                sourceAdmission = result.result.sourceAdmission;
            }
            const signing = tweetnacl.sign.keyPair();
            const home = Fastify();
            enableAuthentication(home);
            registerPeerMediationGrantRoutes(home, { env: { ...harness.envBase,
                HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: 'true',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'stream-regression',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.from(signing.secretKey).toString('base64url'),
            }, verifyViewerSocketOwnership });
            const delivered: unknown[] = [];
            machineLiveStreamRelayHandler(owner.id, source as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], {
                io: { to: (room: string) => ({ emit: (_event: string, value: unknown) => { if (room === viewer.id) delivered.push(value); } }) },
                serverRoutedLiveStreamEnabled: true, relayCaps: {}, resolveAccountEncryptionMode: async () => 'plain',
                relayAuthorizationTrustRoots: [{ keyId: 'stream-regression', publicKeyBase64Url: Buffer.from(signing.publicKey).toString('base64url') }],
                verifyViewerSocketOwnership,
            });
            try {
                const token = await createAccountTokenForTests(actor.id, { kind: 'account', authority: 'present_user' });
                if (actor.id !== owner.id) {
                    const unqualified = await home.inject({ method: 'POST', url: '/v1/machines/peer/mediation/route-grants',
                        headers: { authorization: `Bearer ${token}` }, payload: {
                            machineId: machine.id, targetMachineId: machine.id, flowKind: 'live_stream', routeKind: 'server_relay',
                            ttlMs: 60_000, viewerSocketId: viewer.id, codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
                            scope: { kind: 'live_stream', streamId, streamFamily, sourceId },
                        } });
                    expect(unqualified.json()).toMatchObject({ ok: false, reasonCode: 'route_unavailable' });
                }
                const response = await home.inject({ method: 'POST', url: '/v1/machines/peer/mediation/route-grants',
                    headers: { authorization: `Bearer ${token}` }, payload: {
                        machineId: machine.id, targetMachineId: machine.id, flowKind: 'live_stream', routeKind: 'server_relay',
                        ttlMs: 60_000, viewerSocketId: viewer.id, codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
                        ...(actor.id !== owner.id ? { sourceAdmission } : {}),
                        scope: { kind: 'live_stream', streamId, streamFamily, sourceId },
                    } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true });
                const authorization = MachineLiveStreamRelayAuthorizationV1Schema.parse(response.json().relayAuthorization);
                const startRequest = createLiveStreamStartRequest({ baseRequest: createBaseStartRequest({
                    sourceMachineId: machine.id, targetMachineId: machine.id, routeKind: 'server_relay', streamId,
                    streamFamily, sourceId, viewerSocketId: viewer.id, caps: {}, codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
                }), authorization });
                const envelope = { v: 1 as const, sourceMachineId: machine.id, targetMachineId: machine.id, viewerSocketId: viewer.id };
                const send = getSocketHandler(source, MACHINE_LIVE_STREAM_SOCKET_EVENT);
                await send({ ...envelope, message: { kind: 'start', startRequest } });
                await send({ ...envelope, message: { kind: 'frame', frame: {
                    v: 1, streamId, sequence: 1, timestampMs: Date.now(), codecId: 'image.mjpeg', payloadKind: 'image_keyframe',
                    payloadEncoding: 'binary_base64', payload: { t: 'plain', v: 'AQID' }, payloadSizeBytes: 3,
                } } });
                const frame = delivered.find(value => typeof value === 'object' && value !== null && 'message' in value
                    && typeof value.message === 'object' && value.message !== null && 'kind' in value.message && value.message.kind === 'frame');
                expect(frame).toBeDefined();
                const consumed = await new Promise<unknown>((resolve, reject) => {
                    createMachineLiveStreamSocketTransport({
                        emit: () => {}, deliver: resolve, onError: reject,
                        resolveContent: async () => ({ mode: 'plain' }), isCurrent: () => true,
                    }).receive(frame);
                });
                expect(consumed).toMatchObject({ message: { kind: 'frame', frame: { streamId, payloadBase64: 'AQID' } } });
            } finally {
                await getSocketHandler(source, 'disconnect')();
                await home.close();
                disposeBrowser?.();
            }
        },
    );

    it('ends the guest live stream and prevents later frames when its real Use grant is removed', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installationId = randomUUID();
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'guest-stream', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/stream', happyHomeDir: '/home/stream/.happier' }),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        await makeShareEligibleForTest(owner.id, guest.id);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: 'view',
        }))).toMatchObject({ kind: 'saved' });
        expect(await resolveMachineAdmission({ actorAccountId: guest.id, machineId: machine.id }))
            .toMatchObject({ kind: 'admitted', role: 'use' });

        const source = createFakeSocket({ id: randomUUID(), data: {
            clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: installationId,
        } });
        const viewerSocketId = randomUUID();
        const viewerMessages: unknown[] = [];
        const sourceMessages: unknown[] = [];
        const sourceOccurrenceId = randomUUID();
        const keys = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(keys.publicKey).toString('base64url');
        machineLiveStreamRelayHandler(owner.id, source as unknown as Parameters<typeof machineLiveStreamRelayHandler>[1], {
            // Socket.IO is the transport boundary; grant mutation, publication and relay logic remain real.
            io: { to: (room: string) => ({ emit: (_event: string, payload: unknown) => {
                if (room === viewerSocketId) viewerMessages.push(payload);
                if (room === getMachineInstallationSocketRoom(owner.id, machine.id, installationId)) sourceMessages.push(payload);
            } }) },
            nowMs: () => 1_000, serverRoutedLiveStreamEnabled: true, relayCaps: {},
            resolveAccountEncryptionMode: async () => 'plain',
            relayAuthorizationTrustRoots: [{ keyId: 'guest-access-loss', publicKeyBase64Url: publicKey }],
            verifyViewerSocketOwnership: async input => input.accountId === guest.id && input.socketId === viewerSocketId,
        });
        const send = getSocketHandler(source, MACHINE_LIVE_STREAM_SOCKET_EVENT);
        const streamId = randomUUID();
        const payload = { v: 2 as const, grantId: randomUUID(), accountId: owner.id,
            sourceMachineId: machine.id, targetMachineId: machine.id, sourceMachineInstallationId: installationId,
            viewerAccountId: guest.id, viewerSocketId, sourceId: 'guest-desktop', flowKind: 'live_stream' as const,
            routeKind: 'server_relay' as const, streamId, streamFamily: 'screen', iat: 900, exp: 61_000,
            aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
            personalSourceAdmission: { homeServerIdentityId: 'home', actorAccountId: guest.id, streamFamily: 'screen',
                sourceId: 'guest-desktop', sourceOccurrenceId },
        };
        const authorization = { payload, signature: { keyId: 'guest-access-loss', alg: 'Ed25519' as const,
            valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createMachineLiveStreamRelayAuthorizationSigningInputV1(payload)), keys.secretKey)).toString('base64url'),
        } };
        const startRequest = { v: 1 as const, streamId, streamFamily: 'screen', routeKind: 'server_relay' as const,
            sourceMachineId: machine.id, targetMachineId: machine.id, sourceId: 'guest-desktop',
            sourceOccurrenceId, viewerSocketId, authorization };
        const envelope = { v: 1 as const, sourceMachineId: machine.id, targetMachineId: machine.id, viewerSocketId };
        const frame = (sequence: number) => ({ ...envelope, message: { kind: 'frame', frame: {
            v: 1, streamId, sequence, timestampMs: 1_000, payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64',
            payload: { t: 'plain', v: 'AQID' }, payloadSizeBytes: 3,
        } } });
        try {
            await send({ ...envelope, message: { kind: 'start', startRequest } });
            expect(source.emit.mock.calls).not.toContainEqual([expect.anything(), expect.objectContaining({ error: expect.anything() })]);
            await send(frame(1));
            expect(viewerMessages).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ kind: 'frame' }) }));
            viewerMessages.length = 0;
            sourceMessages.length = 0;

            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId: guest.id },
            }))).toEqual({ kind: 'removed', effectiveAccess: 'none' });
            const stop = expect.objectContaining({ message: { kind: 'control',
                control: expect.objectContaining({ kind: 'stop', streamId, reasonCode: 'machine_unavailable' }) } });
            expect(viewerMessages).toContainEqual(stop);
            expect(sourceMessages).toContainEqual(stop);
            viewerMessages.length = 0;
            // A frame already in flight at withdrawal must also be refused at the server.
            await send(frame(2));
            expect(viewerMessages).not.toContainEqual(expect.objectContaining({ message: expect.objectContaining({ kind: 'frame' }) }));
        } finally {
            await getSocketHandler(source, 'disconnect')();
        }
    });

    it.each(['revoke', 'installation-replacement', 'recipient-replacement-before-new-start'] as const)('keeps frame delivery current across %s', async (transition) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createMachine = async () => {
            const installationId = randomUUID();
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: owner.id, installationId, active: true,
                metadata: encodePlainMachineStoredContent({ host: 'stream-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/stream', happyHomeDir: '/home/stream/.happier' }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            } });
            return { ...machine, installationId };
        };
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
            io: { to: (room: string) => ({ emit: (_event: string, envelope: unknown) => {
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
