import axios from 'axios';
import nacl from 'tweetnacl';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_ROUTE_GRANT_AUDIENCE_V1, IrohMachineHandshakeV1Schema, createDirectRouteGrantSigningInputV2, type DirectRouteGrantPayloadV2 } from '@happier-dev/protocol';
import { DirectRouteGrantRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeDeploymentChildExecutionV1, verifyExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { IrohNativeOperationError } from '@happier-dev/iroh-native/node';
import * as persistence from '@/persistence';
import * as serverProfiles from '@/server/serverProfiles';
import { createDirectTransferServerLifecycle } from './directTransferServerLifecycle';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from './createPreparedFilesystemTransferActionExecutor';
import { EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
// Transform the real, lazily imported API graph during collection, not inside
// the transport contract's test deadline. No API owner is replaced.
import '@/api/api';
import { createCredentialedFilesystemTransferClient } from './createCredentialedFilesystemTransferClient';

// The addon is the native/OS boundary. Runtime ownership, grant/proof creation,
// installed requester custody and HTTP signing remain real.
const nativeBoundary = vi.hoisted(() => ({ load: vi.fn(), dial: vi.fn() }));
vi.mock('@happier-dev/iroh-native/node', async original => ({
    ...await original<typeof import('@happier-dev/iroh-native/node')>(), loadIrohNodeNative: nativeBoundary.load,
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('credentialed deployment archive byte transport', () => {
    it('retains the installed finite actor while using only exact root-scoped Machine and grant reads, then refuses withdrawal', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const fixture = await createDeploymentChildRequesterHarness();
        const directory = await mkdtemp(join(tmpdir(), 'happier-private-archive-copy-'));
        const sourceRoot = join(directory, 'source');
        const destinationRoot = join(directory, 'destination');
        await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
        const lifecycle = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
        const nativeEffect = createPreparedFilesystemTransferActionExecutor({ lifecycle, workingDirectory: directory,
            accessPolicy: { kind: 'restrictedRoots', roots: [sourceRoot, destinationRoot] } });
        const issuer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
        const trustRoot = { keyId: 'archive-issuer', publicKey: Buffer.from(issuer.publicKey).toString('base64url') };
        const holderKey = new Uint8Array(32).fill(82);
        const publishedKey = Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: holderKey,
            recipientPublicKey: nacl.box.keyPair.fromSecretKey(fixture.machineKey).publicKey,
            randomBytes: nacl.randomBytes })).toString('base64');
        const codec = createMachineContentCodec({ encryptionKey: holderKey, encryptionVariant: 'dataKey' });
        if (codec.mode !== 'e2ee') throw new Error('Expected private finite payload codec');
        const content = { mode: 'e2ee' as const, cipher: { encryptRaw: async (value: unknown) => codec.encodeRpc(value),
            decryptRaw: async (value: string) => codec.decodeRpc(value) } };
        const archiveOrigin = { environmentId: fixture.job.input.environmentId, deploymentId: 'deployment',
            holderMachineId: 'holder', holderInstallationId: 'holder-installation' };
        let expectedSignedOrigin = archiveOrigin;
        const machineReads: string[] = [];
        const grantActors: string[] = [];
        const paths: string[] = [];
        const phases: string[] = [];
        const accepted: unknown[] = [];
        const terminalReads: Array<() => Promise<unknown>> = [];
        const boundaryErrors: unknown[] = [];
        let current = true;
        let sequence = 0;
        const operations = new Map(['holder', fixture.job.machineId].map(machineId => [machineId,
            createHostActionOperationRuntime({ serverId: fixture.homeIdentityId, machineId,
                custodyBinding: { serverId: fixture.homeIdentityId, installationId: machineId === 'holder'
                    ? archiveOrigin.holderInstallationId : fixture.installed.installationId }, resolveAccountId: async () => 'ann',
                generateOperationId: () => `archive-child-${++sequence}` })]));
        // Profile and credential files are OS boundaries. The same real resolver
        // captures them before the private target_copy invocation.
        vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(fixture.ann);
        vi.spyOn(serverProfiles, 'getServerProfile').mockResolvedValue({ id: fixture.profileId, name: 'Home',
            serverUrl: fixture.serverHttpBaseUrl, webappUrl: fixture.serverHttpBaseUrl, createdAt: 0, updatedAt: 0, lastUsedAt: 0 });
        const proof = (headers: Readonly<Record<string, unknown>>, method: string, path: string, body?: unknown) => {
            expect(headers.Authorization).toBeUndefined();
            expect(headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(fixture.root.token);
            const decoded = decodeDeploymentChildExecutionV1(String(headers[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER] ?? ''),
                String(headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] ?? ''));
            expect(decoded?.archiveOrigin).toEqual(expectedSignedOrigin);
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: fixture.root.token, effectActionId: fixture.job.actionId,
                target: fixture.root.binding.target, installationId: fixture.installed.installationId,
                requestId: fixture.root.binding.requestId, method, path, body, deploymentChildExecution: decoded ?? undefined,
                signature: String(headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: fixture.receiver.publicKey })).toBe(true);
        };
        vi.spyOn(axios, 'get').mockImplementation(async (url: string, options) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: {
                id: options?.headers?.Authorization === `Bearer ${fixture.ann.token}` ? 'ann' : 'bob' } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: fixture.currentness };
            if (path === '/v1/machines' || path === '/v1/machines/holder' || path === `/v1/machines/${fixture.job.machineId}`) {
                machineReads.push(path);
                // Ann is not a member of the Source Team and has no ambient holder grant.
                if (path === '/v1/machines') throw Object.assign(new Error('Ann cannot list the holder'), { code: 'action_forbidden' });
                proof(options?.headers ?? {}, 'GET', path);
                const machineId = path.split('/').at(-1)!;
                return { status: 200, data: { machine: { id: machineId, kind: 'persistent', active: true,
                    installationId: machineId === 'holder' ? archiveOrigin.holderInstallationId : fixture.installed.installationId,
                    storageMode: 'e2ee', dataEncryptionKey: publishedKey,
                    revokedAt: null, replacedByMachineId: null,
                    operationProtocolCapabilities: { irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) } },
                    operationProtocolCapabilitiesRevision: 1 } } };
            }
            throw new Error(`Unexpected transfer HTTP read: ${path}`);
        });
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
            const [url, init] = args;
            if (new URL(String(url)).pathname.startsWith('/v1/features')) return Response.json({ features: {}, capabilities: {
                machines: { peerMediation: { grantSigningKeys: [trustRoot] } } } });
            return nativeFetch(url, init);
        }));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            expect(path).toBe('/v1/machines/peer/mediation/route-grants');
            proof(options?.headers ?? {}, 'POST', path, body);
            const request = DirectRouteGrantRequestV2Schema.parse(body);
            const now = Date.now();
            const payload = { v: 2, grantId: 'finite-archive-grant', accountId: 'ann', machineId: request.machineId,
                flowKind: request.flowKind, routeKind: request.routeKind, scope: request.scope, iat: now, exp: now + request.ttlMs,
                aud: DIRECT_ROUTE_GRANT_AUDIENCE_V1, endpointFingerprint: request.endpointFingerprint,
                iroh: request.iroh, proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url } satisfies DirectRouteGrantPayloadV2;
            grantActors.push(payload.accountId);
            return { status: 200, data: { ok: true, grant: { payload, signature: { alg: 'Ed25519', keyId: trustRoot.keyId,
                valueBase64Url: Buffer.from(nacl.sign.detached(Buffer.from(createDirectRouteGrantSigningInputV2(payload)), issuer.secretKey)).toString('base64url') } } } };
        });
        nativeBoundary.dial.mockImplementation(async (request: { handshakeJson: string }) => {
            expect(IrohMachineHandshakeV1Schema.parse(JSON.parse(request.handshakeJson)).accountId).toBe('ann');
            return { machineTunnelId: 'archive-tunnel', endpointHandle: 'archive-endpoint', localPort: await lifecycle.ensureListening(),
                connectionActive: true, remoteEndpointId: 'b'.repeat(64), observedPath: 'direct', startedAtMs: 1, lastErrorCode: null };
        });
        nativeBoundary.load.mockReturnValue({ available: true, native: {
            createEndpoint: async () => ({ endpointHandle: 'archive-endpoint', endpointId: 'a'.repeat(64) }),
            getEndpointStatus: async () => ({ active: true, endpointId: 'a'.repeat(64), relayUrls: [], directAddresses: [] }),
            startMachineTunnel: nativeBoundary.dial, stopMachineTunnel: async () => {}, shutdownEndpoint: async () => {},
        } });
        let prepared: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
        let client: Awaited<ReturnType<typeof createCredentialedFilesystemTransferClient>> | undefined;
        try {
            prepared = await fixture.prepare();
            const context = { externalActionExecutionAuthorization: prepared.authorization, originalActionEnvelope: fixture.envelope,
                externalActionTarget: fixture.root.binding.target, signal: new AbortController().signal };
            client = await createCredentialedFilesystemTransferClient({ credentials: fixture.ann, serverId: fixture.profileId,
                serverApiUrl: fixture.serverHttpBaseUrl, executeAction: async () => { throw new Error('No filesystem phase requested by carrier admission'); },
                deploymentArchive: { context, machineId: fixture.job.machineId, installationId: fixture.installed.installationId,
                    privateKey: fixture.installed.privateKey, archiveOrigin, async assertCurrent() {} } });
            let failure: unknown;
            try {
                const tunnel = await client.openMachineTunnel({ targetMachineId: 'holder', serverId: fixture.profileId });
                await tunnel.close();
            } catch (error) { failure = error; }
            expect(machineReads).not.toContain('/v1/machines');
            expect(machineReads).toContain('/v1/machines/holder');
            expect(failure).toBeUndefined();
            expect(grantActors).toEqual(['ann']);
            expect(paths).toEqual(['/v1/machines/peer/mediation/route-grants']);
            // The Socket.IO boundary stands in for Home/manager admission here;
            // the S0 journey owns that admission. The operation, acceptance,
            // entry capture, encrypted byte HTTP and terminal owners stay real.
            channel.server.on('connection', socket => {
                if (socket.handshake.auth.token !== fixture.ann.token) return;
                socket.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, ack: (result: unknown) => void) => {
                    void (async () => {
                        const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
                        const machineId = packet.method.slice(0, packet.method.indexOf(':'));
                        const method = packet.method.slice(packet.method.indexOf(':') + 1);
                        const runtime = operations.get(machineId);
                        if (!runtime || !packet.externalActionExecution) throw new Error('Unexpected finite receiver');
                        const parent = packet.externalActionExecution.deploymentChildExecution;
                        expect(parent?.archiveOrigin).toEqual(archiveOrigin);
                        expect(packet.externalActionExecution.authorization.binding).toEqual(fixture.root.binding);
                        expect(packet.externalActionExecution.authorization.requesterAccountContext).toBeUndefined();
                        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: fixture.root.token,
                            effectActionId: packet.externalActionExecution.effectActionId, target: fixture.root.binding.target,
                            installationId: fixture.installed.installationId, method: packet.method, requestId: packet.requestId!,
                            params: packet.params, deploymentChildExecution: parent,
                            signature: packet.externalActionExecution.machineSignature, publicKey: fixture.receiver.publicKey })).toBe(true);
                        const rpcContext = { signal: context.signal, callerInputAuthorization: packet.externalActionExecution.authorization,
                            workspaceSyncSourceExecution: { method: packet.method, requestId: packet.requestId!,
                                params: StrictJsonValueSchema.parse(decoded.params), originalActionEnvelope: fixture.envelope,
                                externalActionExecution: packet.externalActionExecution },
                            machineAdmission: { actorAccountId: 'ann', custodianAccountId: 'ann', machineId,
                                installationId: machineId === 'holder' ? archiveOrigin.holderInstallationId : fixture.installed.installationId,
                                role: 'use' as const, encryptionMode: 'e2ee' as const }, verifyMachineAdmissionCurrent: async () => current };
                        let response: unknown;
                        if (method === ACTION_OPERATION_RPC_METHODS_V2.get) {
                            phases.push('action.operations.get');
                            response = await runtime.handlers.getV2(decoded.params, rpcContext);
                        } else {
                            const request = TargetedActionRpcRequestV1Schema.parse(decoded.params);
                            const actionId = machineId === 'holder' ? 'daemon.filesystem.download' as const : 'daemon.filesystem.copy' as const;
                            expect(request.target).toEqual({ kind: 'machine', machineId });
                            phases.push(actionId);
                            const result = await runtime.observeExecution({ actionId, input: request.input, rpcContext,
                                execute: operation => nativeEffect({ actionId, input: request.input,
                                    context: { ...operation, serverId: fixture.profileId, runtimeAccountId: 'ann',
                                        externalActionTarget: { kind: 'machine', machineId } }, requesterAccountId: 'ann',
                                    assertCurrentAuthority: async () => { if (!current) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' }); }
                                }).then(projectPreparedFilesystemActionResult) });
                            if (result.ok) {
                                accepted.push(result.result);
                                const receipt = result.result;
                                if (receipt && typeof receipt === 'object' && 'operationId' in receipt && typeof receipt.operationId === 'string') {
                                    const operationId = receipt.operationId;
                                    terminalReads.push(() => callExactMachineRpc({ credentials: fixture.ann,
                                        machineId, serverUrl: fixture.serverHttpBaseUrl, method: ACTION_OPERATION_RPC_METHODS_V2.get,
                                        request: { operationId, waitForTerminal: true }, timeoutMs: null,
                                        externalAction: { context, effectActionId: 'action.operations.get',
                                            installationId: fixture.installed.installationId, privateKey: fixture.installed.privateKey,
                                            deploymentArchiveOrigin: archiveOrigin } }));
                                }
                            }
                            response = result.ok ? result.result : result;
                        }
                        ack({ ok: true, result: await socketRpcCodec.encodeResponse(content, response, decoded.callId) });
                    })().catch(error => { boundaryErrors.push(error); ack({ ok: false, error: 'Finite boundary refused' }); });
                });
            });
            const executor = createCliActionExecutorFromCredentials({ credentials: fixture.ann, readCredentials: async () => fixture.ann,
                serverId: fixture.profileId, serverIdentityId: fixture.homeIdentityId, serverApiUrl: fixture.serverHttpBaseUrl,
                machineId: fixture.job.machineId, externalActionMachineInstallationId: fixture.installed.installationId,
                externalActionMachineRequestPrivateKey: fixture.installed.privateKey });
            const bytes = Buffer.from([0, 255, 128, 10, 13, 42]);
            await writeFile(join(sourceRoot, 'image.tar'), bytes);
            const copy = (name: string, origin = archiveOrigin, signal = context.signal) => executor.executeDeploymentChildFilesystemAction({ actionId: 'daemon.filesystem.copy',
                input: { kind: 'target_copy', source: { serverId: fixture.profileId, machineId: 'holder', rootPath: sourceRoot, path: 'image.tar' },
                    destination: { serverId: fixture.profileId, machineId: fixture.job.machineId, rootPath: destinationRoot, path: name },
                    overwrite: false, recursive: false }, context: { ...context, signal }, archiveOrigin: origin, async assertCurrent() {} });
            const copied = await copy('received.tar');
            expect(copied, JSON.stringify({ copied, boundaryErrors, phases })).toMatchObject({ ok: true, result: { success: true, status: 'completed' } });
            expect(await readFile(join(destinationRoot, 'received.tar'))).toEqual(bytes);
            expect(accepted).toEqual([expect.objectContaining({ status: 'accepted', entryTree: expect.any(Object), prepared: expect.any(Object) }),
                expect.objectContaining({ status: 'accepted', prepared: expect.objectContaining({ manifest: expect.any(Object) }) })]);
            expect(phases).toContain('action.operations.get');
            expect(await Promise.all(terminalReads.map(read => read()))).toEqual(expect.arrayContaining([
                expect.objectContaining({ operation: expect.objectContaining({ actionId: 'daemon.filesystem.download', state: 'succeeded' }) }),
                expect.objectContaining({ operation: expect.objectContaining({ actionId: 'daemon.filesystem.copy', state: 'succeeded' }) })]));
            expect(boundaryErrors).toEqual([]);
            const phasesBeforeWrongOrigin = phases.length;
            expectedSignedOrigin = { ...archiveOrigin, holderInstallationId: 'replaced-holder-installation' };
            expect(await copy('wrong-origin.tar', expectedSignedOrigin)).toMatchObject({ ok: false, errorCode: 'machine_target_not_current' });
            expect(phases).toHaveLength(phasesBeforeWrongOrigin);
            await expect(readFile(join(destinationRoot, 'wrong-origin.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
            expectedSignedOrigin = archiveOrigin;
            nativeBoundary.dial.mockRejectedValueOnce(new IrohNativeOperationError('transport-unavailable', 'Direct and relay transport unavailable'));
            expect(await copy('unreachable.tar')).toMatchObject({ ok: false, errorCode: 'machine_carrier_unavailable' });
            await expect(readFile(join(destinationRoot, 'unreachable.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
            nativeBoundary.dial.mockRejectedValueOnce(new IrohNativeOperationError('endpoint-identity-mismatch', 'Wrong authenticated native endpoint'));
            expect(await copy('identity-mismatch.tar')).toMatchObject({ ok: false, errorCode: 'identity_mismatch' });
            await expect(readFile(join(destinationRoot, 'identity-mismatch.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
            const cancellation = new AbortController();
            nativeBoundary.dial.mockImplementationOnce(async () => {
                cancellation.abort();
                throw new IrohNativeOperationError('transport-unavailable', 'Dial stopped after caller cancellation');
            });
            const cancelled = await copy('cancelled.tar', archiveOrigin, cancellation.signal);
            expect(cancelled).toMatchObject({ ok: false, details: { status: 'cancelled' } });
            expect(cancelled).not.toMatchObject({ errorCode: 'machine_carrier_unavailable' });
            await expect(readFile(join(destinationRoot, 'cancelled.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
            const readsBeforeWithdrawal = machineReads.length;
            const grantsBeforeWithdrawal = grantActors.length;
            current = false;
            fixture.setCurrent(false);
            expect(await copy('withdrawn.tar')).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
            await expect(client.openMachineTunnel({ targetMachineId: 'holder', serverId: fixture.profileId })).rejects.toMatchObject({ code: 'action_forbidden' });
            expect(machineReads).toHaveLength(readsBeforeWithdrawal);
            expect(grantActors).toHaveLength(grantsBeforeWithdrawal);
        } finally { await client?.close(); await lifecycle.stop(); await prepared?.dispose(); await channel.close();
            await rm(directory, { recursive: true, force: true }); }
    });
});
