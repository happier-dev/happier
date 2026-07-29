import { describe, expect, it, vi } from 'vitest';

import type { SidecarPrivateLaunchPlan } from './runtime';

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;
type StderrListener = (chunk: string | Uint8Array) => void;

function createFakeProcess() {
    const exitListeners: ExitListener[] = [];
    const errorListeners: ErrorListener[] = [];
    const stderrListeners: StderrListener[] = [];
    const kill = vi.fn(() => true);

    return {
        process: {
            pid: 42,
            stderr: {
                on(event: 'data', listener: StderrListener) {
                    if (event === 'data') stderrListeners.push(listener);
                    return this;
                },
                off(event: 'data', listener: StderrListener) {
                    if (event !== 'data') return this;
                    const index = stderrListeners.indexOf(listener);
                    if (index >= 0) stderrListeners.splice(index, 1);
                    return this;
                },
            },
            once(event: 'exit' | 'error', listener: ExitListener | ErrorListener) {
                if (event === 'exit') exitListeners.push(listener as ExitListener);
                if (event === 'error') errorListeners.push(listener as ErrorListener);
                return this;
            },
            kill,
        },
        kill,
        emitExit(code: number | null, signal: NodeJS.Signals | null = null) {
            for (const listener of exitListeners) listener(code, signal);
        },
        emitError(error: Error) {
            for (const listener of errorListeners) listener(error);
        },
        emitStderr(chunk: string | Uint8Array) {
            for (const listener of [...stderrListeners]) listener(chunk);
        },
    };
}

function privateLaunchPlan(overrides: Partial<SidecarPrivateLaunchPlan> = {}): SidecarPrivateLaunchPlan {
    return {
        sidecarId: 'sidecar_1',
        executablePath: '/managed/chrome',
        args: ['--user-data-dir=/tmp/profile_1', '--remote-debugging-port=0'],
        source: 'managedBrowserPackage',
        profileId: 'profile_1',
        profileDirectory: '/tmp/profile_1',
        cleanupOnStop: true,
        ...overrides,
    };
}

describe('daemon browser sidecar process lifecycle', () => {
    it('launches through the private plan and publishes a public running status without executable paths', async () => {
        const mod = await import('./process');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const fake = createFakeProcess();
        const spawnProcess = vi.fn(() => fake.process);
        const controller = mod.createSidecarProcessController({
            nowMs: () => 3_000,
            spawnProcess,
        });

        const result = controller.launch(privateLaunchPlan());

        expect(spawnProcess).toHaveBeenCalledWith('/managed/chrome', ['--user-data-dir=/tmp/profile_1', '--remote-debugging-port=0']);
        expect(result).toMatchObject({
            ok: true,
            status: {
                v: 1,
                sidecarId: 'sidecar_1',
                state: 'running',
                source: 'managedBrowserPackage',
                profileId: 'profile_1',
                updatedAtMs: 3_000,
            },
        });
        expect(JSON.stringify(result.status)).not.toContain('/managed/chrome');
        expect(JSON.stringify(result.status)).not.toContain('/tmp/profile_1');
    });

    it('moves the public status to crashed when the sidecar process exits unexpectedly', async () => {
        const mod = await import('./process');

        expect(mod).not.toBeNull();
        if (!mod) return;

        let nowMs = 3_000;
        const fake = createFakeProcess();
        const controller = mod.createSidecarProcessController({
            nowMs: () => nowMs,
            spawnProcess: () => fake.process,
        });
        controller.launch(privateLaunchPlan());

        nowMs = 4_000;
        fake.emitExit(1);

        expect(controller.getStatus()).toMatchObject({
            state: 'crashed',
            errorCode: 'process_crashed',
            updatedAtMs: 4_000,
        });
    });

    it('sends SIGTERM and reports stopping when stop is requested for a running sidecar', async () => {
        const mod = await import('./process');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const fake = createFakeProcess();
        const controller = mod.createSidecarProcessController({
            nowMs: () => 5_000,
            spawnProcess: () => fake.process,
        });
        controller.launch(privateLaunchPlan());

        const result = controller.stop();

        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(result).toMatchObject({
            ok: true,
            status: {
                state: 'stopping',
                updatedAtMs: 5_000,
            },
        });
    });

    it('does not overwrite an active sidecar process when launch is requested again', async () => {
        const mod = await import('./process');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const first = createFakeProcess();
        const second = createFakeProcess();
        const spawnProcess = vi.fn()
            .mockReturnValueOnce(first.process)
            .mockReturnValueOnce(second.process);
        const controller = mod.createSidecarProcessController({
            nowMs: () => 6_000,
            spawnProcess,
        });

        expect(controller.launch(privateLaunchPlan({ sidecarId: 'sidecar_1' })).ok).toBe(true);

        const secondLaunch = controller.launch(privateLaunchPlan({ sidecarId: 'sidecar_2' }));
        const stopResult = controller.stop();

        expect(secondLaunch).toMatchObject({
            ok: false,
            status: {
                sidecarId: 'sidecar_1',
                state: 'running',
            },
        });
        expect(spawnProcess).toHaveBeenCalledTimes(1);
        expect(first.kill).toHaveBeenCalledWith('SIGTERM');
        expect(second.kill).not.toHaveBeenCalled();
        expect(stopResult).toMatchObject({
            ok: true,
            status: {
                sidecarId: 'sidecar_1',
                state: 'stopping',
            },
        });
    });

    it('captures a private DevTools endpoint source from sidecar stderr after launch', async () => {
        const mod = await import('./process');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const fake = createFakeProcess();
        const controller = mod.createSidecarProcessController({
            nowMs: () => 7_000,
            spawnProcess: () => fake.process,
        });
        controller.launch(privateLaunchPlan({ sidecarId: 'sidecar_endpoint' }));

        const endpointSource = controller.waitForDevToolsEndpointSource({
            sidecarId: 'sidecar_endpoint',
            timeoutMs: 100,
        });

        fake.emitStderr('[noise] Chrome starting\n');
        fake.emitStderr('DevTools listening on ws://127.0.0.1:9222/devtools/browser/private-token\n');

        await expect(endpointSource).resolves.toMatchObject({
            ok: true,
            endpointSource: {
                kind: 'devtoolsStderr',
                stderr: expect.stringContaining('DevTools listening on ws://127.0.0.1:9222/devtools/browser/private-token'),
            },
        });
        expect(JSON.stringify(controller.getStatus())).not.toContain('private-token');
    });
});
