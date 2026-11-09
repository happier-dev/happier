import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonMachineLiveStreamSourceAdmitResponseV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/relayStartRpcV1';
import { MachineInstallationIdentityV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import tweetnacl from 'tweetnacl';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createComputerRoutes } from '@/daemon/computer/routes';
import { createComputerCaptureSource } from '@/daemon/computer/source';
import { createMachineLiveStreamCaptureRegistry } from './captureRegistry';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { registerMachineLiveStreamSourceAdmissionHandler } from './sourceAdmission';

describe('personal live stream source admission RPC', () => {
    it('signs the real Computer owner admission and refuses owner and other-person sources', async () => {
        const keys = tweetnacl.sign.keyPair();
        const installation = MachineInstallationIdentityV1Schema.parse({ version: 1, installationId: 'installation', createdAt: 0,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const registry = createMachineLiveStreamCaptureRegistry();
        const admission = { machineId: 'machine', installationId: installation.installationId,
            actorAccountId: 'guest', custodianAccountId: 'owner', role: 'use' as const, encryptionMode: 'plain' as const };
        const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user', machineAdmission: admission,
            verifyMachineAdmissionCurrent: async () => true };
        const identity = selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'home', hostCustodianAccountId: 'owner',
            hostExecutionTarget: { machineId: 'machine', installationId: installation.installationId }, actionContext: {
                authority: 'present_user', machineAdmission: admission, verifyMachineAdmissionCurrent: async () => true } });
        if (identity.kind !== 'isolated') throw new Error('expected guest identity');
        const desktopKey = deriveAgentIsolationMemberIdentity({ requester: identity.requester, homeServerIdentityId: 'home' }).digest;
        const sources = [desktopKey, 'another-person', undefined].map((key, index) => createComputerCaptureSource({
            sessionId: `session-${index}`, target: { kind: 'display', displayId: `:${20 + index}` }, desktopKey: key }));
        for (const computer of sources) registry.register({ sourceId: computer.sourceId, streamFamily: 'screen',
            computer, adapter: computer.adapter, capabilities: { v: 1, sourceId: computer.sourceId, sourceKind: 'screen',
                supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
        const computer = createComputerRoutes({ machineId: 'machine', registry, requesterHost: {
            custodianAccountId: 'owner', installationId: installation.installationId, readHomeServerIdentityId: async () => 'home',
            prepareNativeOperation: async () => { throw new Error('admission must not launch a process'); },
        } });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
            // Simulate the untyped RPC transport; the real handler parses its request schema.
            handlers.set(method, handler as RpcHandler<unknown, unknown>);
        } };
        registerMachineLiveStreamSourceAdmissionHandler(registrar, { machineId: 'machine', resolveComputer: () => computer,
            readInstallationIdentity: () => installation });
        const invoke = (sourceId: string, ingress = context) => handlers.get(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT)?.({
            protocolVersion: 1, machineId: 'machine', streamFamily: 'screen', sourceId }, ingress);
        const result = DaemonMachineLiveStreamSourceAdmitResponseV1Schema.parse(await invoke(sources[0]!.sourceId));
        expect(result).toMatchObject({ protocolVersion: 1, result: { ok: true, sourceAdmission: { payload: {
            machineId: 'machine', installationId: installation.installationId, accountId: 'owner', liveStreamSourceAdmission: {
                homeServerIdentityId: 'home', actorAccountId: 'guest', sourceId: sources[0]!.sourceId,
                sourceOccurrenceId: expect.any(String), streamFamily: 'screen' } } } } });
        if (!result?.result.ok) throw new Error('expected signed admission');
        expect(verifyMachineInstallationProof({ publicKey: installation.publicKey, payload: result.result.sourceAdmission.payload,
            proof: result.result.sourceAdmission.proof })).toBe(true);
        for (const source of sources.slice(1)) expect(await invoke(source.sourceId))
            .toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
        const manager = { ...context, machineAdmission: { ...admission, role: 'manage' as const } };
        expect(await invoke(sources[2]!.sourceId, manager)).toMatchObject({ result: { ok: true } });
        expect(await invoke(sources[0]!.sourceId, manager)).toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
        expect(await invoke(sources[0]!.sourceId, { ...context, callerAuthority: 'account_automation' }))
            .toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
        await computer.dispose();
    });
});
