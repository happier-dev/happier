import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonState } from '@/api/types';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { startPublicProfileRefresh } from '../account/publicProfileRefresh';
import { createNativePublicProfileRefreshFixture } from '../account/publicProfileRefresh.testkit';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '../serverWork';
import { cleanupAndShutdown as cleanupNativeAccount } from './cleanupAndShutdown';
import { disposeLanguageServerHost } from '@/lsp/languageServerHost';

const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
]);

describe('cleanupAndShutdown', () => {
    afterEach(() => {
        envScope.restore();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('aborts and drains public-profile work before retiring the Account transport', async () => {
        await disposeLanguageServerHost();
        const account = await createNativePublicProfileRefreshFixture();
        const pending = account.holdNextRead();
        const lifetime = new AbortController();
        const transportRetired: boolean[] = [];
        const handle = startPublicProfileRefresh({
            scheduler: createDaemonServerWorkScheduler({ budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }) }),
            signal: lifetime.signal, isCurrent: account.isCurrent, actions: account.actions,
        });
        await pending.accepted;
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        let drained = false;
        const cleanup = cleanupNativeAccount({
            source: 'happier-cli', processEnv: {}, resolvePositiveIntEnv: (_raw, fallback) => fallback,
            restartOnStaleVersionAndHeartbeat: null, connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null, publicProfileRefreshHandle: handle,
            apiMachine: null, machineConnectionStateCleanup: null,
            closeDaemonMutationCustody: async () => { transportRetired.push(drained); },
            automationWorker: null, memoryWorker: null, voiceInferenceWorker: null, trackedSessionCount: 0,
            stopDirectPeerServer: async () => {}, stopTailscaleTransferServeLifecycle: async () => {},
            stopControlServer: async () => {}, stopKeepAwake: async () => {}, daemonLockHandle: null,
            releaseDaemonLock: async () => {},
        });
        try {
            await vi.waitFor(() => expect(account.getRequestSignal()?.aborted).toBe(true));
            expect(transportRetired).toEqual([]);
            drained = true;
            pending.release();
            await cleanup;
            expect(transportRetired).toEqual([true]);
        } finally {
            pending.release();
            await handle.stop();
            await cleanup;
            await account.dispose();
            exitSpy.mockRestore();
        }
    });

    it('retires a pending native language-server query before draining admitted work', async () => {
        await withTempDir('happier-cleanup-lsp-drain-', async homeDir => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'cloud' });
            vi.resetModules();
            const { cleanupAndShutdown } = await import('./cleanupAndShutdown');
            const { configureLanguageServerHost, getLanguageServerHost, disposeLanguageServerHost } = await import('@/lsp/languageServerHost');
            const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
            const { createStablePluginExecService } = await import('@/plugins/runtime/invocation/services/exec');
            const { readSupervisedPluginProcessIdForHost } = await import('@/plugins/runtime/exec/processSupervisor');
            const { isPidAlive } = await import('@/testkit/process/spawn');
            const log = join(homeDir, 'messages.jsonl');
            await writeFile(log, '');
            await writeFile(join(homeDir, 'a.ts'), 'pending');
            const registry = createResolvedContributionRegistry({ languageServers: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture',
                identity: { pluginId: 'fixture', localId: 'server' }, manifestPath: join(homeDir, 'plugin.json'),
                definition: { id: 'server', title: 'Fixture', languageIds: { typescript: 'typescript' },
                    executable: { kind: 'systemTool', id: 'native' }, args: [] },
            }] });
            const handles: PluginProtocolClientHandle<'jsonRpc'>[] = [];
            configureLanguageServerHost({ readCurrentContributionRegistry: () => registry, async openProtocol(input) {
                // The real stdio child is the OS boundary; host lifecycle, codec and supervision remain real.
                const service = createStablePluginExecService({
                    processOwner: input.processOwner, signal: input.signal, isOccurrenceCurrent: () => !input.signal.aborted,
                    resolveExecutable: async () => ({ command: process.execPath,
                        args: [resolve('src/lsp/__fixtures__/languageServer.cjs'), log, JSON.stringify({ delayHover: true })] }),
                    resolvePath: async () => homeDir,
                });
                const handle = await service.clients.spawn({ kind: 'jsonRpc', framing: 'contentLength',
                    cancellationMethod: '$/cancelRequest',
                    launch: { executable: input.definition.executable, cwd: homeDir } });
                handles.push(handle);
                return handle;
            } });
            const host = getLanguageServerHost();
            let querySettled = false;
            let drainSnapshot: { retired: boolean; querySettled: boolean; childGone: boolean } | undefined;
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
            try {
                expect((await host.sync({ rootPath: homeDir, op: { op: 'open', path: 'a.ts', languageId: 'typescript', text: 'pending', version: 1, unsaved: false } })).status).toBe('ok');
                const pending = host.query({ rootPath: homeDir, path: 'a.ts', kind: 'hover', position: { line: 0, character: 0 } });
                void pending.then(() => { querySettled = true; }, () => { querySettled = true; });
                await expect.poll(async () => (await readFile(log, 'utf8')).includes('"method":"textDocument/hover"')).toBe(true);
                const handle = handles[0];
                if (!handle) throw new Error('Native language server was not launched');
                const pid = readSupervisedPluginProcessIdForHost(handle.process);
                if (pid === null) throw new Error('Native language-server identity is unavailable');
                expect(querySettled).toBe(false);
                await cleanupAndShutdown({
                    source: 'happier-cli', processEnv: {}, resolvePositiveIntEnv: (_raw, fallback) => fallback,
                    restartOnStaleVersionAndHeartbeat: null, connectedServiceRefreshLoopHandle: null,
                    connectedServiceQuotasLoopHandle: null, apiMachine: null, machineConnectionStateCleanup: null,
                    automationWorker: null, memoryWorker: null, voiceInferenceWorker: null, trackedSessionCount: 0,
                    stopDirectPeerServer: async () => {}, stopTailscaleTransferServeLifecycle: async () => {},
                    stopControlServer: async () => {}, stopKeepAwake: async () => {}, daemonLockHandle: null, releaseDaemonLock: async () => {},
                    async beforeShutdown() {
                        const closed = await host.sync({ rootPath: homeDir, op: { op: 'close', path: 'unused.ts' } });
                        drainSnapshot = { retired: closed.status === 'unavailable', querySettled, childGone: !isPidAlive(pid) };
                        // Record a regression without hanging RED on the still-pending request.
                    },
                });
                expect(drainSnapshot).toEqual({ retired: true, querySettled: true, childGone: true });
                expect((await pending).status).not.toBe('ok');
                await handle.wait();
                expect(isPidAlive(pid)).toBe(false);
            } finally {
                exitSpy.mockRestore();
                await disposeLanguageServerHost();
                await Promise.all(handles.map(handle => handle.dispose()));
            }
        });
    });

    it('drains admitted work before stopping background loops or data transport', async () => {
        await withTempDir('happier-cleanup-shutdown-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const { cleanupAndShutdown } = await import('./cleanupAndShutdown');
            const { getLanguageServerHost } = await import('@/lsp/languageServerHost');
            const languageHost = getLanguageServerHost();
            expect((await languageHost.sync({ rootPath: homeDir, op: { op: 'close', path: 'unused.ts' } })).status).toBe('ok');
            const calls: string[] = [];
            const beforeShutdown = vi.fn(async () => {
                calls.push('beforeShutdown');
            });
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
                calls.push(`exit:${code ?? ''}`);
                return undefined as never;
            }) as typeof process.exit);

            const params: Parameters<typeof cleanupAndShutdown>[0] & {
                beforeShutdown: () => Promise<void>;
            } = {
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: {
                    stop: () => {
                        calls.push('refreshLoopStop');
                    },
                },
                connectedServiceQuotasLoopHandle: {
                    stop: async () => {
                        calls.push('quotaLoopStop');
                        await Promise.resolve();
                        calls.push('quotaLoopStopDone');
                    },
                    pause: () => {},
                    resume: () => {},
                    wake: () => {},
                    subscribeAfterTick: () => () => {},
                },
                apiMachine: null,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {
                    calls.push('directPeerStop');
                },
                stopTailscaleTransferServeLifecycle: async () => {
                    calls.push('tailscaleStop');
                },
                stopSshTunnelsOnShutdown: async () => {
                    calls.push('sshTunnelsStop');
                },
                stopControlServer: async () => {
                    calls.push('controlServerStop');
                },
                stopKeepAwake: async () => {
                    calls.push('keepAwakeStop');
                },
                daemonLockHandle: null,
                releaseDaemonLock: async () => {
                    calls.push('daemonLockRelease');
                },
                beforeShutdown,
            };

            await cleanupAndShutdown(params);

            expect(await languageHost.sync({ rootPath: homeDir, op: { op: 'close', path: 'unused.ts' } }))
                .toEqual({ status: 'unavailable', reason: 'session_unavailable' });

            expect(beforeShutdown).toHaveBeenCalledTimes(1);
            expect(calls).toEqual([
                'beforeShutdown',
                'refreshLoopStop',
                'quotaLoopStop',
                'quotaLoopStopDone',
                'directPeerStop',
                'tailscaleStop',
                'sshTunnelsStop',
                'controlServerStop',
                'keepAwakeStop',
                'exit:0',
            ]);
            exitSpy.mockRestore();
        });
    });

    it('stops transfer listeners before shutting down the machine-state publisher', async () => {
        await withTempDir('happier-cleanup-transfer-state-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const { cleanupAndShutdown } = await import('./cleanupAndShutdown');
            const calls: string[] = [];
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
                calls.push(`exit:${code ?? ''}`);
                return undefined as never;
            }) as typeof process.exit);

            await cleanupAndShutdown({
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: null,
                connectedServiceQuotasLoopHandle: null,
                apiMachine: {
                    updateDaemonState: async (updater: (state: DaemonState | null) => DaemonState) => {
                        calls.push('shutdownStatePublish');
                        updater(null);
                    },
                    shutdown: async () => {
                        calls.push('apiMachineShutdown');
                    },
                } as never,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {
                    calls.push('directPeerStop');
                },
                stopTailscaleTransferServeLifecycle: async () => {
                    calls.push('tailscaleStop');
                },
                stopControlServer: async () => {},
                stopKeepAwake: async () => {},
                daemonLockHandle: null,
                releaseDaemonLock: async () => {},
            });

            expect(calls).toEqual([
                'directPeerStop',
                'tailscaleStop',
                'shutdownStatePublish',
                'apiMachineShutdown',
                'exit:0',
            ]);
            exitSpy.mockRestore();
        });
    });

    it('preserves its daemon publication through slow cleanup until lifecycle lock release', async () => {
        await withTempDir('happier-cleanup-live-publication-', async (homeDir) => {
            envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'cloud' });
            vi.resetModules();

            const [{ configuration }, { cleanupAndShutdown }, {
                acquireDaemonLock, readDaemonState, releaseDaemonLock, writeDaemonStateForLockOwner,
            }] = await Promise.all([
                import('@/configuration'),
                import('./cleanupAndShutdown'),
                import('@/persistence'),
            ]);
            const lockHandle = await acquireDaemonLock(2, 1);
            expect(lockHandle).not.toBeNull();
            if (!lockHandle) throw new Error('Daemon lifecycle lock was not acquired');
            const stateOwner = {
                pid: process.pid, httpPort: 5111, startedAt: 1_111,
                startedWithCliVersion: '0.0.0-test', controlToken: 'control-owner',
            };
            expect(writeDaemonStateForLockOwner(lockHandle, stateOwner)).toBe(true);
            const controlStopStarted = createDeferred();
            const releaseControlStop = createDeferred();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
            const shutdown = cleanupAndShutdown({
                source: 'happier-cli', processEnv: {}, resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null, connectedServiceRefreshLoopHandle: null,
                connectedServiceQuotasLoopHandle: null, apiMachine: null, machineConnectionStateCleanup: null,
                automationWorker: null, memoryWorker: null, voiceInferenceWorker: null, trackedSessionCount: 0,
                stopDirectPeerServer: async () => {}, stopTailscaleTransferServeLifecycle: async () => {},
                // Hold only the control-transport IO boundary; real cleanup,
                // publication ownership and lifecycle lock release stay active.
                stopControlServer: async () => {
                    controlStopStarted.resolve();
                    await releaseControlStop.promise;
                },
                stopKeepAwake: async () => {},
                daemonStateOwner: stateOwner, daemonLockHandle: lockHandle, releaseDaemonLock,
            });
            try {
                await controlStopStarted.promise;
                await expect(readDaemonState()).resolves.toMatchObject(stateOwner);
                expect(existsSync(configuration.daemonLockFile)).toBe(true);
            } finally {
                releaseControlStop.resolve();
                await shutdown;
            }
            await expect(readDaemonState()).resolves.toBeNull();
            expect(existsSync(configuration.daemonLockFile)).toBe(false);
            expect(exitSpy).toHaveBeenCalledWith(0);
        });
    });

    it('does not remove a successor daemon state publication during predecessor shutdown', async () => {
        await withTempDir('happier-cleanup-successor-state-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const [{ cleanupAndShutdown }, { readDaemonState, writeDaemonState }] = await Promise.all([
                import('./cleanupAndShutdown'),
                import('@/persistence'),
            ]);
            const predecessor = {
                pid: 111,
                httpPort: 5111,
                startedAt: 1_111,
                startedWithCliVersion: '0.0.0-a',
                runtimeId: 'shared-runtime',
                controlToken: 'control-a',
            };
            const successor = {
                pid: 222,
                httpPort: 5222,
                startedAt: 2_222,
                startedWithCliVersion: '0.0.0-b',
                runtimeId: 'shared-runtime',
                controlToken: 'control-b',
            };
            writeDaemonState(successor);
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);

            await cleanupAndShutdown({
                source: 'happier-cli',
                processEnv: {},
                resolvePositiveIntEnv: (_raw, fallback) => fallback,
                restartOnStaleVersionAndHeartbeat: null,
                connectedServiceRefreshLoopHandle: null,
                connectedServiceQuotasLoopHandle: null,
                apiMachine: null,
                machineConnectionStateCleanup: null,
                automationWorker: null,
                memoryWorker: null,
                voiceInferenceWorker: null,
                trackedSessionCount: 0,
                stopDirectPeerServer: async () => {},
                stopTailscaleTransferServeLifecycle: async () => {},
                stopControlServer: async () => {},
                stopKeepAwake: async () => {},
                daemonLockHandle: null,
                releaseDaemonLock: async () => {},
                daemonStateOwner: predecessor,
            });

            await expect(readDaemonState()).resolves.toMatchObject(successor);
            exitSpy.mockRestore();
        });
    });

    it('clears an owned publication before releasing its lifecycle lock after a fatal error', async () => {
        await withTempDir('happier-cleanup-fatal-owner-', async (homeDir) => {
            envScope.patch({
                HAPPIER_HOME_DIR: homeDir,
                HAPPIER_ACTIVE_SERVER_ID: 'cloud',
            });
            vi.resetModules();

            const [
                { configuration },
                { releaseDaemonOwnershipAfterFatal },
                {
                    acquireDaemonLock,
                    readDaemonState,
                    writeDaemonStateForLockOwner,
                },
            ] = await Promise.all([
                import('@/configuration'),
                import('./cleanupAndShutdown'),
                import('@/persistence'),
            ]);
            const lockHandle = await acquireDaemonLock(2, 1);
            expect(lockHandle).not.toBeNull();
            if (!lockHandle) return;

            const stateOwner = {
                pid: process.pid,
                httpPort: 5111,
                startedAt: 1_111,
                startedWithCliVersion: '0.0.0-test',
                controlToken: 'control-owner',
            };
            expect(writeDaemonStateForLockOwner(lockHandle, stateOwner)).toBe(true);

            await releaseDaemonOwnershipAfterFatal({
                daemonLockHandle: lockHandle,
                daemonStateOwner: stateOwner,
            });

            await expect(readDaemonState()).resolves.toBeNull();
            expect(existsSync(configuration.daemonLockFile)).toBe(false);
        });
    });
});
