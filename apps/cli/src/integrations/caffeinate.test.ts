import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
}));

vi.mock('child_process', async () => {
    const actual = await vi.importActual<any>('child_process');
    return {
        ...actual,
        spawn: spawnMock,
    };
});

vi.mock('@/configuration', () => ({
    configuration: {
        disableCaffeinate: false,
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

import { startCaffeinate, stopCaffeinate } from './caffeinate';

describe('caffeinate', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    let processOnSpy: any;

    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process as any);
    });

    afterEach(() => {
        processOnSpy?.mockRestore?.();
        if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
        spawnMock.mockReset();
    });

    it('unrefs the stop grace-period timer so shutdown is not delayed', async () => {
        const kill = vi.fn();
        const child: any = {
            pid: 123,
            killed: false,
            on: vi.fn(),
            kill: vi.fn((signal: any) => {
                kill(signal);
                child.killed = true;
                return true;
            }),
        };
        spawnMock.mockReturnValue(child);

        const unrefSpy = vi.fn();
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any) => {
            fn();
            return { unref: unrefSpy } as any;
        });

        try {
            expect(startCaffeinate()).toBe(true);
            await stopCaffeinate();
            expect(unrefSpy).toHaveBeenCalled();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
