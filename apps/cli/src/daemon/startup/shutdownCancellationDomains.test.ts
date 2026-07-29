import { describe, expect, it } from 'vitest';

import type {
    ExecProcessHandleV1,
} from '@/plugins/runtime/exec/privateContract';
import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';

import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createPluginExecService } from '@/plugins/runtime/exec/hostService';

import { createDaemonShutdownCancellationDomains } from './shutdownCancellationDomains';

const declaration: LocalServiceDeclarationV1 = {
    id: 'managed-provider',
    launch: {
        kind: 'binary',
        executablePath: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1_000)'],
    },
    launchMode: {
        kind: 'assignAndInject',
        portPolicy: { kind: 'allocated' },
        environment: { inject: ['PORT', 'HOST'] },
    },
    hostPolicy: { kind: 'loopback' },
    name: { strategy: 'derived', base: 'managed-provider' },
    healthCheck: { kind: 'none' },
    restart: { kind: 'never' },
    cleanup: { staleAfterMs: 30_000 },
};

const context = {
    pluginId: 'happier.cliproxyapi',
    contributionId: 'managed-provider',
    sessionId: 'session-real-transfer',
    title: 'Managed Provider',
} as const;

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe('daemon shutdown cancellation domains', () => {
    it('aborts daemon work without killing a transferred real child, but permanently stops one', async () => {
        const execService = createPluginExecService({
            allowedExecutablePaths: [process.execPath],
            allowPathRuntimeNames: [process.execPath.split(/[\\/]/u).at(-1) ?? 'node'],
        });
        const transferDomains = createDaemonShutdownCancellationDomains();
        const transferredHandle: { value: ExecProcessHandleV1 | null } = {
            value: null,
        };
        const transferRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: execService,
                signal: transferDomains.managedLocalServicesProcessSignal,
                portRange: { start: 45_112, end: 45_112 },
            },
        });
        try {
            const run = await transferRuntime.trustedManagedLocalServices.startOwned({
                context,
                declaration,
                exec: {
                    spawn: async (launch, options) => {
                        transferredHandle.value =
                            await execService.spawn(launch, options);
                        return transferredHandle.value;
                    },
                },
            });
            expect(run).not.toBeNull();
            const pid = transferredHandle.value!.pid!;

            transferDomains.beginShutdown();
            expect(transferDomains.daemonWorkSignal.aborted).toBe(true);
            await transferDomains.stopManagedLocalServices(
                transferRuntime,
                'transfer',
            );

            expect(transferDomains.managedLocalServicesProcessSignal.aborted).toBe(false);
            expect(isProcessAlive(pid)).toBe(true);
        } finally {
            await transferredHandle.value?.dispose();
        }

        const permanentDomains = createDaemonShutdownCancellationDomains();
        let permanentlyStoppedHandle: ExecProcessHandleV1 | null = null;
        const permanentRuntime = createLocalServicesDaemonRuntime({
            machineId: 'machine-a',
            startLoop: false,
            managedLocalServices: {
                exec: execService,
                signal: permanentDomains.managedLocalServicesProcessSignal,
                portRange: { start: 45_113, end: 45_113 },
            },
        });
        const run = await permanentRuntime.trustedManagedLocalServices.startOwned({
            context: { ...context, sessionId: 'session-real-permanent' },
            declaration,
            exec: {
                spawn: async (launch, options) => {
                    permanentlyStoppedHandle = await execService.spawn(launch, options);
                    return permanentlyStoppedHandle;
                },
            },
        });
        expect(run).not.toBeNull();
        const pid = permanentlyStoppedHandle!.pid!;

        permanentDomains.beginShutdown();
        await permanentDomains.stopManagedLocalServices(
            permanentRuntime,
            'permanent',
        );

        expect(permanentDomains.daemonWorkSignal.aborted).toBe(true);
        expect(permanentDomains.managedLocalServicesProcessSignal.aborted).toBe(true);
        await expect(permanentlyStoppedHandle!.exit).resolves.toMatchObject({
            exitCode: null,
        });
        expect(isProcessAlive(pid)).toBe(false);
    });
});
