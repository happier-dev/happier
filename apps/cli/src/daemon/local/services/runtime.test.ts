import { describe, expect, it, vi, type MockedFunction } from 'vitest';

import type {
    ExecProcessHandleV1,
    ExecRuntimeServiceV1,
} from '@/plugins/runtime/exec/privateContract';
import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';
import { createLocalServiceActionConfirmationNonceV1, FeaturesResponseSchema, type LocalServiceActionRequestV1 } from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

import { createLocalServicesDaemonRuntime } from './runtime';
import {
    listLocalServicePreviewResources,
    registerLocalServicePreview,
} from './preview/registry';
import type { NormalizedLocalServiceInventorySnapshot } from './inventory/scanner';
import { hashProcessCommand } from '@/daemon/sessionRegistry';

function createDeferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

function buildSnapshot(
    overrides: Partial<NormalizedLocalServiceInventorySnapshot> = {},
): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'machine-a',
        generatedAt: 1_000,
        refreshState: 'idle',
        diagnostics: [],
        entries: [{
            id: 'entry-1',
            machineId: 'machine-a',
            address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
            endpoint: {
                scheme: 'http',
                host: '127.0.0.1',
                port: 5173,
                probeState: 'ready',
                probedAt: 1_000,
            },
            port: 5173,
            protocol: 'tcp',
            detectedAt: 1_000,
            lastSeenAt: 1_000,
            state: 'listening',
            source: 'detected',
            labels: [],
            confidence: 'high',
            processOwnershipConfidence: 'medium',
            workspaceAssociationConfidence: 'high',
            diagnostics: [],
            provenance: {
                process: {
                    pid: 400,
                    ppid: 300,
                    lineagePids: [400, 300, 1],
                    command: 'npm run dev',
                    cwd: '/repo/app',
                    redacted: true,
                },
            },
        }],
        ...overrides,
    };
}

const hostedWebManagedDeclaration: LocalServiceDeclarationV1 = {
    id: 'web',
    launch: { kind: 'binary', executablePath: '/bin/happier-plugin-web', args: ['serve'] },
    launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
    hostPolicy: { kind: 'loopback' },
    name: { strategy: 'derived', base: 'web' },
    healthCheck: { kind: 'none' },
    restart: { kind: 'never' },
    cleanup: { staleAfterMs: 30_000 },
};

const assignAndInjectManagedDeclaration: LocalServiceDeclarationV1 = {
    id: 'web',
    launch: { kind: 'binary', executablePath: '/bin/happier-plugin-web', args: ['serve'], env: { EXISTING: '1' } },
    launchMode: {
        kind: 'assignAndInject',
        portPolicy: { kind: 'allocated' },
        environment: { inject: ['PORT', 'HOST'] },
    },
    hostPolicy: { kind: 'loopback' },
    name: { strategy: 'derived', base: 'web' },
    healthCheck: { kind: 'none' },
    restart: { kind: 'never' },
    cleanup: { staleAfterMs: 30_000 },
};

function createProcessHandle(pid: number): ExecProcessHandleV1 {
    return {
        pid,
        exit: new Promise(() => {}),
        writeStdin: vi.fn(async () => {}),
        kill: vi.fn(),
        dispose: vi.fn(async () => {}),
    };
}

function createExecService(handle: ExecProcessHandleV1): Pick<ExecRuntimeServiceV1, 'spawn'> & Readonly<{
    spawn: MockedFunction<ExecRuntimeServiceV1['spawn']>;
}> {
    const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>(
        async (_input, _options) => handle,
    );
    return {
        spawn,
    };
}

describe('createLocalServicesDaemonRuntime', () => {
    it('reattaches an exact verified surviving managed run across equivalent Windows materialization paths', async () => {
        const processHandle = createProcessHandle(700);
        const observedExecutablePath =
            '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed';
        const declaredExecutablePath =
            '/home/.happier/cli/current/tools/unpacked/happier-cliproxyapi-managed';
        const command = `${observedExecutablePath} serve --config /private/runtime/config.json`;
        const verifyMaterialization = vi.fn(async () => true);
        const verifyExecutableArtifact = vi.fn(async () => true);
        const reattachProcess = vi.fn(async () => processHandle);
        const healthProbe = vi.fn(async () => true);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-reattach',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 700,
                processStartTimeMs: 1_717_171_717_700,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_700 },
            materialization: {
                rootDir: 'C:\\Users\\Alice\\happier\\managed\\runtime',
                materializationId: 'materialization-reattach',
            },
        };
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                kind: 'binary',
                executablePath: declaredExecutablePath,
                args: ['serve'],
                env: { EXISTING: '1' },
            },
            healthCheck: { kind: 'http', path: '/healthz', timeoutMs: 250 },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{
                    address: '127.0.0.1',
                    port: 45_700,
                    protocol: 'tcp',
                    pid: 700,
                }],
                processes: new Map([[
                    700,
                    {
                        pid: 700,
                        ppid: 1,
                        processStartTimeMs: 1_717_171_717_700,
                        command,
                        executablePath: observedExecutablePath,
                        cwd:
                            'c:/users/alice/happier/managed/staging/../runtime/',
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcess,
                healthProbe,
            },
        });

        await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization,
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'executable_artifact_mismatch',
        });
        const result = await runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization,
            verifyExecutableArtifact,
        });

        expect(result).toMatchObject({
            ok: true,
            ownedRun: {
                runId: 1,
                process: {
                    pid: 700,
                    processStartTimeMs: 1_717_171_717_700,
                    processCommandHash: hashProcessCommand(command),
                },
                host: '127.0.0.1',
                port: 45_700,
                snapshot: { phase: 'running', port: 45_700 },
            },
        });
        expect(verifyMaterialization).toHaveBeenCalledOnce();
        expect(verifyExecutableArtifact).toHaveBeenCalledWith({
            observedExecutablePath,
            declaredExecutablePath,
        });
        expect(reattachProcess).toHaveBeenCalledWith(attachment);
        expect(healthProbe).toHaveBeenCalledWith({
            host: '127.0.0.1',
            port: 45_700,
            path: '/healthz',
            timeoutMs: 250,
        });
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: declaration.id,
        })).toEqual(result.ok ? result.ownedRun : null);
    });

    it('refuses adoption when the exact process identity changes while reattachment proof awaits', async () => {
        const command = '/bin/happier-plugin-web serve';
        const processStartTimeMs = 1_717_171_717_702;
        let scanCount = 0;
        const reattachProcess = vi.fn(async () => createProcessHandle(702));
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-mid-proof-reuse',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 702,
                processStartTimeMs,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_702 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-mid-proof-reuse',
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => {
                scanCount += 1;
                const currentStartTimeMs = scanCount === 1
                    ? processStartTimeMs
                    : processStartTimeMs + 1;
                return {
                    listeners: [{
                        address: '127.0.0.1',
                        port: 45_702,
                        protocol: 'tcp' as const,
                        pid: 702,
                    }],
                    processes: new Map([[
                        702,
                        {
                            pid: 702,
                            ppid: 1,
                            processStartTimeMs: currentStartTimeMs,
                            command,
                            executablePath: '/bin/happier-plugin-web',
                            cwd: '/private/runtime',
                        },
                    ]]),
                    workspaces: [],
                    diagnostics: [],
                };
            },
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcess,
            },
        });

        await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration: assignAndInjectManagedDeclaration,
            attachment,
            verifyMaterialization: async () => true,
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'process_identity_mismatch',
        });
        expect(scanCount).toBe(2);
        expect(reattachProcess).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();
    });

    it('refuses adoption when the exact process identity changes while supervision reconstruction awaits', async () => {
        const command = '/bin/happier-plugin-web serve';
        const processStartTimeMs = 1_717_171_717_705;
        const rejectedHandle = createProcessHandle(705);
        const acceptedHandle = createProcessHandle(705);
        let identityReplaced = false;
        let reattachCount = 0;
        let scanCount = 0;
        const reattachProcess = vi.fn(async () => {
            reattachCount += 1;
            if (reattachCount === 1) {
                identityReplaced = true;
                return rejectedHandle;
            }
            return acceptedHandle;
        });
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-supervision-proof-reuse',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 705,
                processStartTimeMs,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_705 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-supervision-proof-reuse',
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => {
                scanCount += 1;
                return {
                    listeners: [{
                        address: '127.0.0.1',
                        port: 45_705,
                        protocol: 'tcp' as const,
                        pid: 705,
                    }],
                    processes: new Map([[
                        705,
                        {
                            pid: 705,
                            ppid: 1,
                            processStartTimeMs: identityReplaced
                                ? processStartTimeMs + 1
                                : processStartTimeMs,
                            command,
                            executablePath: '/bin/happier-plugin-web',
                            cwd: '/private/runtime',
                        },
                    ]]),
                    workspaces: [],
                    diagnostics: [],
                };
            },
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcess,
            },
        });

        await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration: assignAndInjectManagedDeclaration,
            attachment,
            verifyMaterialization: async () => true,
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'process_identity_mismatch',
        });
        expect(scanCount).toBe(3);
        expect(reattachProcess).toHaveBeenCalledOnce();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();
        expect(rejectedHandle.kill).not.toHaveBeenCalled();
        expect(rejectedHandle.dispose).not.toHaveBeenCalled();

        identityReplaced = false;
        await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration: assignAndInjectManagedDeclaration,
            attachment,
            verifyMaterialization: async () => true,
        })).resolves.toMatchObject({ ok: true });
        expect(scanCount).toBe(6);
        expect(reattachProcess).toHaveBeenCalledTimes(2);
    });

    it('retires default supervision when its post-reconstruction identity proof fails', async () => {
        vi.useFakeTimers();
        try {
            const command = '/bin/happier-plugin-web serve';
            const processStartTimeMs = 1_717_171_717_706;
            let scanCount = 0;
            const signal = vi.fn(async () => undefined);
            const terminateWindowsTree = vi.fn(async () => undefined);
            const context = {
                pluginId: 'happier.cliproxyapi',
                contributionId: 'managed-provider',
                sessionId: 'session-default-supervision-proof-reuse',
                title: 'Managed Provider',
            } as const;
            const attachment = {
                v: 1 as const,
                process: {
                    pid: 706,
                    processStartTimeMs,
                    processCommandHash: hashProcessCommand(command),
                },
                endpoint: { host: '127.0.0.1' as const, port: 45_706 },
                materialization: {
                    rootDir: '/private/runtime',
                    materializationId: 'materialization-default-supervision-proof-reuse',
                },
            };
            const runtime = createLocalServicesDaemonRuntime({
                machineId: 'machine-a',
                inventoryEnabled: () => true,
                scan: async () => {
                    scanCount += 1;
                    return {
                        listeners: [{
                            address: '127.0.0.1',
                            port: 45_706,
                            protocol: 'tcp' as const,
                            pid: 706,
                        }],
                        processes: new Map([[
                            706,
                            {
                                pid: 706,
                                ppid: 1,
                                processStartTimeMs: scanCount === 3
                                    ? processStartTimeMs + 1
                                    : processStartTimeMs,
                                command,
                                executablePath: '/bin/happier-plugin-web',
                                cwd: '/private/runtime',
                            },
                        ]]),
                        workspaces: [],
                        diagnostics: [],
                    };
                },
                startLoop: false,
                managedLocalServices: {
                    exec: createExecService(createProcessHandle(999)),
                    reattachProcessControl: {
                        platform: 'posix',
                        probeListener: vi.fn(async () => ({
                            pid: 706,
                            startTime: processStartTimeMs,
                            command,
                        })),
                        isProcessAlive: vi.fn(async () => true),
                        signal,
                        terminateWindowsTree,
                        wait: vi.fn(async () => undefined),
                    },
                },
            });

            await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
                context,
                declaration: assignAndInjectManagedDeclaration,
                attachment,
                verifyMaterialization: async () => true,
            })).resolves.toEqual({
                ok: false,
                reasonCode: 'process_identity_mismatch',
            });
            expect(scanCount).toBe(3);
            expect(runtime.trustedManagedLocalServices.readOwnedRun({
                context,
                serviceId: assignAndInjectManagedDeclaration.id,
            })).toBeNull();

            await vi.advanceTimersByTimeAsync(1_001);
            expect(scanCount).toBe(3);
            expect(signal).not.toHaveBeenCalled();
            expect(terminateWindowsTree).not.toHaveBeenCalled();

            await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
                context,
                declaration: assignAndInjectManagedDeclaration,
                attachment,
                verifyMaterialization: async () => true,
            })).resolves.toMatchObject({ ok: true });
            expect(scanCount).toBe(6);
            await runtime.stop({ disposition: 'transfer' });
            expect(signal).not.toHaveBeenCalled();
            expect(terminateWindowsTree).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        {
            name: 'wildcard listener',
            listener: { address: '0.0.0.0', port: 45_701, protocol: 'tcp' as const, pid: 701 },
            processStartTimeMs: 1_717_171_717_701,
            command: '/private/runtime/cliproxyapi serve',
            reasonCode: 'listener_identity_mismatch',
            executablePath: '/bin/happier-plugin-web',
        },
        {
            name: 'reused process',
            listener: { address: '127.0.0.1', port: 45_701, protocol: 'tcp' as const, pid: 701 },
            processStartTimeMs: 1_717_171_717_702,
            command: '/private/runtime/cliproxyapi serve',
            reasonCode: 'process_identity_mismatch',
            executablePath: '/bin/happier-plugin-web',
        },
        {
            name: 'foreign executable artifact',
            listener: { address: '127.0.0.1', port: 45_701, protocol: 'tcp' as const, pid: 701 },
            processStartTimeMs: 1_717_171_717_701,
            command: '/private/runtime/cliproxyapi serve',
            executablePath: '/private/runtime/foreign-binary',
            reasonCode: 'executable_artifact_mismatch',
        },
    ])('refuses $name without authorizing, adopting, or supervising it', async ({
        listener,
        processStartTimeMs,
        command,
        executablePath,
        reasonCode,
    }) => {
        const attachedCommand = '/private/runtime/cliproxyapi serve';
        const verifyMaterialization = vi.fn(async () => true);
        const reattachProcess = vi.fn(async () => createProcessHandle(701));
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-mismatch',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 701,
                processStartTimeMs: 1_717_171_717_701,
                processCommandHash: hashProcessCommand(attachedCommand),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_701 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-mismatch',
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [listener],
                processes: new Map([[
                    701,
                    {
                        pid: 701,
                        ppid: 1,
                        processStartTimeMs,
                        command,
                        executablePath,
                        cwd: '/private/runtime',
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcess,
            },
        });

        await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration: assignAndInjectManagedDeclaration,
            attachment,
            verifyMaterialization,
        })).resolves.toEqual({ ok: false, reasonCode });
        expect(verifyMaterialization).not.toHaveBeenCalled();
        expect(reattachProcess).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();
    });

    it('never signals a reattached PID after its exact process identity changes', async () => {
        const command = '/private/runtime/cliproxyapi serve';
        const executablePath = '/private/runtime/cliproxyapi';
        let processStartTimeMs = 1_717_171_717_703;
        const signal = vi.fn(async () => undefined);
        const terminateWindowsTree = vi.fn(async () => undefined);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-guarded-stop',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 703,
                processStartTimeMs,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_703 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-guarded-stop',
            },
        };
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                kind: 'binary',
                executablePath,
                args: ['serve'],
                env: { EXISTING: '1' },
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{
                    address: '127.0.0.1',
                    port: 45_703,
                    protocol: 'tcp',
                    pid: 703,
                }],
                processes: new Map([[
                    703,
                    {
                        pid: 703,
                        ppid: 1,
                        processStartTimeMs,
                        command,
                        executablePath,
                        cwd: '/private/runtime',
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachTerminationGraceMs: 0,
                reattachProcessControl: {
                    platform: 'posix',
                    probeListener: vi.fn(async () => ({
                        pid: 703,
                        startTime: processStartTimeMs,
                        command,
                    })),
                    isProcessAlive: vi.fn(async () => true),
                    signal,
                    terminateWindowsTree,
                    wait: vi.fn(async () => undefined),
                },
            },
        });
        const result = await runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization: async () => true,
        });
        expect(result.ok).toBe(true);

        processStartTimeMs += 1;
        await expect(runtime.trustedManagedLocalServices.stopOwned(
            result.ok ? result.ownedRun : {
                serviceKey: 'unreachable',
                runId: 0,
            },
        )).resolves.toEqual({ status: 'unavailable' });
        expect(signal).not.toHaveBeenCalled();
        expect(terminateWindowsTree).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: declaration.id,
        })).toBeNull();
        expect(runtime.managedRegistry.getService(
            result.ok ? result.ownedRun.serviceKey : 'unreachable',
        )).toMatchObject({
            phase: 'failed',
            diagnostics: [{ code: 'process_ownership_unverified', severity: 'error' }],
        });
    });

    it('stops an exact reattached Windows wrapper through guarded tree termination', async () => {
        const command = 'C:\\Happier\\versions\\A\\happier-cliproxyapi-managed.exe serve';
        const executablePath =
            'C:\\Happier\\versions\\A\\happier-cliproxyapi-managed.exe';
        const signal = vi.fn(async () => undefined);
        let processAlive = true;
        const terminateWindowsTree = vi.fn(async (input: {
            pid: number;
            force: boolean;
        }) => {
            if (input.force) processAlive = false;
        });
        const attachment = {
            v: 1 as const,
            process: {
                pid: 704,
                processStartTimeMs: 1_717_171_717_704,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_704 },
            materialization: {
                rootDir: 'C:\\Happier\\providers\\session-windows',
                materializationId: 'materialization-windows-stop',
            },
        };
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-windows-stop',
            title: 'Managed Provider',
        } as const;
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                kind: 'binary',
                executablePath,
                args: ['serve'],
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-windows',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: processAlive ? [{
                    address: attachment.endpoint.host,
                    port: attachment.endpoint.port,
                    protocol: 'tcp',
                    pid: attachment.process.pid,
                }] : [],
                processes: processAlive ? new Map([[
                    attachment.process.pid,
                    {
                        pid: attachment.process.pid,
                        ppid: 1,
                        processStartTimeMs:
                            attachment.process.processStartTimeMs,
                        command,
                        executablePath,
                        cwd: attachment.materialization.rootDir,
                    },
                ]]) : new Map(),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachTerminationGraceMs: 0,
                reattachProcessControl: {
                    platform: 'windows',
                    probeListener: vi.fn(async () => ({
                        pid: attachment.process.pid,
                        startTime:
                            attachment.process.processStartTimeMs,
                        command,
                    })),
                    isProcessAlive: vi.fn(async () => processAlive),
                    signal,
                    terminateWindowsTree,
                    wait: vi.fn(async () => undefined),
                },
            },
        });
        const result =
            await runtime.trustedManagedLocalServices.reattachVerifiedRun({
                context,
                declaration,
                attachment,
                verifyMaterialization: async () => true,
            });
        expect(result.ok).toBe(true);

        await expect(runtime.trustedManagedLocalServices.stopOwned(
            result.ok ? result.ownedRun : {
                serviceKey: 'unreachable',
                runId: 0,
            },
        )).resolves.toEqual({ status: 'stopped' });
        expect(terminateWindowsTree.mock.calls).toEqual([
            [{ pid: attachment.process.pid, force: false }],
            [{ pid: attachment.process.pid, force: true }],
        ]);
        expect(signal).not.toHaveBeenCalled();
    });

    it.each(['posix', 'windows'] as const)(
        'does not report a reattached %s wrapper stopped or run post-stop cleanup while forced termination remains live',
        async (platform) => {
        const command = '/private/runtime/cliproxyapi serve';
        const executablePath = '/private/runtime/cliproxyapi';
        const signal = vi.fn(async () => undefined);
        const terminateWindowsTree = vi.fn(async () => undefined);
        const afterProcessStop = vi.fn(async () => undefined);
        const attachment = {
            v: 1 as const,
            process: {
                pid: 708,
                processStartTimeMs: 1_717_171_717_708,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_708 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-force-stop-still-live',
            },
        };
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-force-stop-still-live',
            title: 'Managed Provider',
        } as const;
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                kind: 'binary',
                executablePath,
                args: ['serve'],
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{
                    address: attachment.endpoint.host,
                    port: attachment.endpoint.port,
                    protocol: 'tcp',
                    pid: attachment.process.pid,
                }],
                processes: new Map([[
                    attachment.process.pid,
                    {
                        pid: attachment.process.pid,
                        ppid: 1,
                        processStartTimeMs:
                            attachment.process.processStartTimeMs,
                        command,
                        executablePath,
                        cwd: attachment.materialization.rootDir,
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachTerminationGraceMs: 0,
                reattachProcessControl: {
                    platform,
                    probeListener: vi.fn(async () => ({
                        pid: attachment.process.pid,
                        startTime:
                            attachment.process.processStartTimeMs,
                        command,
                    })),
                    isProcessAlive: vi.fn(async () => true),
                    signal,
                    terminateWindowsTree,
                    wait: vi.fn(async () => undefined),
                },
            },
        });
        const result =
            await runtime.trustedManagedLocalServices.reattachVerifiedRun({
                context,
                declaration,
                attachment,
                verifyMaterialization: async () => true,
            });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected reattached run');
        expect(runtime.trustedManagedLocalServices.registerOwnedCleanup(
            result.ownedRun,
            afterProcessStop,
        )).toBe(true);

        await expect(runtime.trustedManagedLocalServices.stopOwned(
            result.ownedRun,
        )).resolves.toEqual({ status: 'unavailable' });
        if (platform === 'windows') {
            expect(terminateWindowsTree.mock.calls).toEqual([
                [{ pid: attachment.process.pid, force: false }],
                [{ pid: attachment.process.pid, force: true }],
            ]);
            expect(signal).not.toHaveBeenCalled();
        } else {
            expect(signal.mock.calls).toEqual([
                [{ pid: attachment.process.pid, signal: 'SIGTERM', group: false }],
                [{ pid: attachment.process.pid, signal: 'SIGKILL', group: false }],
            ]);
            expect(terminateWindowsTree).not.toHaveBeenCalled();
        }
        expect(afterProcessStop).not.toHaveBeenCalled();
    });

    it('never signals when the exact listener becomes wildcard-bound during final stop verification', async () => {
        const command = '/private/runtime/cliproxyapi serve';
        const executablePath = '/private/runtime/cliproxyapi';
        let listenerAddress = '127.0.0.1';
        const signal = vi.fn(async () => undefined);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-guarded-stop-listener',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 705,
                processStartTimeMs: 1_717_171_717_705,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_705 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-guarded-stop-listener',
            },
        };
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                kind: 'binary',
                executablePath,
                args: ['serve'],
                env: { EXISTING: '1' },
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{
                    address: listenerAddress,
                    port: attachment.endpoint.port,
                    protocol: 'tcp',
                    pid: attachment.process.pid,
                }],
                processes: new Map([[
                    attachment.process.pid,
                    {
                        pid: attachment.process.pid,
                        ppid: 1,
                        processStartTimeMs: attachment.process.processStartTimeMs,
                        command,
                        executablePath,
                        cwd: attachment.materialization.rootDir,
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachTerminationGraceMs: 0,
                reattachProcessControl: {
                    platform: 'posix',
                    probeListener: vi.fn(async () => {
                        listenerAddress = '0.0.0.0';
                        return {
                            pid: attachment.process.pid,
                            startTime: attachment.process.processStartTimeMs,
                            command,
                        };
                    }),
                    isProcessAlive: vi.fn(async () => true),
                    signal,
                    terminateWindowsTree: vi.fn(async () => undefined),
                    wait: vi.fn(async () => undefined),
                },
            },
        });
        const result = await runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization: async () => true,
        });
        expect(result.ok).toBe(true);

        await expect(runtime.trustedManagedLocalServices.stopOwned(
            result.ok ? result.ownedRun : {
                serviceKey: 'unreachable',
                runId: 0,
            },
        )).resolves.toEqual({ status: 'unavailable' });
        expect(signal).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: declaration.id,
        })).toBeNull();
        expect(runtime.managedRegistry.getService(
            result.ok ? result.ownedRun.serviceKey : 'unreachable',
        )).toMatchObject({
            phase: 'failed',
            diagnostics: [{ code: 'process_ownership_unverified', severity: 'error' }],
        });
    });

    it('does not classify empty scan facts with platform failure diagnostics as an absent process', async () => {
        const command = '/private/runtime/cliproxyapi serve';
        const executablePath = '/private/runtime/cliproxyapi';
        let scanAuthoritative = true;
        const signal = vi.fn(async () => undefined);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-guarded-stop-scan-failure',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 706,
                processStartTimeMs: 1_717_171_717_706,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_706 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-guarded-stop-scan-failure',
            },
        };
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                ...assignAndInjectManagedDeclaration.launch,
                kind: 'binary',
                executablePath,
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => scanAuthoritative ? {
                listeners: [{
                    address: attachment.endpoint.host,
                    port: attachment.endpoint.port,
                    protocol: 'tcp' as const,
                    pid: attachment.process.pid,
                }],
                processes: new Map([[
                    attachment.process.pid,
                    {
                        pid: attachment.process.pid,
                        ppid: 1,
                        processStartTimeMs: attachment.process.processStartTimeMs,
                        command,
                        executablePath,
                        cwd: attachment.materialization.rootDir,
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            } : {
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'darwin_lsof_scan_failed',
                    severity: 'warning' as const,
                }],
            },
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcessControl: {
                    platform: 'posix',
                    probeListener: vi.fn(async () => null),
                    isProcessAlive: vi.fn(async () => false),
                    signal,
                    terminateWindowsTree: vi.fn(async () => undefined),
                    wait: vi.fn(async () => undefined),
                },
            },
        });
        const result = await runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization: async () => true,
        });
        expect(result.ok).toBe(true);

        scanAuthoritative = false;
        await expect(runtime.trustedManagedLocalServices.stopOwned(
            result.ok ? result.ownedRun : {
                serviceKey: 'unreachable',
                runId: 0,
            },
        )).resolves.toEqual({ status: 'unavailable' });
        expect(signal).not.toHaveBeenCalled();
        expect(runtime.managedRegistry.getService(
            result.ok ? result.ownedRun.serviceKey : 'unreachable',
        )).toMatchObject({
            phase: 'failed',
            diagnostics: [{ code: 'process_ownership_unverified', severity: 'error' }],
        });
    });

    it('does not let bulk permanent shutdown swallow a guarded process-identity mismatch', async () => {
        const command = '/private/runtime/cliproxyapi serve';
        const executablePath = '/private/runtime/cliproxyapi';
        let processStartTimeMs = 1_717_171_717_707;
        const signal = vi.fn(async () => undefined);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-bulk-guarded-stop',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 707,
                processStartTimeMs,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_707 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-bulk-guarded-stop',
            },
        };
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                ...assignAndInjectManagedDeclaration.launch,
                kind: 'binary',
                executablePath,
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{
                    address: attachment.endpoint.host,
                    port: attachment.endpoint.port,
                    protocol: 'tcp',
                    pid: attachment.process.pid,
                }],
                processes: new Map([[
                    attachment.process.pid,
                    {
                        pid: attachment.process.pid,
                        ppid: 1,
                        processStartTimeMs,
                        command,
                        executablePath,
                        cwd: attachment.materialization.rootDir,
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcessControl: {
                    platform: 'posix',
                    probeListener: vi.fn(async () => null),
                    isProcessAlive: vi.fn(async () => true),
                    signal,
                    terminateWindowsTree: vi.fn(async () => undefined),
                    wait: vi.fn(async () => undefined),
                },
            },
        });
        const result = await runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization: async () => true,
        });
        expect(result.ok).toBe(true);

        processStartTimeMs += 1;
        await expect(runtime.stop()).rejects.toThrow('managed_local_service_shutdown_incomplete');
        expect(signal).not.toHaveBeenCalled();
        expect(runtime.managedRegistry.getService(
            result.ok ? result.ownedRun.serviceKey : 'unreachable',
        )).toMatchObject({
            phase: 'failed',
            diagnostics: [{ code: 'process_ownership_unverified', severity: 'error' }],
        });
    });

    it('releases route and port claims when supervision reconstruction fails', async () => {
        const command = '/private/runtime/cliproxyapi serve';
        const executablePath = '/private/runtime/cliproxyapi';
        const mismatchedHandle = createProcessHandle(999);
        const exactHandle = createProcessHandle(704);
        const reattachProcess = vi.fn()
            .mockResolvedValueOnce(mismatchedHandle)
            .mockResolvedValueOnce(exactHandle);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-supervision-rollback',
            title: 'Managed Provider',
        } as const;
        const attachment = {
            v: 1 as const,
            process: {
                pid: 704,
                processStartTimeMs: 1_717_171_717_704,
                processCommandHash: hashProcessCommand(command),
            },
            endpoint: { host: '127.0.0.1' as const, port: 45_704 },
            materialization: {
                rootDir: '/private/runtime',
                materializationId: 'materialization-supervision-rollback',
            },
        };
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            launch: {
                kind: 'binary',
                executablePath,
                args: ['serve'],
                env: { EXISTING: '1' },
            },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{
                    address: '127.0.0.1',
                    port: 45_704,
                    protocol: 'tcp',
                    pid: 704,
                }],
                processes: new Map([[
                    704,
                    {
                        pid: 704,
                        ppid: 1,
                        processStartTimeMs: 1_717_171_717_704,
                        command,
                        executablePath,
                        cwd: '/private/runtime',
                    },
                ]]),
                workspaces: [],
                diagnostics: [],
            }),
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(999)),
                reattachProcess,
            },
        });

        await expect(runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization: async () => true,
        })).resolves.toEqual({
            ok: false,
            reasonCode: 'process_supervision_identity_mismatch',
        });
        expect(mismatchedHandle.dispose).not.toHaveBeenCalled();
        const retried = await runtime.trustedManagedLocalServices.reattachVerifiedRun({
            context,
            declaration,
            attachment,
            verifyMaterialization: async () => true,
        });
        expect(retried.ok).toBe(true);
    });

    it('exposes only the exact daemon-owned run and makes stale cleanup unable to stop its replacement', async () => {
        const firstProcess = createProcessHandle(300);
        const secondProcess = createProcessHandle(301);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(firstProcess)
            .mockResolvedValueOnce(secondProcess);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-a',
            title: 'Managed Provider',
        } as const;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            readManagedProcessIdentityByPid: async (pid) => ({
                pid,
                processStartTimeMs: 1_717_171_717_300,
                command: '/observed/runtime/binary --observed-argv',
            }),
            managedLocalServices: {
                exec: { spawn },
                portRange: { start: 45_100, end: 45_101 },
            },
        });

        const first = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: { spawn },
        });
        expect(first).toMatchObject({
            runId: 1,
            process: {
                pid: 300,
                processStartTimeMs: 1_717_171_717_300,
                processCommandHash: hashProcessCommand('/observed/runtime/binary --observed-argv'),
            },
            host: '127.0.0.1',
            port: 45_100,
            snapshot: { phase: 'running', port: 45_100 },
        });
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toEqual(first);

        const replacementRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
        });
        expect(replacementRuntime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();

        const second = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: { spawn },
        });
        expect(second).toMatchObject({
            runId: 2,
            process: { pid: 301 },
            host: '127.0.0.1',
            port: 45_100,
        });
        expect(firstProcess.dispose).toHaveBeenCalledTimes(1);

        await expect(runtime.trustedManagedLocalServices.stopOwned(first!))
            .resolves.toEqual({ status: 'stale' });
        expect(secondProcess.dispose).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toEqual(second);

        await expect(runtime.trustedManagedLocalServices.stopOwned(second!))
            .resolves.toEqual({ status: 'stopped' });
        expect(secondProcess.dispose).toHaveBeenCalledTimes(1);
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();
    });

    it('keeps a stopped run token stale after the same service starts again', async () => {
        const firstProcess = createProcessHandle(302);
        const restartedProcess = createProcessHandle(303);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(firstProcess)
            .mockResolvedValueOnce(restartedProcess);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-restart',
            title: 'Managed Provider',
        } as const;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                portRange: { start: 45_102, end: 45_102 },
            },
        });

        const first = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: { spawn },
        });
        await expect(runtime.trustedManagedLocalServices.stopOwned(first!))
            .resolves.toEqual({ status: 'stopped' });

        const restarted = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: { spawn },
        });
        expect(restarted!.runId).toBeGreaterThan(first!.runId);

        await expect(runtime.trustedManagedLocalServices.stopOwned(first!))
            .resolves.toEqual({ status: 'stale' });
        expect(restartedProcess.dispose).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toEqual(restarted);

        await expect(runtime.trustedManagedLocalServices.stopOwned(restarted!))
            .resolves.toEqual({ status: 'stopped' });
        expect(restartedProcess.dispose).toHaveBeenCalledTimes(1);
    });

    it('distinguishes graceful supervision transfer from awaited permanent shutdown', async () => {
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-transfer',
            title: 'Managed Provider',
        } as const;
        const transferredProcess = createProcessHandle(310);
        const transferRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(transferredProcess),
                portRange: { start: 45_110, end: 45_110 },
            },
        });
        const transferredRun = await transferRuntime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: createExecService(transferredProcess),
        });
        const transferredCleanup = vi.fn(async () => undefined);
        expect(transferRuntime.trustedManagedLocalServices.registerOwnedCleanup(
            transferredRun!,
            transferredCleanup,
        )).toBe(true);

        await expect(transferRuntime.trustedManagedLocalServices.transferOwned(transferredRun!))
            .resolves.toEqual({ status: 'transferred' });
        expect(transferredProcess.dispose).not.toHaveBeenCalled();
        expect(transferredCleanup).not.toHaveBeenCalled();
        expect(transferRuntime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();
        await transferRuntime.stop({ disposition: 'transfer' });
        expect(transferredProcess.dispose).not.toHaveBeenCalled();

        const disposeGate = createDeferred<void>();
        const permanentProcess = {
            ...createProcessHandle(311),
            dispose: vi.fn(async () => await disposeGate.promise),
        };
        const permanentRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(permanentProcess),
                portRange: { start: 45_111, end: 45_111 },
            },
        });
        const permanentRun = await permanentRuntime.trustedManagedLocalServices.startOwned({
            context: { ...context, sessionId: 'session-permanent' },
            declaration: assignAndInjectManagedDeclaration,
            exec: createExecService(permanentProcess),
        });
        const permanentCleanupEvents: string[] = [];
        expect(permanentRuntime.trustedManagedLocalServices.registerOwnedCleanup(
            permanentRun!,
            async () => {
                permanentCleanupEvents.push('before-stop');
            },
            { phase: 'beforeProcessStop' },
        )).toBe(true);
        expect(permanentRuntime.trustedManagedLocalServices.registerOwnedCleanup(
            permanentRun!,
            async () => {
                permanentCleanupEvents.push('first');
            },
        )).toBe(true);
        expect(permanentRuntime.trustedManagedLocalServices.registerOwnedCleanup(
            permanentRun!,
            async () => {
                permanentCleanupEvents.push('second');
            },
        )).toBe(true);

        let permanentStopSettled = false;
        const permanentStop = permanentRuntime.stop().then(() => {
            permanentStopSettled = true;
        });
        await vi.waitFor(() => {
            expect(permanentProcess.dispose).toHaveBeenCalledOnce();
        });
        expect(permanentStopSettled).toBe(false);
        expect(permanentCleanupEvents).toEqual(['before-stop']);
        disposeGate.resolve();
        await permanentStop;
        expect(permanentStopSettled).toBe(true);
        expect(permanentCleanupEvents).toEqual(['before-stop', 'second', 'first']);
    });

    it('keeps a rejected authority-retirement participant registered across repeated owned stops', async () => {
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-authority-retirement-fails',
            title: 'Managed Provider',
        } as const;
        const processHandle = createProcessHandle(313);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(processHandle),
                portRange: { start: 45_113, end: 45_113 },
            },
        });
        const run = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: createExecService(processHandle),
        });
        const retireAuthority = vi.fn(async () => {
            throw new Error('authority retirement unavailable');
        });
        expect(runtime.trustedManagedLocalServices.registerOwnedCleanup(
            run!,
            retireAuthority,
            { phase: 'beforeProcessStop' },
        )).toBe(true);

        await expect(runtime.trustedManagedLocalServices.stopOwned(run!))
            .resolves.toEqual({ status: 'unavailable' });
        await expect(runtime.trustedManagedLocalServices.stopOwned(run!))
            .resolves.toEqual({ status: 'unavailable' });

        expect(retireAuthority).toHaveBeenCalledTimes(2);
        expect(processHandle.dispose).not.toHaveBeenCalled();
    });

    it('keeps graceful supervision transfer available when preview cleanup is unavailable', async () => {
        const processHandle = createProcessHandle(312);
        const cleanup = vi.fn(async () => undefined);
        const onError = vi.fn(() => {
            throw new Error('diagnostic sink unavailable');
        });
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            onError,
            managedLocalServices: {
                exec: createExecService(processHandle),
                portRange: { start: 45_112, end: 45_112 },
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
                unregisterPreviewEndpoint: async () => {
                    throw new Error('preview control unavailable');
                },
            },
        });
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-transfer-preview-unavailable',
            title: 'Managed Provider',
        } as const;
        const run = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec: createExecService(processHandle),
        });
        expect(runtime.trustedManagedLocalServices.registerOwnedCleanup(run!, cleanup)).toBe(true);

        await expect(runtime.trustedManagedLocalServices.transferOwned(run!))
            .resolves.toEqual({ status: 'transferred' });

        expect(onError).toHaveBeenCalledWith(expect.objectContaining({
            message: 'preview control unavailable',
        }));
        expect(processHandle.dispose).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(runtime.trustedManagedLocalServices.readOwnedRun({
            context,
            serviceId: assignAndInjectManagedDeclaration.id,
        })).toBeNull();
    });

    it('owns a bounded operation run without manufacturing a session launcher or preview', async () => {
        const processHandle = createProcessHandle(302);
        const exec = createExecService(processHandle);
        const context = {
            pluginId: 'happier.provider.cliproxyapi',
            contributionId: 'cliproxyapi',
            operationId: 'catalog-probe-a',
            title: 'CLIProxyAPI catalog probe',
        } as const;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec,
                portRange: { start: 45_102, end: 45_102 },
            },
        });

        const run = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration: assignAndInjectManagedDeclaration,
            exec,
        });

        expect(run).toMatchObject({
            process: { pid: 302 },
            host: '127.0.0.1',
            port: 45_102,
        });
        expect((await runtime.launcherRoutes.getSnapshot()).targets).toEqual([]);
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);

        await expect(runtime.trustedManagedLocalServices.stopOwned(run!))
            .resolves.toEqual({ status: 'stopped' });
        expect(processHandle.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not scan when inventory is feature-disabled and preserves stale cached entries with diagnostics', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // Deterministic disabled gate (no server snapshot wired): with the gate off the scan
            // is skipped and cached entries are preserved + marked stale. `localServices.inventory`
            // is now server-represented, so without a snapshot the decision is fail-closed
            // (probe_failed), which is what the disabled-snapshot diagnostic reports.
            inventoryEnabled: () => false,
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('stale');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_probe_failed', severity: 'info' },
        ]);
    });

    it('preserves last-known listening entries when a listener scan failure is non-authoritative', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'darwin_lsof_scan_failed',
                    severity: 'warning' as const,
                    message: 'Darwin local-service listener scan failed.',
                }],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.refreshState).toBe('error');
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
        expect(snapshot.diagnostics).toEqual([{
            code: 'darwin_lsof_scan_failed',
            severity: 'warning',
            message: 'Darwin local-service listener scan failed.',
        }]);
    });

    it('keeps launcher targets openable after a non-authoritative inventory scan failure', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [{
                    code: 'linux_procfs_scan_failed',
                    severity: 'warning' as const,
                    message: 'procfs unavailable',
                }],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        await runtime.refreshInventoryNow();
        const launcherSnapshot = await runtime.launcherRoutes.getSnapshot();
        const target = launcherSnapshot.targets.find((candidate) => candidate.id === 'inventory:entry-1');

        expect(target).toMatchObject({
            state: 'available',
            actions: ['open'],
            browserTarget: { kind: 'externalUrl' },
        });
    });

    it('runs the inventory scan when the server reports localServices inventory enabled', async () => {
        const scan = vi.fn(async () => ({
            listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 400 }],
            processes: new Map([
                [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
            ]),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // Server-represented gate (default-allow): the daemon scans when the server allows it.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: true, inventory: { enabled: true } } },
                    capabilities: {},
                }),
            }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).toHaveBeenCalledOnce();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('listening');
    });

    it('does not scan when the server explicitly disables localServices inventory', async () => {
        const scan = vi.fn(async () => ({
            listeners: [],
            processes: new Map(),
            workspaces: [],
            diagnostics: [],
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            // A server that sets the bit false disables inventory scanning for its users.
            resolveServerFeaturesSnapshot: () => ({
                status: 'ready',
                features: FeaturesResponseSchema.parse({
                    features: { localServices: { enabled: false, inventory: { enabled: false } } },
                    capabilities: {},
                }),
            }),
            scan,
            now: () => 2_000,
            startLoop: false,
        });
        runtime.inventoryRegistry.replaceSnapshot(buildSnapshot());

        const snapshot = await runtime.refreshInventoryNow();

        expect(scan).not.toHaveBeenCalled();
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.state).toBe('stale');
        expect(snapshot.diagnostics).toEqual([
            { code: 'local_services_inventory_feature_disabled', severity: 'info' },
        ]);
    });

    it('refreshes inventory through the scanner and feeds managed detect-after-launch correlation', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev', cwd: '/repo/app' }],
                ]),
                workspaces: [{ id: 'workspace-a', path: '/repo' }],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
        });
        runtime.managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_500 },
            routeName: 'plugin-a-web',
        });

        await runtime.refreshInventoryNow();

        expect(runtime.managedRegistry.getService('plugin-a:web')).toMatchObject({
            phase: 'running',
            inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            port: 5173,
        });
    });

    it('single-flights concurrent refreshInventoryNow callers onto one coalesced scan', async () => {
        let resolveScan: () => void = () => {};
        const scanGate = new Promise<void>((resolve) => {
            resolveScan = resolve;
        });
        const scan = vi.fn(async () => {
            await scanGate;
            return {
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp' as const, pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 1, command: 'node server.js', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            };
        });
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan,
            now: () => 2_000,
            startLoop: false,
        });

        // Three concurrent refresh requests (e.g. the loop tick + an RPC manual refresh +
        // a bare caller) must share a single in-flight scan rather than stacking machine-wide
        // scans on top of each other.
        const first = runtime.refreshInventoryNow();
        const second = runtime.refreshInventoryNow();
        const third = runtime.refreshInventoryNow();
        resolveScan();
        const [a, b, c] = await Promise.all([first, second, third]);

        expect(scan).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(a.entries).toHaveLength(1);

        // A later refresh, once the first has settled, starts a fresh scan (the guard
        // coalesces overlapping callers, it does not cache forever).
        await runtime.refreshInventoryNow();
        expect(scan).toHaveBeenCalledTimes(2);
    });

    it('adds daemon-owned workspace facts to scanner results before normalizing provenance', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'npm run dev -- --token raw-secret', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            workspaceFacts: () => [{ path: '/repo' }],
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries[0]).toMatchObject({
            workspaceAssociationConfidence: 'high',
            provenance: {
                workspace: {
                    path: '/repo',
                    association: 'cwd_containment',
                },
            },
        });
        expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('raw-secret');
    });

    it('enriches listening local services with bounded page-title presentation without changing identity', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            pageTitleEnricher: {
                fetchTitle: async (url) => {
                    expect(url).toBe('http://127.0.0.1:5173/');
                    return { title: 'Local Vite App', source: 'html_title' };
                },
            },
            endpointEnricher: {
                enrich: async (snapshot) => ({
                    ...snapshot,
                    entries: snapshot.entries.map((entry) => ({
                        ...entry,
                        endpoint: {
                            scheme: 'http' as const,
                            host: '127.0.0.1',
                            port: entry.port,
                            probeState: 'ready' as const,
                            probedAt: 2_000,
                        },
                    })),
                }),
            },
            now: () => 2_000,
            startLoop: false,
        });

        const snapshot = await runtime.refreshInventoryNow();

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            id: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            presentation: {
                displayName: 'Vite',
                pageTitle: 'Local Vite App',
                pageTitleSource: 'html_title',
                addressLabel: 'localhost:5173',
            },
        });
    });

    it('owns one registered preview registry and exposes it as a snapshot route', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 4_000,
            startLoop: false,
        });

        expect(runtime.previewRegistry).toBeTruthy();
        expect(runtime.previewRoutes).toBeTruthy();

        registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-b',
            sessionId: 'session-b',
            machineId: 'machine-a',
            owner: { kind: 'agent', id: 'agent-b' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5174 },
            initialPath: { pathname: '/b', search: '' },
            display: { title: 'B', addressLabel: 'localhost:5174' },
            originMode: 'host',
        });
        registerLocalServicePreview(runtime.previewRegistry, {
            previewId: 'preview-a',
            sessionId: 'session-a',
            machineId: 'machine-a',
            owner: { kind: 'plugin', id: 'plugin-a' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
            initialPath: { pathname: '/', search: '?v=1' },
            display: { title: 'A', addressLabel: 'localhost:5173' },
            originMode: 'path',
        });

        await expect(runtime.previewRoutes.getSnapshot()).resolves.toMatchObject({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 4_000,
            refreshState: 'idle',
            resources: [
                { previewId: 'preview-a' },
                { previewId: 'preview-b' },
            ],
            diagnostics: [],
        });
    });

    it('activates hosted-web static asset previews through the daemon-owned preview registry', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => false,
            now: () => 5_000,
            startLoop: false,
            hostedWebStaticAssets: {
                verifyArtifact: () => ({ ok: true }),
                startServer: async (input) => {
                    const previewId = buildPluginHostedWebStaticAssetPreviewId(input.preview);
                    const previewResource = {
                        previewId,
                        sessionId: input.preview.sessionId,
                        machineId: input.preview.machineId,
                        owner: { kind: 'plugin' as const, id: input.preview.pluginId },
                        target: { scheme: 'http' as const, host: '127.0.0.1', port: 51515 },
                        initialPath: { pathname: '/', search: '' },
                        display: { title: input.preview.title, addressLabel: '127.0.0.1:51515' },
                        originMode: 'path' as const,
                    };
                    return {
                        baseUrl: 'http://127.0.0.1:51515',
                        endpoint: { scheme: 'http', host: '127.0.0.1', port: 51515 },
                        previewResource,
                        previewRegistration: await input.registerPreview?.(previewResource),
                        stop: async () => {
                            await input.unregisterPreview?.(previewId);
                        },
                    };
                },
            },
        });

        const result = await runtime.syncHostedWebStaticAssets([{
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            machineId: 'machine-a',
            title: 'Preview web',
            installedRoot: '/plugin/root/dist/happier-plugin-ui',
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-artifact',
                assetRootId: 'hosted-web/preview-web',
            },
            artifactManifest: {
                version: 1,
                entries: [{
                    contributionId: 'preview-web',
                    tier: 'hostedWeb',
                    platform: 'web',
                    entry: 'hosted-web/preview-web/index.html',
                    files: [{
                        relativePath: 'hosted-web/preview-web/index.html',
                        digest: `sha256:${'b'.repeat(64)}`,
                        byteSize: 1,
                    }],
                    digest: `sha256:${'a'.repeat(64)}`,
                    builtWith: { bundler: 'vite', version: '6.0.0' },
                    hostUiApiVersion: '1.0.0',
                    compat: { react: '19.0.0' },
                }],
            },
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    scriptSrc: 'selfOnly',
                    styleSrc: 'selfOnly',
                    imgSrc: 'selfOnly',
                    fontSrc: 'selfOnly',
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'deny',
            },
        }]);

        expect(result.active).toHaveLength(1);
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([
            expect.objectContaining({
                previewId: 'plugin-static:acme.preview:preview-web:session-a:machine-a',
                sessionId: 'session-a',
                owner: { kind: 'plugin', id: 'acme.preview' },
            }),
        ]);

        runtime.stop();

        await expect(runtime.stopHostedWebStaticAssets()).resolves.toBeUndefined();
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
    });

    it('starts hosted-web managed local services through the daemon bridge and returns a registered preview access URL', async () => {
        const processHandle = createProcessHandle(300);
        const exec = createExecService(processHandle);
        const registerPreviewEndpoint = vi.fn(async (resource) => ({
            ok: true as const,
            resource,
            accessUrl: 'https://app.happier.test/v1/local-services/preview/plugin-managed%3Aacme.preview%3Apreview-web%3Aweb/?previewToken=token_1',
            expiresAt: 62_000,
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [{ id: 'workspace-a', path: '/repo' }],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec,
                registerPreviewEndpoint,
            },
        });

        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });

        await bridge.declare?.(hostedWebManagedDeclaration);
        const snapshot = await bridge.start(hostedWebManagedDeclaration);

        expect(exec.spawn).toHaveBeenCalledWith(hostedWebManagedDeclaration.launch, expect.any(Object));
        expect(registerPreviewEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            previewId: 'plugin-managed:acme.preview:preview-web:web',
            sessionId: 'session-a',
            machineId: 'machine-a',
            owner: { kind: 'plugin', id: 'acme.preview' },
            target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
        }));
        expect(snapshot).toEqual({
            id: 'web',
            phase: 'running',
            inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400:start-unknown',
            port: 5173,
            url: 'https://app.happier.test/v1/local-services/preview/plugin-managed%3Aacme.preview%3Apreview-web%3Aweb/?previewToken=token_1',
            diagnostics: [],
        });
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([
            expect.objectContaining({
                previewId: 'plugin-managed:acme.preview:preview-web:web',
                browserTarget: expect.objectContaining({
                    kind: 'localServicePreview',
                    targetId: 'plugin-managed:acme.preview:preview-web:web',
                }),
            }),
        ]);
    });

    it('projects declared plugin-managed detect-after-launch services as startable launcher targets', async () => {
        const processHandle = createProcessHandle(300);
        const exec = createExecService(processHandle);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [],
                processes: new Map(),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: { exec },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);

        await bridge.declare?.(hostedWebManagedDeclaration);
        const snapshot = await runtime.launcherRoutes.getSnapshot();

        expect(exec.spawn).not.toHaveBeenCalled();
        expect(snapshot.targets).toContainEqual(expect.objectContaining({
            id: `managed:${serviceKey}`,
            source: 'managed_service',
            sourceClass: {
                kind: 'managed_service',
                managedServiceId: serviceKey,
            },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Preview web',
            state: 'available',
            actions: ['start'],
        }));
        expect(snapshot.targets.find((target) => target.id === `managed:${serviceKey}`)).not.toHaveProperty('commandPreview');
    });

    it('keeps plugin-managed Start advertised after managed Stop removes live process and preview ownership', async () => {
        const processHandle = createProcessHandle(300);
        const exec = createExecService(processHandle);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec,
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
                unregisterPreviewEndpoint: async () => {},
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const managedService = runtime.managedRegistry.listServices()[0];
        expect(managedService).toBeDefined();
        const requestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-stop-startable',
            target: {
                kind: 'managed_service',
                managedServiceId: managedService!.id,
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'stop_managed',
            force: false,
        };

        await expect(runtime.actionRoutes.execute({
            ...requestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(requestWithoutNonce),
        })).resolves.toMatchObject({ status: 'succeeded' });
        const snapshot = await runtime.launcherRoutes.getSnapshot();

        expect(runtime.managedRegistry.getService(managedService!.id)).toBeNull();
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
        expect(snapshot.targets).toContainEqual(expect.objectContaining({
            id: `managed:${managedService!.id}`,
            source: 'managed_service',
            state: 'available',
            actions: ['start'],
        }));
    });

    it('starts retained plugin-managed declarations through launcher Start', async () => {
        const processHandle = createProcessHandle(300);
        const exec = createExecService(processHandle);
        const registerPreviewEndpoint = vi.fn(async (resource) => ({
            ok: true as const,
            resource,
            accessUrl: 'https://app.happier.test/preview/web',
            expiresAt: 62_000,
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec,
                registerPreviewEndpoint,
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        await bridge.declare?.(hostedWebManagedDeclaration);

        const result = await runtime.launcherRoutes.startTarget?.({
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            sessionId: 'session-a',
        });

        expect(result).toMatchObject({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            status: 'succeeded',
        });
        expect(exec.spawn).toHaveBeenCalledWith(hostedWebManagedDeclaration.launch, expect.any(Object));
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({
            phase: 'running',
            port: 5173,
        });
        expect(registerPreviewEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            previewId: 'plugin-managed:acme.preview:preview-web:web',
        }));
        expect(result?.snapshot.targets.find((target) => target.id === `managed:${serviceKey}`)).toBeUndefined();
    });

    it('keeps launcher Start successful with a warning when preview endpoint minting rejects after spawn', async () => {
        const exec = createExecService(createProcessHandle(300));
        const registerPreviewEndpoint = vi.fn(async () => {
            throw new Error('preview endpoint unavailable');
        });
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec,
                registerPreviewEndpoint,
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        await bridge.declare?.(hostedWebManagedDeclaration);

        const result = await runtime.launcherRoutes.startTarget?.({
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            sessionId: 'session-a',
        });
        const snapshot = await bridge.get?.('web');

        expect(result).toMatchObject({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            status: 'succeeded',
        });
        expect(exec.spawn).toHaveBeenCalledWith(hostedWebManagedDeclaration.launch, expect.any(Object));
        expect(registerPreviewEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            previewId: 'plugin-managed:acme.preview:preview-web:web',
        }));
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({
            phase: 'running',
            port: 5173,
        });
        expect(snapshot).toMatchObject({
            id: 'web',
            phase: 'running',
            port: 5173,
            diagnostics: [
                { code: 'PLUGIN_LOCAL_SERVICE_PREVIEW_ENDPOINT_REGISTRATION_FAILED', severity: 'warning' },
            ],
        });
        expect(snapshot).not.toHaveProperty('url');
    });

    it('starts assign-and-inject managed services through the launcher with allocated port + injected PORT/HOST and a canonical route name', async () => {
        const processHandle = createProcessHandle(300);
        const exec = createExecService(processHandle);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec,
                portRange: { start: 45_100, end: 45_110 },
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        await bridge.declare?.(assignAndInjectManagedDeclaration);

        const result = await runtime.launcherRoutes.startTarget?.({
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            sessionId: 'session-a',
        });

        expect(result).toMatchObject({ status: 'succeeded' });
        expect(exec.spawn).toHaveBeenCalledTimes(1);
        const spawnedLaunch = exec.spawn.mock.calls[0]?.[0];
        expect(spawnedLaunch).toMatchObject({ kind: 'binary' });
        const spawnedEnv = (spawnedLaunch as { env?: Record<string, string> }).env ?? {};
        expect(spawnedEnv.EXISTING).toBe('1'); // base env preserved
        expect(spawnedEnv.HOST).toBe('127.0.0.1');
        const allocatedPort = Number(spawnedEnv.PORT);
        expect(allocatedPort).toBeGreaterThanOrEqual(45_100);
        expect(allocatedPort).toBeLessThanOrEqual(45_110);

        const managedService = runtime.managedRegistry.getService(serviceKey);
        expect(managedService).toMatchObject({
            phase: 'running',
            launchMode: 'assignAndInject',
            port: allocatedPort,
            host: '127.0.0.1',
            routeName: 'acme-preview-preview-web-web-session-a',
        });

        // The route lock is held while running, then released + the port freed on stop.
        const stopRequest: LocalServiceActionRequestV1 = {
            requestId: 'request-stop-assign',
            target: { kind: 'managed_service', managedServiceId: serviceKey, machineId: 'machine-a', sessionId: 'session-a' },
            action: 'stop_managed',
            force: false,
        };
        await expect(runtime.actionRoutes.execute({
            ...stopRequest,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(stopRequest),
        })).resolves.toMatchObject({ status: 'succeeded' });
        expect(runtime.managedRegistry.getService(serviceKey)).toBeNull();
    });

    it('reuses the same allocated port across a keep-alive restart and only frees it on stop', async () => {
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(createProcessHandle(300))
            .mockResolvedValueOnce(createProcessHandle(301))
            .mockResolvedValueOnce(createProcessHandle(302));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                portRange: { start: 45_200, end: 45_210 },
                registerPreviewEndpoint: async (resource) => ({ ok: true, resource, accessUrl: 'https://app.happier.test/preview/web', expiresAt: 62_000 }),
                unregisterPreviewEndpoint: async () => {},
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview', contributionId: 'preview-web', sessionId: 'session-a', title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        await bridge.declare?.(assignAndInjectManagedDeclaration);
        await runtime.launcherRoutes.startTarget?.({ machineId: 'machine-a', targetId: `managed:${serviceKey}`, sessionId: 'session-a' });
        const firstPort = Number((spawn.mock.calls[0]?.[0] as { env?: Record<string, string> }).env?.PORT);

        const restartRequest: LocalServiceActionRequestV1 = {
            requestId: 'request-restart-assign',
            target: { kind: 'managed_service', managedServiceId: serviceKey, machineId: 'machine-a', sessionId: 'session-a' },
            action: 'restart_managed',
            force: false,
        };
        await expect(runtime.actionRoutes.execute({
            ...restartRequest,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(restartRequest),
        })).resolves.toMatchObject({ status: 'succeeded' });
        const restartPort = Number((spawn.mock.calls[1]?.[0] as { env?: Record<string, string> }).env?.PORT);
        expect(restartPort).toBe(firstPort); // keep-alive restart keeps the port

        // Explicit stop frees it; a subsequent start may move (but at least re-reserves cleanly).
        const stopRequest: LocalServiceActionRequestV1 = {
            requestId: 'request-stop-after-restart',
            target: { kind: 'managed_service', managedServiceId: serviceKey, machineId: 'machine-a', sessionId: 'session-a' },
            action: 'stop_managed',
            force: false,
        };
        await runtime.actionRoutes.execute({ ...stopRequest, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stopRequest) });
        expect(runtime.managedRegistry.getService(serviceKey)).toBeNull();
    });

    it('injects peer <NAME>_PORT/<NAME>_URL for a multi-service owner+session group', async () => {
        const apiProcess = createProcessHandle(300);
        const webProcess = createProcessHandle(301);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(apiProcess)
            .mockResolvedValueOnce(webProcess);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: { exec: { spawn }, portRange: { start: 45_300, end: 45_310 } },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview', contributionId: 'preview-web', sessionId: 'session-a', title: 'Preview web',
        });
        const apiDeclaration: LocalServiceDeclarationV1 = { ...assignAndInjectManagedDeclaration, id: 'api' };
        const webDeclaration: LocalServiceDeclarationV1 = { ...assignAndInjectManagedDeclaration, id: 'web' };
        await bridge.declare?.(apiDeclaration);
        await bridge.declare?.(webDeclaration);

        await bridge.start(apiDeclaration);
        await bridge.start(webDeclaration);

        const webEnv = (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> }).env ?? {};
        // web should see the api peer's port + url.
        expect(webEnv.API_PORT).toBeDefined();
        expect(webEnv.API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('fails fast when two group service ids collapse to the same peer env name', async () => {
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>(
            async () => createProcessHandle(300),
        );
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: { exec: { spawn }, portRange: { start: 45_400, end: 45_410 } },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview', contributionId: 'preview-web', sessionId: 'session-a', title: 'Preview web',
        });
        // `web-1` and `web.1` both normalize to WEB_1.
        await bridge.declare?.({ ...assignAndInjectManagedDeclaration, id: 'web-1' });
        await bridge.declare?.({ ...assignAndInjectManagedDeclaration, id: 'web.1' });

        const snapshot = await bridge.start({ ...assignAndInjectManagedDeclaration, id: 'web-1' });
        expect(snapshot).toMatchObject({ phase: 'failed' });
        expect(snapshot.diagnostics[0]?.code).toBe('PLUGIN_LOCAL_SERVICE_ENV_NAME_COLLISION');
        expect(spawn).not.toHaveBeenCalled();
    });

    it('denies launcher Start for externalRegistered declarations and missing managed runtimes without spawning', async () => {
        const unsupportedSpawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>();
        const unsupportedRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: { spawn: unsupportedSpawn },
            },
        });
        const unsupportedBridge = unsupportedRuntime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        const unsupportedDeclaration: LocalServiceDeclarationV1 = {
            ...hostedWebManagedDeclaration,
            launchMode: {
                kind: 'externalRegistered',
                inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
            },
        };
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        await unsupportedBridge.declare?.(unsupportedDeclaration);

        await expect(unsupportedRuntime.launcherRoutes.startTarget?.({
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            sessionId: 'session-a',
        })).resolves.toMatchObject({
            status: 'denied',
            reasonCode: 'start_launch_mode_unsupported',
        });
        expect(unsupportedSpawn).not.toHaveBeenCalled();

        const missingRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
        });
        const missingRuntimeBridge = missingRuntime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await missingRuntimeBridge.declare?.(hostedWebManagedDeclaration);

        await expect(missingRuntime.launcherRoutes.startTarget?.({
            machineId: 'machine-a',
            targetId: `managed:${serviceKey}`,
            sessionId: 'session-a',
        })).resolves.toMatchObject({
            status: 'denied',
            reasonCode: 'start_runtime_unavailable',
        });
    });

    it('stops hosted-web managed local services through the canonical action route', async () => {
        const processHandle = createProcessHandle(300);
        const exec = createExecService(processHandle);
        const unregisterPreviewEndpoint = vi.fn(async () => {});
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [{ id: 'workspace-a', path: '/repo/app' }],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec,
                unregisterPreviewEndpoint,
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const managedService = runtime.managedRegistry.listServices()[0];
        expect(managedService).toBeDefined();

        const requestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-stop',
            target: {
                kind: 'managed_service',
                managedServiceId: managedService!.id,
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'stop_managed',
            force: false,
        };
        const request = {
            ...requestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(requestWithoutNonce),
        };

        const result = await runtime.actionRoutes.execute(request);

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'succeeded',
        });
        expect(processHandle.dispose).toHaveBeenCalledOnce();
        expect(unregisterPreviewEndpoint).toHaveBeenCalledWith('plugin-managed:acme.preview:preview-web:web');
        expect(runtime.managedRegistry.getService(managedService!.id)).toBeNull();
        expect(await bridge.get?.('web')).toEqual({
            id: 'web',
            phase: 'stopped',
            diagnostics: [],
        });
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([]);
    });

    it('rejects hosted-web managed local service stop when the confirmation nonce is bound to a different request', async () => {
        const processHandle = createProcessHandle(300);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(processHandle),
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const managedService = runtime.managedRegistry.listServices()[0];
        expect(managedService).toBeDefined();
        const nonceRequest: LocalServiceActionRequestV1 = {
            requestId: 'request-other',
            target: { kind: 'managed_service', managedServiceId: managedService!.id, machineId: 'machine-a' },
            action: 'stop_managed',
            force: false,
        };

        const result = await runtime.actionRoutes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: managedService!.id, machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(nonceRequest),
            force: false,
        });

        expect(result).toMatchObject({
            status: 'denied',
            reasonCode: 'confirmation_nonce_invalid',
        });
        expect(processHandle.dispose).not.toHaveBeenCalled();
        expect(runtime.managedRegistry.getService(managedService!.id)).not.toBeNull();
    });

    it('does not let declared plugin snapshots stop managed registry rows without process or preview ownership', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.declare?.(hostedWebManagedDeclaration);
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        runtime.managedRegistry.startDetectAfterLaunch({
            id: serviceKey,
            owner: { kind: 'plugin', pluginId: 'acme.preview' },
            minimumConfidence: 'medium',
            process: { pid: 900, startedAt: 1_500 },
            routeName: 'acme-preview-web',
        });
        const requestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-stop-unowned',
            target: { kind: 'managed_service', managedServiceId: serviceKey, machineId: 'machine-a' },
            action: 'stop_managed',
            force: false,
        };

        const result = await runtime.actionRoutes.execute({
            ...requestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(requestWithoutNonce),
        });

        expect(result).toMatchObject({
            status: 'denied',
            reasonCode: 'managed_stop_owner_unavailable',
        });
        expect(runtime.managedRegistry.getService(serviceKey)).not.toBeNull();
    });

    it('keeps managed stop ownership available when process cleanup fails', async () => {
        const processHandle: ExecProcessHandleV1 = {
            ...createProcessHandle(300),
            dispose: vi.fn()
                .mockRejectedValueOnce(new Error('dispose failed'))
                .mockResolvedValueOnce(undefined),
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(processHandle),
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
                unregisterPreviewEndpoint: async () => {},
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const managedService = runtime.managedRegistry.listServices()[0];
        expect(managedService).toBeDefined();

        const firstRequestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-stop-fails',
            target: { kind: 'managed_service', managedServiceId: managedService!.id, machineId: 'machine-a' },
            action: 'stop_managed',
            force: false,
        };
        const firstResult = await runtime.actionRoutes.execute({
            ...firstRequestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(firstRequestWithoutNonce),
        });

        expect(firstResult).toMatchObject({
            status: 'failed',
            reasonCode: 'managed_stop_owner_failed',
        });
        expect(processHandle.dispose).toHaveBeenCalledOnce();
        expect(runtime.managedRegistry.getService(managedService!.id)).not.toBeNull();

        const secondRequestWithoutNonce: LocalServiceActionRequestV1 = {
            ...firstRequestWithoutNonce,
            requestId: 'request-stop-retry',
        };
        const secondResult = await runtime.actionRoutes.execute({
            ...secondRequestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(secondRequestWithoutNonce),
        });

        expect(secondResult).toMatchObject({
            status: 'succeeded',
        });
        expect(processHandle.dispose).toHaveBeenCalledTimes(2);
        expect(runtime.managedRegistry.getService(managedService!.id)).toBeNull();
    });

    it('restarts hosted-web managed local services through the canonical action route', async () => {
        const firstProcess = createProcessHandle(300);
        const secondProcess = createProcessHandle(301);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(firstProcess)
            .mockResolvedValueOnce(secondProcess);
        const unregisterPreviewEndpoint = vi.fn(async () => {});
        const registerPreviewEndpoint = vi.fn(async (resource) => ({
            ok: true as const,
            resource,
            accessUrl: `https://app.happier.test/preview/${resource.previewId}/${registerPreviewEndpoint.mock.calls.length}`,
            expiresAt: 62_000,
        }));
        let scanGeneration = 0;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => {
                scanGeneration += 1;
                const processPid = scanGeneration === 1 ? 300 : 301;
                const listenerPid = scanGeneration === 1 ? 400 : 401;
                const port = scanGeneration === 1 ? 5173 : 5174;
                return {
                    listeners: [{ address: '127.0.0.1', port, protocol: 'tcp', pid: listenerPid }],
                    processes: new Map([
                        [listenerPid, { pid: listenerPid, ppid: processPid, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                        [processPid, { pid: processPid, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                    ]),
                    workspaces: [{ id: 'workspace-a', path: '/repo/app' }],
                    diagnostics: [],
                };
            },
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                unregisterPreviewEndpoint,
                registerPreviewEndpoint,
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const firstManagedService = runtime.managedRegistry.listServices()[0];
        expect(firstManagedService).toMatchObject({
            process: { pid: 300 },
            port: 5173,
        });

        const requestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-restart',
            target: {
                kind: 'managed_service',
                managedServiceId: firstManagedService!.id,
                machineId: 'machine-a',
                sessionId: 'session-a',
            },
            action: 'restart_managed',
            force: false,
        };
        const result = await runtime.actionRoutes.execute({
            ...requestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(requestWithoutNonce),
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-restart',
            action: 'restart_managed',
            status: 'succeeded',
        });
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(firstProcess.dispose).toHaveBeenCalledOnce();
        expect(unregisterPreviewEndpoint).toHaveBeenCalledWith('plugin-managed:acme.preview:preview-web:web');
        expect(runtime.managedRegistry.getService(firstManagedService!.id)).toMatchObject({
            process: { pid: 301 },
            port: 5174,
        });
        expect(await bridge.get?.('web')).toMatchObject({
            id: 'web',
            phase: 'running',
            port: 5174,
        });
    });

    it('projects daemon-owned restart support in managed snapshots without leaking launch intent', async () => {
        const processHandle = createProcessHandle(300);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>(
            async () => processHandle,
        );
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: `https://app.happier.test/preview/${resource.previewId}`,
                    expiresAt: 62_000,
                }),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });

        await bridge.start(hostedWebManagedDeclaration);

        const snapshot = await runtime.managedRoutes.getSnapshot();
        expect(snapshot.rows[0]).toMatchObject({
            owner: { kind: 'plugin', pluginId: 'acme.preview' },
            phase: 'running',
            supportedActions: ['stop_managed', 'restart_managed'],
        });
        expect(snapshot.rows[0]).not.toHaveProperty('launch');
        expect(snapshot.rows[0]).not.toHaveProperty('restartPolicy');
    });

    it('ignores stale old process exits after restarting a managed local service', async () => {
        let resolveFirstExit!: (result: Awaited<ExecProcessHandleV1['exit']>) => void;
        const firstProcess: ExecProcessHandleV1 = {
            ...createProcessHandle(300),
            exit: new Promise<Awaited<ExecProcessHandleV1['exit']>>((resolve) => {
                resolveFirstExit = resolve;
            }),
        };
        const secondProcess = createProcessHandle(301);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(firstProcess)
            .mockResolvedValueOnce(secondProcess);
        let scanGeneration = 0;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => {
                scanGeneration += 1;
                const processPid = scanGeneration === 1 ? 300 : 301;
                const listenerPid = scanGeneration === 1 ? 400 : 401;
                const port = scanGeneration === 1 ? 5173 : 5174;
                return {
                    listeners: [{ address: '127.0.0.1', port, protocol: 'tcp', pid: listenerPid }],
                    processes: new Map([
                        [listenerPid, { pid: listenerPid, ppid: processPid, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                        [processPid, { pid: processPid, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                    ]),
                    workspaces: [],
                    diagnostics: [],
                };
            },
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: `https://app.happier.test/preview/${resource.previewId}`,
                    expiresAt: 62_000,
                }),
                unregisterPreviewEndpoint: async () => {},
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const managedService = runtime.managedRegistry.listServices()[0];
        expect(managedService).toMatchObject({ process: { pid: 300 }, phase: 'running' });
        const requestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-restart-stale-exit',
            target: { kind: 'managed_service', managedServiceId: managedService!.id, machineId: 'machine-a' },
            action: 'restart_managed',
            force: false,
        };

        await expect(runtime.actionRoutes.execute({
            ...requestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(requestWithoutNonce),
        })).resolves.toMatchObject({ status: 'succeeded' });
        expect(runtime.managedRegistry.getService(managedService!.id)).toMatchObject({
            phase: 'running',
            process: { pid: 301 },
        });

        resolveFirstExit({ exitCode: 0, signal: null, stdout: '', stderr: '' });
        await firstProcess.exit;
        await Promise.resolve();

        expect(runtime.managedRegistry.getService(managedService!.id)).toMatchObject({
            phase: 'running',
            process: { pid: 301 },
        });
    });

    it('does not let declared plugin snapshots restart managed registry rows without process or preview ownership', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.declare?.(hostedWebManagedDeclaration);
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        runtime.managedRegistry.startDetectAfterLaunch({
            id: serviceKey,
            owner: { kind: 'plugin', pluginId: 'acme.preview' },
            minimumConfidence: 'medium',
            process: { pid: 900, startedAt: 1_500 },
            routeName: 'acme-preview-web',
        });
        const requestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-restart-unowned',
            target: { kind: 'managed_service', managedServiceId: serviceKey, machineId: 'machine-a' },
            action: 'restart_managed',
            force: false,
        };

        const result = await runtime.actionRoutes.execute({
            ...requestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(requestWithoutNonce),
        });

        expect(result).toMatchObject({
            status: 'denied',
            reasonCode: 'managed_restart_unavailable',
        });
        expect(runtime.managedRegistry.getService(serviceKey)).not.toBeNull();
    });

    it('keeps managed restart ownership available when old process cleanup fails', async () => {
        const firstProcess: ExecProcessHandleV1 = {
            ...createProcessHandle(300),
            dispose: vi.fn()
                .mockRejectedValueOnce(new Error('dispose failed'))
                .mockResolvedValueOnce(undefined),
        };
        const secondProcess = createProcessHandle(301);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(firstProcess)
            .mockResolvedValueOnce(secondProcess);
        let scanGeneration = 0;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => {
                scanGeneration += 1;
                const processPid = scanGeneration === 1 ? 300 : 301;
                const listenerPid = scanGeneration === 1 ? 400 : 401;
                return {
                    listeners: [{ address: '127.0.0.1', port: scanGeneration === 1 ? 5173 : 5174, protocol: 'tcp', pid: listenerPid }],
                    processes: new Map([
                        [listenerPid, { pid: listenerPid, ppid: processPid, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                        [processPid, { pid: processPid, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                    ]),
                    workspaces: [],
                    diagnostics: [],
                };
            },
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                registerPreviewEndpoint: async (resource) => ({
                    ok: true,
                    resource,
                    accessUrl: 'https://app.happier.test/preview/web',
                    expiresAt: 62_000,
                }),
                unregisterPreviewEndpoint: async () => {},
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const managedService = runtime.managedRegistry.listServices()[0];
        expect(managedService).toBeDefined();

        const firstRequestWithoutNonce: LocalServiceActionRequestV1 = {
            requestId: 'request-restart-fails',
            target: { kind: 'managed_service', managedServiceId: managedService!.id, machineId: 'machine-a' },
            action: 'restart_managed',
            force: false,
        };
        const firstResult = await runtime.actionRoutes.execute({
            ...firstRequestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(firstRequestWithoutNonce),
        });

        expect(firstResult).toMatchObject({
            status: 'failed',
            reasonCode: 'managed_restart_owner_failed',
        });
        expect(firstProcess.dispose).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledOnce();
        expect(runtime.managedRegistry.getService(managedService!.id)).toMatchObject({
            process: { pid: 300 },
        });

        const secondRequestWithoutNonce: LocalServiceActionRequestV1 = {
            ...firstRequestWithoutNonce,
            requestId: 'request-restart-retry',
        };
        const secondResult = await runtime.actionRoutes.execute({
            ...secondRequestWithoutNonce,
            confirmationNonce: createLocalServiceActionConfirmationNonceV1(secondRequestWithoutNonce),
        });

        expect(secondResult).toMatchObject({
            status: 'succeeded',
        });
        expect(firstProcess.dispose).toHaveBeenCalledTimes(2);
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(runtime.managedRegistry.getService(managedService!.id)).toMatchObject({
            process: { pid: 301 },
        });
    });

    it('isolates hosted-web managed local services with the same declaration id across plugins', async () => {
        const processA = createProcessHandle(300);
        const processB = createProcessHandle(301);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(processA)
            .mockResolvedValueOnce(processB);
        const registerPreviewEndpoint = vi.fn(async (resource) => ({
            ok: true as const,
            resource,
            accessUrl: `https://app.happier.test/v1/local-services/preview/${encodeURIComponent(resource.previewId)}/?previewToken=token`,
            expiresAt: 62_000,
        }));
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [
                    { address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 },
                    { address: '127.0.0.1', port: 5174, protocol: 'tcp', pid: 401 },
                ],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/plugin-a' }],
                    [401, { pid: 401, ppid: 301, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/plugin-b' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/plugin-a' }],
                    [301, { pid: 301, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/plugin-b' }],
                ]),
                workspaces: [
                    { id: 'workspace-a', path: '/repo/plugin-a' },
                    { id: 'workspace-b', path: '/repo/plugin-b' },
                ],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                registerPreviewEndpoint,
            },
        });
        const bridgeA = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview-a',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview A',
        });
        const bridgeB = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview-b',
            contributionId: 'preview-web',
            sessionId: 'session-b',
            title: 'Preview B',
        });

        const snapshotA = await bridgeA.start(hostedWebManagedDeclaration);
        const snapshotB = await bridgeB.start(hostedWebManagedDeclaration);
        expect(bridgeA.get).toBeDefined();
        const refreshedSnapshotA = await bridgeA.get?.('web');

        expect(snapshotA).toMatchObject({
            id: 'web',
            phase: 'running',
            port: 5173,
            url: 'https://app.happier.test/v1/local-services/preview/plugin-managed%3Aacme.preview-a%3Apreview-web%3Aweb/?previewToken=token',
        });
        expect(snapshotB).toMatchObject({
            id: 'web',
            phase: 'running',
            port: 5174,
            url: 'https://app.happier.test/v1/local-services/preview/plugin-managed%3Aacme.preview-b%3Apreview-web%3Aweb/?previewToken=token',
        });
        expect(refreshedSnapshotA).toMatchObject({
            id: 'web',
            phase: 'running',
            port: 5173,
            url: 'https://app.happier.test/v1/local-services/preview/plugin-managed%3Aacme.preview-a%3Apreview-web%3Aweb/?previewToken=token',
        });
        expect(listLocalServicePreviewResources(runtime.previewRegistry)).toEqual([
            expect.objectContaining({ previewId: 'plugin-managed:acme.preview-a:preview-web:web' }),
            expect.objectContaining({ previewId: 'plugin-managed:acme.preview-b:preview-web:web' }),
        ]);
    });

    it('keeps hosted-web managed local services fail-closed when preview endpoint minting is unavailable', async () => {
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(300)),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview',
            contributionId: 'preview-web',
            sessionId: 'session-a',
            title: 'Preview web',
        });

        const snapshot = await bridge.start(hostedWebManagedDeclaration);

        expect(snapshot).toMatchObject({
            id: 'web',
            phase: 'running',
            port: 5173,
            diagnostics: [
                { code: 'PLUGIN_LOCAL_SERVICE_PREVIEW_ENDPOINT_UNAVAILABLE', severity: 'warning' },
            ],
        });
        expect(snapshot).not.toHaveProperty('url');
    });

    it('serializes concurrent stops of one service so the process disposes exactly once', async () => {
        const processHandle = createProcessHandle(300);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({
                listeners: [{ address: '127.0.0.1', port: 5173, protocol: 'tcp', pid: 400 }],
                processes: new Map([
                    [400, { pid: 400, ppid: 300, command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo/app' }],
                    [300, { pid: 300, ppid: 1, command: 'happier-plugin-web serve', cwd: '/repo/app' }],
                ]),
                workspaces: [],
                diagnostics: [],
            }),
            now: () => 2_000,
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(processHandle),
                registerPreviewEndpoint: async (resource) => ({ ok: true, resource, accessUrl: 'https://app.happier.test/preview/web', expiresAt: 62_000 }),
                unregisterPreviewEndpoint: async () => {},
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview', contributionId: 'preview-web', sessionId: 'session-a', title: 'Preview web',
        });
        await bridge.start(hostedWebManagedDeclaration);
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);

        // Fire two concurrent stops. The guard serializes them: one wins, the second sees no
        // owner. The process disposes exactly once (no double-dispose race).
        const [first, second] = await Promise.all([
            bridge.stop?.('web'),
            bridge.stop?.('web'),
        ]);
        void first;
        void second;

        expect(processHandle.dispose).toHaveBeenCalledTimes(1);
        expect(runtime.managedRegistry.getService(serviceKey)).toBeNull();
    });

    it('runs a grace+threshold health monitor for assign-and-inject http health checks', async () => {
        let clock = 2_000;
        let healthy = true;
        const probe = vi.fn(async () => healthy);
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => clock,
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(createProcessHandle(300)),
                portRange: { start: 45_500, end: 45_510 },
                healthProbe: probe,
                registerPreviewEndpoint: async (resource) => ({ ok: true, resource, accessUrl: 'https://app.happier.test/preview/web', expiresAt: 62_000 }),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview', contributionId: 'preview-web', sessionId: 'session-a', title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        const httpHealthDeclaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            healthCheck: { kind: 'http', path: '/healthz', timeoutMs: 100 },
        };
        await bridge.declare?.(httpHealthDeclaration);
        await bridge.start(httpHealthDeclaration);

        // Within the grace period: no probe yet.
        await runtime.refreshInventoryNow();
        expect(probe).not.toHaveBeenCalled();
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({ phase: 'running' });

        // Past grace, single transient failure stays running (threshold not met).
        clock = 2_000 + 6_000;
        healthy = false;
        await runtime.refreshInventoryNow();
        expect(probe).toHaveBeenCalledTimes(1);
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({ phase: 'running' });

        // Second consecutive failure flips to unhealthy.
        await runtime.refreshInventoryNow();
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({ phase: 'unhealthy' });

        // Recovery returns to running.
        healthy = true;
        await runtime.refreshInventoryNow();
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({ phase: 'running' });

        // Stop prunes the monitor (no further probing of a stopped service).
        const stopRequest: LocalServiceActionRequestV1 = {
            requestId: 'request-stop-health',
            target: { kind: 'managed_service', managedServiceId: serviceKey, machineId: 'machine-a', sessionId: 'session-a' },
            action: 'stop_managed',
            force: false,
        };
        await runtime.actionRoutes.execute({ ...stopRequest, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stopRequest) });
        const probeCountAfterStop = probe.mock.calls.length;
        await runtime.refreshInventoryNow();
        expect(probe.mock.calls.length).toBe(probeCountAfterStop);
    });

    it('ignores a late health result from a stopped run when its replacement reuses the pid', async () => {
        let clock = 2_000;
        const lateProbe = createDeferred<boolean>();
        const probe = vi.fn()
            .mockResolvedValueOnce(false)
            .mockImplementationOnce(async () => await lateProbe.promise);
        const firstProcess = createProcessHandle(320);
        const restartedProcess = createProcessHandle(320);
        const spawn: MockedFunction<ExecRuntimeServiceV1['spawn']> = vi.fn<ExecRuntimeServiceV1['spawn']>()
            .mockResolvedValueOnce(firstProcess)
            .mockResolvedValueOnce(restartedProcess);
        const context = {
            pluginId: 'happier.cliproxyapi',
            contributionId: 'managed-provider',
            sessionId: 'session-health-restart',
            title: 'Managed Provider',
        } as const;
        const declaration: LocalServiceDeclarationV1 = {
            ...assignAndInjectManagedDeclaration,
            healthCheck: { kind: 'http', path: '/healthz', timeoutMs: 100 },
        };
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => clock,
            startLoop: false,
            managedLocalServices: {
                exec: { spawn },
                portRange: { start: 45_520, end: 45_520 },
                healthProbe: probe,
            },
        });

        const first = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration,
            exec: { spawn },
        });
        clock = 8_000;
        await runtime.refreshInventoryNow();
        expect(runtime.managedRegistry.getService(first!.serviceKey)).toMatchObject({
            phase: 'running',
        });

        const staleHealthPass = runtime.refreshInventoryNow();
        await vi.waitFor(() => {
            expect(probe).toHaveBeenCalledTimes(2);
        });
        await expect(runtime.trustedManagedLocalServices.stopOwned(first!))
            .resolves.toEqual({ status: 'stopped' });
        const restarted = await runtime.trustedManagedLocalServices.startOwned({
            context,
            declaration,
            exec: { spawn },
        });
        expect(restarted!.runId).toBeGreaterThan(first!.runId);

        lateProbe.resolve(false);
        await staleHealthPass;
        expect(runtime.managedRegistry.getService(restarted!.serviceKey)).toMatchObject({
            phase: 'running',
        });

        await expect(runtime.trustedManagedLocalServices.stopOwned(restarted!))
            .resolves.toEqual({ status: 'stopped' });
    });

    it('prunes stale failed managed entries after the cleanup window on the inventory loop', async () => {
        let resolveExit!: (result: Awaited<ExecProcessHandleV1['exit']>) => void;
        const processHandle: ExecProcessHandleV1 = {
            ...createProcessHandle(300),
            exit: new Promise<Awaited<ExecProcessHandleV1['exit']>>((resolve) => { resolveExit = resolve; }),
        };
        let clock = 2_000;
        const runtime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            inventoryEnabled: () => true,
            scan: async () => ({ listeners: [], processes: new Map(), workspaces: [], diagnostics: [] }),
            now: () => clock,
            startLoop: false,
            managedLocalServices: {
                exec: createExecService(processHandle),
                portRange: { start: 45_600, end: 45_610 },
                registerPreviewEndpoint: async (resource) => ({ ok: true, resource, accessUrl: 'https://app.happier.test/preview/web', expiresAt: 62_000 }),
            },
        });
        const bridge = runtime.createPluginLocalServicesBridge({
            pluginId: 'acme.preview', contributionId: 'preview-web', sessionId: 'session-a', title: 'Preview web',
        });
        const serviceKey = JSON.stringify(['acme.preview', 'preview-web', 'session-a', 'web']);
        await bridge.declare?.({ ...assignAndInjectManagedDeclaration, cleanup: { staleAfterMs: 1_000 } });
        await bridge.start({ ...assignAndInjectManagedDeclaration, cleanup: { staleAfterMs: 1_000 } });

        // The process exits -> phase failed (terminal).
        resolveExit({ exitCode: 1, signal: null, stdout: '', stderr: '' });
        await processHandle.exit;
        await Promise.resolve();
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({ phase: 'failed' });

        // Before the cleanup window: still present.
        clock = 2_000 + 500;
        await runtime.refreshInventoryNow();
        expect(runtime.managedRegistry.getService(serviceKey)).toMatchObject({ phase: 'failed' });

        // After the cleanup window: pruned.
        clock = 2_000 + 2_000;
        await runtime.refreshInventoryNow();
        expect(runtime.managedRegistry.getService(serviceKey)).toBeNull();
    });
});
