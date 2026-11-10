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
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductBrowserSidecarControlAdapterFactory } from '@/daemon/browser/sidecar/productSource';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from '@/daemon/browser/sidecar/launchOwner';
import { createBrowserProfileStore } from '@/daemon/browser/profiles/store';
import { createBrowserStoragePartitionOwner } from '@/daemon/browser/storage/partitions';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createBrowserCdpScreencastProducer } from '@/daemon/browser/capture/cdpScreencast';
import { registerBrowserLiveCapture } from '@/daemon/browser/capture/registration';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';

describe('personal live stream source admission RPC', () => {
    it('admits shared View/Steer without Machine access while preserving profile and unshared-guest isolation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'browser-source-admission-'));
        const profiles = createBrowserProfileStore({ storageRootDirectory: root,
            partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
        const runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
            readSessionAccountId: (sessionId: string) => sessionId === 'guest-session' ? 'guest'
                : sessionId === 'owner-session' ? 'owner' : null,
            resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/fixture/chrome',
                discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                    pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
            createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
                // Only the Chromium process and CDP connection are substituted.
                spawnProcess: () => {
                    const child = new EventEmitter();
                    return Object.assign(child, { pid: 4242, stderr: new PassThrough(),
                        stdio: [null, null, null, new PassThrough(), new PassThrough()],
                        kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
                },
                connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'page', sessionId: 'cdp' }),
                    dispatchPageCommand: async () => ({}), dispatchBrowserCommand: async () => ({ success: true }) } }),
            }),
        })({ machineId: 'machine', readMachineMemory: () => ({ reported: true, totalBytes: 12 * 1024 ** 3,
            availableBytes: 12 * 1024 ** 3, usedBytes: 0, pressure: { level: 'calm', source: 'none' } }) });
        if (!runtime.ok || !runtime.contextCapture) throw new Error('Browser runtime unavailable');
        const registry = createMachineLiveStreamCaptureRegistry();
        const producer = createBrowserCdpScreencastProducer({ contextCapture: runtime.contextCapture });
        const registration = registerBrowserLiveCapture({ registry, contextCapture: runtime.contextCapture, producer, automation: () => null });
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(runtime.adapter);
        const browser = createBrowserDaemonControlRoutes({ broker, captureRegistry: registry });
        const keys = tweetnacl.sign.keyPair();
        const installation = MachineInstallationIdentityV1Schema.parse({ version: 1, installationId: 'installation', createdAt: 0,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const handlers = new Map<string, RpcHandler<unknown, unknown>>();
        registerMachineLiveStreamSourceAdmissionHandler({ registerHandler(method, handler) {
            // Untyped RPC transport boundary; the production request parser and signing are real.
            handlers.set(method, handler as RpcHandler<unknown, unknown>);
        } }, { machineId: 'machine', resolveComputer: () => null, resolveBrowser: () => browser,
            readInstallationIdentity: () => installation, readHomeServerIdentityId: () => 'home' });
        const context = (actorAccountId: string, role: 'use' | 'manage'): RpcHandlerContext => ({
            signal: new AbortController().signal,
            callerAuthority: 'present_user', machineAdmission: { actorAccountId, role,
                custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', encryptionMode: 'plain' },
        });
        const invoke = async (browserSessionId: string, actorAccountId: string, role: 'use' | 'manage') =>
            DaemonMachineLiveStreamSourceAdmitResponseV1Schema.parse(await handlers.get(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT)?.({
                protocolVersion: 1, machineId: 'machine', streamFamily: 'browser.streamed',
                sourceId: browserViewKey({ browserSessionId, viewId: 'view' }),
            }, context(actorAccountId, role)));
        try {
            for (const browserSessionId of ['owner-session', 'guest-session', 'unattributed-session']) {
                const opened = await browser.dispatchCommand({ kind: 'openView', commandId: browserSessionId, browserSessionId,
                    viewId: 'view', platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://fixture.test/' } });
                expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'dispatched' });
            }
            for (const level of ['view', 'edit'] as const) {
                const shared: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
                    authorization: { kind: 'session.browser', sessionId: 'owner-session', actorAccountId: 'guest',
                        custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
                        effectiveAccess: { v: 1, level, sources: [{ kind: 'direct', shareId: 'share' }],
                            capabilities: projectSessionAccessCapabilitiesV1({ owner: false,
                                grants: [{ accessLevel: level, canApprovePermissions: false }] }) } } };
                const admitted = await handlers.get(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT)?.({
                    protocolVersion: 1, machineId: 'machine', streamFamily: 'browser.streamed',
                    sourceId: browserViewKey({ browserSessionId: 'owner-session', viewId: 'view' }),
                }, shared);
                expect(admitted, `Session ${level} can watch without Machine admission`).toMatchObject({ result: {
                    ok: true, sourceAdmission: { payload: { liveStreamSourceAdmission: { sessionBrowserSessionId: 'owner-session' } } } } });
                const actionContext = buildActionExecutorContextForRpc(shared);
                expect(await browser.dispatchCommand({ kind: 'closeView', commandId: `shared-${level}`,
                    browserSessionId: 'owner-session', viewId: 'view' }, actionContext))
                    .toMatchObject({ status: level === 'view' ? 'failed' : 'dispatched' });
                expect(browser.listViews('owner-session', actionContext)).toHaveLength(level === 'view' ? 1 : 0);
                expect(await browser.dispatchCommand({ kind: 'openView', commandId: `reopen-${level}`,
                    browserSessionId: 'owner-session', viewId: 'view', platform: 'web',
                    target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://fixture.test/' } }))
                    .toMatchObject({ status: 'dispatched' });
                expect(await handlers.get(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT)?.({
                    protocolVersion: 1, machineId: 'machine', streamFamily: 'browser.streamed',
                    sourceId: browserViewKey({ browserSessionId: 'guest-session', viewId: 'view' }),
                }, shared)).toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
                await profiles.registerPersistentProfile({ profileId: `persistent-${level}`, storageMode: 'user', owner: { kind: 'user', id: 'owner' } });
                const persistentSession = 'owner-session';
                expect(await browser.dispatchCommand({ kind: 'closeView', commandId: `close-ephemeral-${level}`,
                    browserSessionId: persistentSession, viewId: 'view' })).toMatchObject({ status: 'dispatched' });
                const persistentOpened = await browser.dispatchCommand({ kind: 'openView', commandId: persistentSession,
                    browserSessionId: persistentSession, viewId: 'view', profileId: `persistent-${level}`, platform: 'web',
                    target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://fixture.test/' } });
                expect(persistentOpened, JSON.stringify(persistentOpened)).toMatchObject({ status: 'dispatched' });
                if (shared.authorization?.kind !== 'session.browser') throw new Error('expected Session authority');
                const persistentContext = { ...shared, authorization: { ...shared.authorization, sessionId: persistentSession } };
                expect(await handlers.get(RPC_METHODS.DAEMON_MACHINE_LIVE_STREAM_SOURCE_ADMIT)?.({
                    protocolVersion: 1, machineId: 'machine', streamFamily: 'browser.streamed',
                    sourceId: browserViewKey({ browserSessionId: persistentSession, viewId: 'view' }),
                }, persistentContext)).toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
                expect(await browser.dispatchCommand({ kind: 'closeView', commandId: `close-persistent-${level}`,
                    browserSessionId: persistentSession, viewId: 'view' })).toMatchObject({ status: 'dispatched' });
                expect(await browser.dispatchCommand({ kind: 'openView', commandId: `reopen-ephemeral-${level}`,
                    browserSessionId: persistentSession, viewId: 'view', platform: 'web',
                    target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://fixture.test/' } }))
                    .toMatchObject({ status: 'dispatched' });
            }
            expect(await invoke('guest-session', 'guest', 'use')).toMatchObject({ result: { ok: true } });
            expect(await invoke('owner-session', 'owner', 'use')).toMatchObject({ result: { ok: true } });
            expect(await invoke('guest-session', 'owner', 'use')).toMatchObject({ result: { ok: true } });
            expect(await invoke('owner-session', 'guest', 'manage')).toMatchObject({ result: { ok: true } });
            expect(await invoke('owner-session', 'guest', 'use')).toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
            expect(await invoke('guest-session', 'other-guest', 'use')).toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
            expect(await invoke('unattributed-session', 'guest', 'use')).toMatchObject({ result: { ok: false, reasonCode: 'capture_source_denied' } });
        } finally {
            registration.dispose(); await producer.dispose(); await runtime.dispose?.();
            await rm(root, { recursive: true, force: true });
        }
    });
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
