import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { invalidateMachineEnvPresence, useMachineEnvPresence } from './useMachineEnvPresence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machinePreviewEnvSpy = vi.hoisted(() => vi.fn());
const REQUIRED_KEYS = ['OPENAI_API_KEY'];

vi.mock('@/sync/ops', () => ({
    machinePreviewEnv: (...args: unknown[]) => machinePreviewEnvSpy(...args),
}));

async function flushEffects(times = 3): Promise<void> {
    for (let i = 0; i < times; i += 1) {
        await Promise.resolve();
    }
}

function renderPresence(serverId: string): {
    unmount: () => void;
} {
    function Test() {
        useMachineEnvPresence(
            'm1',
            REQUIRED_KEYS,
            { ttlMs: 60_000, serverId },
        );
        return React.createElement('View');
    }

    let root: renderer.ReactTestRenderer;
    act(() => {
        root = renderer.create(React.createElement(Test));
    });

    return {
        unmount: () => {
            act(() => {
                root.unmount();
            });
        },
    };
}

describe('useMachineEnvPresence', () => {
    beforeEach(() => {
        invalidateMachineEnvPresence();
        machinePreviewEnvSpy.mockReset();
        machinePreviewEnvSpy.mockResolvedValue({
            supported: true,
            response: {
                values: {
                    OPENAI_API_KEY: { isSet: true, display: 'set' },
                },
            },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('invalidates server-scoped cache entries when clearing by machine id', async () => {
        const first = renderPresence('server-a');
        await act(async () => {
            await flushEffects();
        });
        first.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(1);

        invalidateMachineEnvPresence({ machineId: 'm1' });

        const second = renderPresence('server-a');
        await act(async () => {
            await flushEffects();
        });
        second.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(2);
    });

    it('can invalidate only one server-scoped machine cache entry', async () => {
        const first = renderPresence('server-a');
        await act(async () => {
            await flushEffects();
        });
        first.unmount();

        const second = renderPresence('server-b');
        await act(async () => {
            await flushEffects();
        });
        second.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(2);

        invalidateMachineEnvPresence({ machineId: 'm1', serverId: 'server-a' });

        const third = renderPresence('server-b');
        await act(async () => {
            await flushEffects();
        });
        third.unmount();

        const fourth = renderPresence('server-a');
        await act(async () => {
            await flushEffects();
        });
        fourth.unmount();

        expect(machinePreviewEnvSpy).toHaveBeenCalledTimes(3);
    });
});
