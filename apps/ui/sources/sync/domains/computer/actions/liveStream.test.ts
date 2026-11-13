import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MachineLiveStreamSourceAdmissionV1Schema, MachineLiveStreamStartRequestV1Schema, MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { DaemonMachineLiveStreamSourceAdmitRequestV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

// HTTP, Socket.IO and device credential storage are the only substituted boundaries.
const network = await installSessionOpsNetworkBoundary();
const { startProductionMachineLiveStream: startComputerLiveStream } = await import('@/sync/domains/machines/peer/mediation/stream/productionRoute');
const { storage } = await import('@/sync/domains/state/storageStore');

describe('Computer viewer source admission through the existing stream mint', () => {
    beforeEach(() => { network.resetRequests(); });
    afterAll(async () => { await network.dispose(); });

    it.each(['owner', 'manage', 'use'] as const)('opens a Session-less Machine-person source through the existing %s route', async role => {
        const home = await network.addHome(`https://machine-person-${role}.test`, `person-${role}`);
        const machineId = `person-machine-${role}`;
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain',
            ...(role !== 'owner' ? { isShared: true, access: { custodian: { accountId: 'owner', displayName: 'Owner' },
                role, resourceMode: 'plain', accessState: 'ready' } } : {}),
        })], false, { sourceServerId: home.id });
        const selection = { consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: true } };
        network.setRpcResponder(async request => {
            expect(request.method).toBe(role === 'use' ? RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE : RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE);
            expect(request.payload).toEqual({ actionId: 'computer.target.get', input: { machineId } });
            return { protocolVersion: 1, result: selection };
        });
        const { executeComputerActionViaMachineRpc, resolveComputerOwnDesktopOnly } = await import('./machineRpc');
        expect(await executeComputerActionViaMachineRpc({ machineId, serverId: home.id, accountId: home.accountId,
            actionId: 'computer.target.get', input: { machineId },
            ownDesktopOnly: resolveComputerOwnDesktopOnly({ machineId, serverId: home.id }),
        })).toEqual(selection);
    });

    it.each(['use', 'manage', 'owner'] as const)('admits the exact selected source for shared %s routing', async role => {
        const home = await network.addHome(`https://computer-stream-${role}.test`, `stream-${role}-account`);
        const machineId = `stream-${role}-machine`;
        const sourceId = `opaque-${role}-source`;
        const events: string[] = [];
        const sourceAdmission = MachineLiveStreamSourceAdmissionV1Schema.parse({
            payload: { version: 1, machineId, installationId: 'installation', accountId: 'machine-owner',
                liveStreamSourceAdmission: { homeServerIdentityId: home.id, actorAccountId: home.accountId,
                    streamFamily: 'screen', sourceId, sourceOccurrenceId: 'registered-occurrence' } },
            proof: { version: 1, algorithm: 'ed25519', signature: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url') },
        });
        let mintedBody: unknown;
        network.setRpcResponder(async request => {
            events.push('admit');
            expect(request.serverUrl).toBe(home.serverUrl);
            expect(request.token).toBe(home.token);
            expect(request.targetId).toBe(machineId);
            expect(request.method).toBe(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT);
            expect(DaemonMachineLiveStreamSourceAdmitRequestV1Schema.parse(request.payload)).toEqual({
                protocolVersion: 1, machineId, sourceId, streamFamily: 'screen',
            });
            return { protocolVersion: 1, result: { ok: true, sourceAdmission } };
        });
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                machines: { enabled: true, liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } } },
            } }));
            if (path === '/v1/machines/peer/mediation/route-grants') {
                events.push('mint');
                mintedBody = JSON.parse(String(init?.body));
                return Response.json({ ok: true, relayAuthorization: { payload: {
                    v: role !== 'owner' ? 2 : 1, grantId: 'server-grant', accountId: 'machine-owner',
                    sourceMachineId: machineId, targetMachineId: machineId, flowKind: 'live_stream', routeKind: 'server_relay',
                    streamId: 'viewer-stream', streamFamily: 'screen', sourceId, viewerSocketId: 'viewer-tab',
                    viewerCodecs: ['image.frame.v1'], iat: 1, exp: 2, aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
                    ...(role !== 'owner' ? { viewerAccountId: home.accountId, sourceMachineInstallationId: 'installation',
                        personalSourceAdmission: sourceAdmission.payload.liveStreamSourceAdmission } : {}),
                }, signature: { keyId: 'server-key', alg: 'Ed25519', valueBase64Url: 'signedbyserver' } } });
            }
            return null;
        });
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain',
            ...(role !== 'owner' ? { isShared: true, access: { custodian: { accountId: 'machine-owner', displayName: 'Owner' },
                role, resourceMode: 'plain', accessState: 'ready' } } : {}),
        })], false, { sourceServerId: home.id });
        const result = await startComputerLiveStream({ serverId: home.id, sourceMachineId: machineId,
            targetMachineId: machineId, sourceId, streamId: 'viewer-stream', streamFamily: 'screen',
            routeKind: 'server_relay', viewerSocketId: 'viewer-tab', caps: {}, viewerCodecs: ['image.frame.v1'] });
        expect(result).toMatchObject({ ok: true, startRequest: { sourceId, viewerSocketId: 'viewer-tab',
            authorization: { payload: { v: role !== 'owner' ? 2 : 1 } } } });
        if (role !== 'owner') expect(result).toMatchObject({ startRequest: { authorization: { payload: {
            personalSourceAdmission: sourceAdmission.payload.liveStreamSourceAdmission,
        } } } });
        expect(events).toEqual(role !== 'owner' ? ['admit', 'mint'] : ['mint']);
        expect(mintedBody).toMatchObject({ machineId, viewerSocketId: 'viewer-tab', scope: { sourceId } });
        if (role !== 'owner') expect(mintedBody).toHaveProperty('sourceAdmission', sourceAdmission);
        else expect(mintedBody).not.toHaveProperty('sourceAdmission');
    });

    it('keeps a source owner refusal visible without minting a grant', async () => {
        const home = await network.addHome('https://computer-stream-refusal.test', 'stream-refused-account');
        network.setHttpResponder(async request => new URL(String(request)).pathname === '/v1/features'
            ? Response.json(createRootLayoutFeaturesResponse({ features: {
                machines: { enabled: true, liveStream: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: true } } },
            } })) : null);
        const machineId = 'refused-machine';
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain', isShared: true,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
        })], false, { sourceServerId: home.id });
        network.setRpcResponder(async () => ({ protocolVersion: 1, result: { ok: false, reasonCode: 'capture_source_denied' } }));
        const result = await startComputerLiveStream({ serverId: home.id, sourceMachineId: machineId,
            targetMachineId: machineId, sourceId: 'foreign-source', streamId: 'viewer-stream', streamFamily: 'screen',
            routeKind: 'server_relay', caps: {} });
        expect(result).toEqual({ ok: false, reasonCode: 'capture_source_denied' });
        expect(network.httpRequests.some(request => new URL(request.url).pathname.endsWith('/route-grants'))).toBe(false);
    });

    it.each([1, 2] as const)('delivers a v%s carrier through its compatible existing relay owner', async version => {
        const home = await network.addHome(`https://computer-carrier-${version}.test`, `carrier-${version}-account`);
        const machineId = `carrier-${version}-machine`;
        storage.getState().applyMachines([createMachineFixture({ id: machineId, storageMode: 'plain' })], false, { sourceServerId: home.id });
        const base = { sourceMachineId: machineId, targetMachineId: machineId, routeKind: 'server_relay',
            streamId: 'viewer-stream', streamFamily: 'screen', sourceId: 'opaque-source', viewerSocketId: 'viewer-tab' };
        const startRequest = MachineLiveStreamStartRequestV1Schema.parse({ v: 1, ...base,
            authorization: { payload: { v: version, ...base, grantId: 'server-grant', accountId: 'machine-owner',
                flowKind: 'live_stream', iat: 1, exp: 2, aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
                ...(version === 2 ? { viewerAccountId: home.accountId, sourceMachineInstallationId: 'installation',
                    personalSourceAdmission: { homeServerIdentityId: home.id, actorAccountId: home.accountId,
                        streamFamily: 'screen', sourceId: 'opaque-source', sourceOccurrenceId: 'registered-occurrence' } } : {}) },
                signature: { keyId: 'server-key', alg: 'Ed25519', valueBase64Url: 'signedbyserver' } },
        });
        let observedMethod: string | null = null;
        network.setRpcResponder(async request => {
            observedMethod = request.method;
            expect(request.payload).toMatchObject({ protocolVersion: 1, machineId, startRequest });
            return { protocolVersion: 1, result: { ok: true, streamId: startRequest.streamId } };
        });
        const { startMachineLiveStreamRelayViaMachineRpc } = await import('@/sync/domains/machines/peer/mediation/stream/relayStartRpc');
        expect(await startMachineLiveStreamRelayViaMachineRpc({ machineId, serverId: home.id, startRequest }))
            .toEqual({ ok: true, streamId: startRequest.streamId });
        expect(observedMethod).toBe(version === 2 ? RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_PERSONAL_RELAY_START : RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START);
    });
});
