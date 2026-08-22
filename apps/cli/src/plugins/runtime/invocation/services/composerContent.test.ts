import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    type ComposerContentStageMediaRequestV1,
} from '@happier-dev/plugin-sdk';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createStablePluginComposerContentOwner } from './composerContent';
import { createPluginFileSystemService } from './filesystem';
import type { PluginInvocationServicesSeed } from './types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerInvoker } from '@/api/rpc/types';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { registerComposerMediaStageLifecycleRpcHandlers } from '@/transfers/rpc/registerComposerMediaStageLifecycleRpcHandlers';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TARGET = Object.freeze({
    serverId: 'server-1',
    machineId: 'machine-1',
}) satisfies SessionExecutionTargetV1;

function invocationSeed(input?: Readonly<{
    signal?: AbortSignal;
    isGenerationCurrent?: () => boolean;
}>): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: 'acme.media', version: '1.0.0' }),
        contribution: Object.freeze({
            id: 'stage-photo',
            qualifiedId: 'acme.media/actions/stage-photo',
        }),
        generation: '7',
        correlationId: 'composer-content-test',
        surface: 'cli' as const,
        signal: input?.signal ?? new AbortController().signal,
        isGenerationCurrent: input?.isGenerationCurrent ?? (() => true),
    });
}

function createTracedLocalTransferRpc(): Readonly<{
    rpc: RpcHandlerInvoker;
    calls: Array<Readonly<{ method: string; params: unknown }>>;
    manager: RpcHandlerManager;
}> {
    const manager = new RpcHandlerManager({
        scopePrefix: '',
        encryptionMode: 'plain',
        logger: () => undefined,
    });
    const calls: Array<Readonly<{ method: string; params: unknown }>> = [];
    return Object.freeze({
        rpc: Object.freeze({
            invokeLocal: async (
                method: Parameters<RpcHandlerInvoker['invokeLocal']>[0],
                params: Parameters<RpcHandlerInvoker['invokeLocal']>[1],
                options: Parameters<RpcHandlerInvoker['invokeLocal']>[2],
            ) => {
                calls.push(Object.freeze({ method, params }));
                return await manager.invokeLocal(method, params, options);
            },
        }),
        calls,
        // The caller registers exact incumbent handlers below rather than
        // replacing the transfer lifecycle with a fixture-local fake.
        manager,
    });
}

function createDeferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return Object.freeze({ promise, resolve, reject });
}

describe('stable plugin Composer content owner', () => {
    it('stages an authorized PluginPath while host-stamping the exact target and contribution owner', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-content-workspace-'));
        const stageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-content-stage-'));
        await writeFile(join(workspace, 'photo.png'), PNG_BYTES);
        const stageStore = createComposerMediaStageStore({
            rootDirectory: stageRoot,
            executionTarget: TARGET,
        });
        const transferSessionStore = new TransferSessionStore({ ttlMs: 30_000 });
        const transfer = createTracedLocalTransferRpc();
        registerTransferUploadRpcHandlers(transfer.manager, {
            workingDirectory: workspace,
            store: transferSessionStore,
            composerMediaStage: {
                executionTarget: TARGET,
                store: stageStore,
            },
        });
        registerComposerMediaStageLifecycleRpcHandlers(transfer.manager, { store: stageStore });
        const service = createStablePluginComposerContentOwner({
            executionTarget: TARGET,
            resolveCurrentExecutionTarget: () => TARGET,
            resolveTransferRpcHandler: () => transfer.rpc,
        }).bind({
            seed: invocationSeed(),
            fileSystem: createPluginFileSystemService({
                roots: { pluginData: workspace, workspace, projects: new Map() },
                scopes: [{ root: 'workspace', access: ['read'] }],
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }),
        });

        try {
            expect(service?.capabilities()).toEqual({
                [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: { status: 'available' },
            });
            const forgedRequest = {
                source: { root: 'workspace' as const, relativePath: 'photo.png' },
                name: 'selected.png',
                mimeType: 'image/png' as const,
                executionTarget: { serverId: 'forged', machineId: 'forged' },
                owner: { pluginId: 'forged', localId: 'forged' },
            } satisfies ComposerContentStageMediaRequestV1 & Readonly<Record<string, unknown>>;
            const handle = await service!.stageMedia(forgedRequest);

            expect(handle).toMatchObject({
                v: 1,
                executionTarget: TARGET,
                owner: { pluginId: 'acme.media', localId: 'stage-photo' },
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'selected.png',
                sizeBytes: PNG_BYTES.byteLength,
            });
            expect(transfer.calls.map((call) => call.method)).toEqual([
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
            ]);
            expect(transfer.calls[0]).toMatchObject({
                method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                params: {
                    t: 'composer_media_stage_upload_v1',
                    executionTarget: TARGET,
                    owner: { pluginId: 'acme.media', localId: 'stage-photo' },
                    mediaKind: 'image',
                    mimeType: 'image/png',
                    name: 'selected.png',
                    sizeBytes: PNG_BYTES.byteLength,
                    sha256: handle.sha256,
                },
            });
            await expect(stageStore.inspectForFinalization({
                handle,
                executionTarget: TARGET,
                owner: { pluginId: 'acme.media', localId: 'stage-photo' },
            })).resolves.toMatchObject({ status: 'ready', handle });
        } finally {
            await transferSessionStore.dispose();
            await rm(workspace, { recursive: true, force: true });
            await rm(stageRoot, { recursive: true, force: true });
        }
    });

    it('fails capabilities and staging closed when the bound daemon target is absent or replaced', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-target-workspace-'));
        await writeFile(join(workspace, 'photo.png'), PNG_BYTES);
        let currentTarget: SessionExecutionTargetV1 | null = TARGET;
        const service = createStablePluginComposerContentOwner({
            executionTarget: TARGET,
            resolveCurrentExecutionTarget: () => currentTarget,
            resolveTransferRpcHandler: () => null,
        }).bind({
            seed: invocationSeed(),
            fileSystem: createPluginFileSystemService({
                roots: { pluginData: workspace, workspace, projects: new Map() },
                scopes: [{ root: 'workspace', access: ['read'] }],
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }),
        });

        try {
            currentTarget = null;
            expect(service?.capabilities()).toEqual({
                [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: {
                    status: 'unavailable',
                    code: 'plugin_composer_content_target_unavailable',
                },
            });
            await expect(service?.stageMedia({
                source: { root: 'workspace', relativePath: 'photo.png' },
            })).rejects.toMatchObject({ code: 'plugin_composer_content_target_unavailable' });

            currentTarget = { serverId: TARGET.serverId, machineId: 'machine-2' };
            await expect(service?.stageMedia({
                source: { root: 'workspace', relativePath: 'photo.png' },
            })).rejects.toMatchObject({ code: 'plugin_composer_content_target_unavailable' });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('fences cancelled and stale invocations before reading or finalizing media', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-current-workspace-'));
        await writeFile(join(workspace, 'photo.png'), PNG_BYTES);
        const fileSystem = createPluginFileSystemService({
            roots: { pluginData: workspace, workspace, projects: new Map() },
            scopes: [{ root: 'workspace', access: ['read'] }],
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const owner = createStablePluginComposerContentOwner({
            executionTarget: TARGET,
            resolveCurrentExecutionTarget: () => TARGET,
            resolveTransferRpcHandler: () => null,
        });
        const cancelled = new AbortController();
        const cancelledService = owner.bind({ seed: invocationSeed(), fileSystem });
        const staleService = owner.bind({
            seed: invocationSeed({ isGenerationCurrent: () => false }),
            fileSystem,
        });

        try {
            cancelled.abort();
            await expect(cancelledService?.stageMedia(
                { source: { root: 'workspace', relativePath: 'photo.png' } },
                { signal: cancelled.signal },
            )).rejects.toMatchObject({ code: 'plugin_composer_content_aborted' });
            expect(staleService?.capabilities()).toEqual({
                [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: {
                    status: 'unavailable',
                    code: 'plugin_generation_stale',
                },
            });
            await expect(staleService?.stageMedia({
                source: { root: 'workspace', relativePath: 'photo.png' },
            })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('uses the target transfer limit instead of bypassing the incumbent upload carrier', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-content-limit-workspace-'));
        const stageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-content-limit-stage-'));
        await writeFile(join(workspace, 'photo.png'), PNG_BYTES);
        const stageStore = createComposerMediaStageStore({ rootDirectory: stageRoot, executionTarget: TARGET });
        const transferSessionStore = new TransferSessionStore({ ttlMs: 30_000 });
        const transfer = createTracedLocalTransferRpc();
        registerTransferUploadRpcHandlers(transfer.manager, {
            workingDirectory: workspace,
            store: transferSessionStore,
            sessionRpcTransferMaxBytes: PNG_BYTES.byteLength - 1,
            composerMediaStage: {
                executionTarget: TARGET,
                store: stageStore,
            },
        });
        const service = createStablePluginComposerContentOwner({
            executionTarget: TARGET,
            resolveCurrentExecutionTarget: () => TARGET,
            resolveTransferRpcHandler: () => transfer.rpc,
        }).bind({
            seed: invocationSeed(),
            fileSystem: createPluginFileSystemService({
                roots: { pluginData: workspace, workspace, projects: new Map() },
                scopes: [{ root: 'workspace', access: ['read'] }],
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }),
        });

        try {
            await expect(service?.stageMedia({
                source: { root: 'workspace', relativePath: 'photo.png' },
            })).rejects.toMatchObject({ code: 'plugin_composer_content_stage_failed' });
            expect(transfer.calls.map((call) => call.method)).toEqual([
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            ]);
        } finally {
            await transferSessionStore.dispose();
            await rm(workspace, { recursive: true, force: true });
            await rm(stageRoot, { recursive: true, force: true });
        }
    });

    it('aborts the incumbent upload session when cancellation arrives during chunk transfer', async () => {
        const recipient = createTransferRecipientKeyPair();
        const chunkStarted = createDeferred<void>();
        const finishChunk = createDeferred<void>();
        const calls: string[] = [];
        const transferRpc: RpcHandlerInvoker = Object.freeze({
            invokeLocal: async (method) => {
                calls.push(method);
                if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                    return {
                        success: true,
                        uploadId: 'upload-cancelled',
                        chunkSizeBytes: PNG_BYTES.byteLength,
                        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                    };
                }
                if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
                    chunkStarted.resolve();
                    await finishChunk.promise;
                    return { success: true };
                }
                if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT) {
                    return { success: true };
                }
                throw new Error(`Unexpected transfer method ${method}`);
            },
        });
        const controller = new AbortController();
        const service = createStablePluginComposerContentOwner({
            executionTarget: TARGET,
            resolveCurrentExecutionTarget: () => TARGET,
            resolveTransferRpcHandler: () => transferRpc,
        }).bind({
            seed: invocationSeed(),
            fileSystem: {
                readFile: async () => PNG_BYTES,
            } as unknown as FileSystemService,
        });

        const staging = service!.stageMedia({
            source: { root: 'workspace', relativePath: 'photo.png' },
        }, { signal: controller.signal });
        await Promise.race([
            chunkStarted.promise,
            new Promise<void>((_resolve, reject) => setTimeout(
                () => reject(new Error('Composer media did not enter the upload carrier')),
                500,
            )),
        ]);
        controller.abort();
        finishChunk.resolve();

        await expect(staging).rejects.toMatchObject({ code: 'plugin_composer_content_aborted' });
        expect(calls).toEqual([
            RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
            RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
        ]);
    });

    it('releases a completed stage and preserves the observed failure when target currentness retires late', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-late-workspace-'));
        const stageRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-late-stage-'));
        await writeFile(join(workspace, 'photo.png'), PNG_BYTES);
        let currentnessReads = 0;
        const stageStore = createComposerMediaStageStore({ rootDirectory: stageRoot, executionTarget: TARGET });
        const transferSessionStore = new TransferSessionStore({ ttlMs: 30_000 });
        const transfer = createTracedLocalTransferRpc();
        registerTransferUploadRpcHandlers(transfer.manager, {
            workingDirectory: workspace,
            store: transferSessionStore,
            composerMediaStage: {
                executionTarget: TARGET,
                store: stageStore,
            },
        });
        registerComposerMediaStageLifecycleRpcHandlers(transfer.manager, { store: stageStore });
        const service = createStablePluginComposerContentOwner({
            executionTarget: TARGET,
            resolveCurrentExecutionTarget: () => {
                currentnessReads += 1;
                return currentnessReads === 4 ? null : TARGET;
            },
            resolveTransferRpcHandler: () => transfer.rpc,
        }).bind({
            seed: invocationSeed(),
            fileSystem: createPluginFileSystemService({
                roots: { pluginData: workspace, workspace, projects: new Map() },
                scopes: [{ root: 'workspace', access: ['read'] }],
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }),
        });

        try {
            await expect(service?.stageMedia({
                source: { root: 'workspace', relativePath: 'photo.png' },
            })).rejects.toMatchObject({ code: 'plugin_composer_content_target_unavailable' });
            await expect(readdir(join(stageRoot, 'completed'))).resolves.toEqual([]);
        } finally {
            await transferSessionStore.dispose();
            await rm(workspace, { recursive: true, force: true });
            await rm(stageRoot, { recursive: true, force: true });
        }
    });
});
