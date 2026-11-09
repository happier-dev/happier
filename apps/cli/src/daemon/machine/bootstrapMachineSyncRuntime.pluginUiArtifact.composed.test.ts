import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { Server } from 'node:net';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import { PreparedTransferRpcResponseV1Schema } from '@happier-dev/protocol/machines/transfer/preparedTransferRpcV1';
import { TransferChunkEnvelopeSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';

import type { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from '@/api/machine/rpcHandlers';
import { configuration } from '@/configuration';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { resolveDirectPeerTransferChunkBytes } from '@/machines/transfer/transferRuntimeConfig';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { reserveEphemeralPort } from '@/testkit/http/portUtils';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '@/daemon/serverWork';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt } from './bootstrapMachineSyncRuntime';

describe('production Machine Plugin UI Artifact export composition', () => {
    it('registers the digest reader and serves a cold multi-megabyte Artifact through the incumbent bounded Home phases', async () => {
        const bytes = new Uint8Array(4 * 1024 * 1024).fill(97);
        const relativePath = 'hosted-web/panel/index.html';
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]);
        const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'panel', tier: 'hostedWeb', entry: relativePath,
            digest, files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.length }],
            builtWith: { staging: 'staticDirectory' }, hostUiApiRange: '^1.0.0' });
        const author = definePlugin({ id: 'artifact.transfer', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            ui: { renderers: [{ id: 'panel', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'panel' } }] } });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
            controller: pluginReloadController, coldStart: true, plugins: [{ manifest: author.manifest,
                files: { 'daemon.mjs': 'export function activate() {}',
                    [`${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/ui-artifacts.json`]: JSON.stringify({ version: 2, entries: [graph] }),
                    [`${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/${relativePath}`]: bytes } }] });
        const lifecycle = createDirectTransferServerLifecycle({ bindPort: await reserveEphemeralPort(), listenerClasses: [] });
        const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
        const payloadWrites = vi.spyOn(fs, 'writeFile');
        let registration: ReturnType<typeof registerMachineRpcHandlers> | undefined;
        // Only the physical Machine socket/subscription boundary is substituted.
        // Bootstrap constructs the export handler, and the real registration,
        // source admission, prepared HTTP handler and encryption stay composed.
        const transport = { ...createApiMachineTransportFixture(), connect() {},
            updateDaemonState: async () => {}, updateMachineMetadata: async () => {},
            emitExternalSessionTranscriptUpdate() {}, sendMachineTransferEnvelope() {}, sendTransferRelayV2Envelope() {},
            setRPCHandlers: ((handlers, deps) => {
                registration = registerMachineRpcHandlers({ rpcHandlerManager: manager, handlers, deps });
                return registration;
            }) satisfies ApiMachineClient['setRPCHandlers'],
        };
        let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
        try {
            runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId: 'artifact-machine',
                machine: { id: 'artifact-machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
                preferredHost: 'localhost', happyHomeDir: configuration.happyHomeDir, happyLibDir: configuration.happyHomeDir,
                filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
                createConnectedApiMachine: () => transport as unknown as ApiMachineClient,
                attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
                startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
                spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
                spawnSessionForInternalResume: async () => ({ type: 'success', sessionId: 'unused' }),
                stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
                loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown() {},
                directPeerServerLifecycle: lifecycle, directTransferRegistryHost: createCliRegistryHostV1(),
                connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null,
                daemonServerWorkScheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
                getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {} }) }),
            });
            const request = { t: 'plugin_ui_artifact_download_v1', request: {
                artifactFamily: 'hostedWeb', machineId: 'artifact-machine', cacheIdentity: { artifactDigest: digest },
            } };
            const cancellation = new AbortController();
            const originalListen = Server.prototype.listen;
            const nativeListener = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server, ...args: unknown[]) {
                const listening = Reflect.apply(originalListen, this, args) as Server;
                // The actual OS listener starts only after publication's
                // pre-check, reproducing cancellation across its awaited start.
                cancellation.abort();
                return listening;
            });
            try {
                expect(await manager.invokeLocal(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
                    request, { signal: cancellation.signal })).toMatchObject({ success: false });
                expect(nativeListener).toHaveBeenCalled();
                expect(lifecycle.getState().publishedTransferCount).toBe(0);
            } finally { nativeListener.mockRestore(); }
            const raw = await manager.invokeLocal(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, request);
            expect(raw, JSON.stringify(raw)).toMatchObject({ success: true, name: 'plugin-ui-artifact.json' });
            if (!raw || typeof raw !== 'object' || !('transferId' in raw) || typeof raw.transferId !== 'string'
                || !('endpointCandidates' in raw) || !Array.isArray(raw.endpointCandidates)) throw new Error('Missing prepared Artifact');
            const prepared = raw as { transferId: string; endpointCandidates: Array<{ url: string; authorizationToken: string }> };
            const candidate = prepared.endpointCandidates[0]!;
            const recipient = createTransferRecipientKeyPair();
            const basePath = new URL(candidate.url).pathname;
            const call = async (method: string, suffix: string, httpMethod: 'GET' | 'POST', body?: unknown) => {
                const result = PreparedTransferRpcResponseV1Schema.parse(await manager.invokeLocal(method, {
                    t: 'prepared_machine_transfer_v1', path: `${basePath}/${suffix}`, httpMethod,
                    authorizationToken: candidate.authorizationToken, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                    ...(body === undefined ? {} : { body }),
                }));
                expect(result.status).toBe(200);
                return result;
            };
            const opened = JSON.parse((await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, 'open', 'POST')).body) as { totalChunks: number; sizeBytes: number };
            expect(opened.sizeBytes).toBeGreaterThan(5_000_000);
            const chunks: Buffer[] = [];
            for (let sequence = 0; sequence < opened.totalChunks; sequence += 1) {
                const result = await call(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, `chunks/${sequence}`, 'GET');
                expect(Buffer.byteLength(result.body)).toBeLessThan(1024 * 1024);
                const chunk = TransferChunkEnvelopeSchema.parse(JSON.parse(result.body));
                if (chunk.kind !== 'chunk' || !chunk.encryptedDataKeyEnvelopeBase64) throw new Error('Missing encrypted Artifact chunk');
                const plaintext = decryptEncryptedTransferChunkEnvelope({ transferId: prepared.transferId, sequence,
                    payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed });
                expect(plaintext.length).toBeLessThanOrEqual(resolveDirectPeerTransferChunkBytes());
                chunks.push(plaintext);
            }
            const payload = DaemonPluginUiArtifactBytesReadResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            expect(payload).toMatchObject({ ok: true, artifactFamily: 'hostedWeb', artifact: { digest } });
            if (!payload.ok) throw new Error('Artifact unavailable');
            expect(Buffer.compare(Buffer.from(payload.files[0]!.bytesBase64, 'base64'), Buffer.from(bytes))).toBe(0);
            expect(await manager.invokeLocal(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE,
                { transferId: prepared.transferId })).toEqual({ success: true });
            expect(lifecycle.getState().publishedTransferCount).toBe(0);
            expect(payloadWrites.mock.calls.some(([file]) => typeof file === 'string' && file.endsWith('plugin-ui-artifact.json'))).toBe(true);
            await vi.waitFor(async () => {
                for (const [file] of payloadWrites.mock.calls) {
                    if (typeof file === 'string' && file.endsWith('plugin-ui-artifact.json')) {
                        await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
                    }
                }
            });
            expect(fixture.registry.activatedPluginIds.has(author.manifest.id)).toBe(false);
            expect(await manager.invokeLocal(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
                { ...request, request: { ...request.request, path: '/outside/artifact' } })).toMatchObject({ success: false });
        } finally {
            if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
            await registration?.dispose(); await lifecycle.stop(); await fixture.dispose();
            payloadWrites.mockRestore();
        }
    });
});
