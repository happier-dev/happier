import { describe, expect, it, vi } from 'vitest';

import { teardownRemoteRuntimeForTerminalSwitch } from './teardownRemoteRuntimeForTerminalSwitch';

describe('teardownRemoteRuntimeForTerminalSwitch', () => {
    it('disconnects the active MCP client and resets the remote switch state', async () => {
        const disconnect = vi.fn(async () => {});
        const reset = vi.fn(async () => {});
        let wasCreated = true;
        let pending: { message: string } | null = { message: 'queued' };
        let thinking = true;

        const nextMode = await teardownRemoteRuntimeForTerminalSwitch({
            client: { disconnect },
            getRemoteRuntime: () => ({ reset }),
            setWasCreated: (value) => {
                wasCreated = value;
            },
            setPending: (value: typeof pending) => {
                pending = value;
            },
            setThinking: (value) => {
                thinking = value;
            },
        });

        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(reset).not.toHaveBeenCalled();
        expect(nextMode).toBe('local');
        expect(wasCreated).toBe(false);
        expect(pending).toBeNull();
        expect(thinking).toBe(false);
    });

    it('resets the Codex runtime when the MCP client is unavailable', async () => {
        const reset = vi.fn(async () => {});
        let wasCreated = true;
        let pending: { message: string } | null = { message: 'queued' };
        let thinking = true;

        const nextMode = await teardownRemoteRuntimeForTerminalSwitch({
            client: null,
            getRemoteRuntime: () => ({ reset }),
            setWasCreated: (value) => {
                wasCreated = value;
            },
            setPending: (value: typeof pending) => {
                pending = value;
            },
            setThinking: (value) => {
                thinking = value;
            },
        });

        expect(reset).toHaveBeenCalledTimes(1);
        expect(nextMode).toBe('local');
        expect(wasCreated).toBe(false);
        expect(pending).toBeNull();
        expect(thinking).toBe(false);
    });
});
