import { describe, expect, it, vi } from 'vitest';

import { createTerminalRuntimeTranscriptBindingHostService } from './transcriptBinding';

describe('createTerminalRuntimeTranscriptBindingHostService', () => {
    it('opens direct mirrors without exposing host binding internals to plugin callers', async () => {
        const stop = vi.fn(async () => undefined);
        const start = vi.fn(async () => undefined);
        const createMirror = vi.fn(() => ({ start, stop }));
        const service = createTerminalRuntimeTranscriptBindingHostService({ createMirror });
        const onItems = vi.fn();

        const handle = await service.openDirectMirror({
            binding: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'codex-session-1',
            },
            onItems,
        });

        expect(createMirror).toHaveBeenCalledWith({
            binding: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'codex-session-1',
            },
            onItems,
        });
        expect(handle).toEqual({ stop: expect.any(Function) });

        await handle.stop();
        expect(start).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
    });
});
