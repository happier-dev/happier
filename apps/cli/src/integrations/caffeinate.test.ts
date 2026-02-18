import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';

const { spawnMock, caffeinateConfig } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    caffeinateConfig: {
        disableCaffeinate: false,
    },
}));

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        get disableCaffeinate() {
            return caffeinateConfig.disableCaffeinate;
        },
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

type FakeChildProcess = EventEmitter & {
    pid: number;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
};

function createFakeChildProcess(pid = 123): ChildProcess {
    const child = new EventEmitter() as FakeChildProcess;
    child.pid = pid;
    child.killed = false;
    child.kill = (_signal?: NodeJS.Signals) => {
        child.killed = true;
        return true;
    };
    return child as unknown as ChildProcess;
}

describe('caffeinate', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        vi.spyOn(process, 'on').mockImplementation(((..._args: unknown[]) => process) as typeof process.on);
        spawnMock.mockReset();
        caffeinateConfig.disableCaffeinate = false;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        if (originalPlatform) {
            Object.defineProperty(process, 'platform', originalPlatform);
        }
    });

    async function importCaffeinateModule() {
        vi.resetModules();
        return await import('./caffeinate');
    }

    it('returns false when disabled via configuration', async () => {
        caffeinateConfig.disableCaffeinate = true;
        const { startCaffeinate } = await importCaffeinateModule();

        expect(startCaffeinate()).toBe(false);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns false on non-darwin platforms', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const { startCaffeinate } = await importCaffeinateModule();

        expect(startCaffeinate()).toBe(false);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('spawns caffeinate on darwin and avoids duplicate spawn when already running', async () => {
        const fakeChild = createFakeChildProcess(777);
        spawnMock.mockReturnValue(fakeChild);
        const { startCaffeinate, isCaffeinateRunning } = await importCaffeinateModule();

        expect(startCaffeinate()).toBe(true);
        expect(startCaffeinate()).toBe(true);
        expect(isCaffeinateRunning()).toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock).toHaveBeenCalledWith('caffeinate', ['-im'], {
            stdio: 'ignore',
            detached: false,
        });
    });

    it('does not register global unhandledRejection/uncaughtException handlers', async () => {
        const fakeChild = createFakeChildProcess(777);
        spawnMock.mockReturnValue(fakeChild);
        const { startCaffeinate } = await importCaffeinateModule();

        expect(startCaffeinate()).toBe(true);

        const registeredEvents = vi
            .mocked(process.on)
            .mock.calls.map((call) => call[0]);

        expect(registeredEvents).toContain('exit');
        expect(registeredEvents).toContain('SIGINT');
        expect(registeredEvents).toContain('SIGTERM');
        expect(registeredEvents).not.toContain('unhandledRejection');
        expect(registeredEvents).not.toContain('uncaughtException');
    });

    it('unrefs the stop grace-period timer so shutdown is not delayed', async () => {
        const fakeChild = createFakeChildProcess(123);
        spawnMock.mockReturnValue(fakeChild);
        const { startCaffeinate, stopCaffeinate } = await importCaffeinateModule();

        const unrefSpy = vi.fn();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
            ((handler: Parameters<typeof setTimeout>[0]) => {
                if (typeof handler === 'function') {
                    handler();
                }
                return { unref: unrefSpy } as unknown as ReturnType<typeof setTimeout>;
            }) as typeof setTimeout,
        );

        try {
            expect(startCaffeinate()).toBe(true);
            await stopCaffeinate();
            expect(unrefSpy).toHaveBeenCalled();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
