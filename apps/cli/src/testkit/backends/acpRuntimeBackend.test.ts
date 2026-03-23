import { describe, expect, it } from 'vitest';

describe('createFakeAcpRuntimeBackend', () => {
    it('emits messages and uses the default session id', async () => {
        const mod = await import('./acpRuntimeBackend');
        const backend = mod.createFakeAcpRuntimeBackend();
        const messages: unknown[] = [];

        backend.onMessage((message) => {
            messages.push(message);
        });

        expect(await backend.startSession()).toEqual({ sessionId: 'sess_main' });

        backend.emit({ type: 'event', name: 'test', payload: { ok: true } } as never);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ type: 'event', name: 'test' });
    });

    it('supports method overrides', async () => {
        const mod = await import('./acpRuntimeBackend');
        const prompts: string[] = [];
        const mutatorCalls: Array<{ sessionId: string; value: unknown }> = [];
        const backend = mod.createFakeAcpRuntimeBackend({
            sendPrompt: async (_sessionId, prompt) => {
                prompts.push(prompt);
            },
            setSessionMode: async (sessionId, modeId) => {
                mutatorCalls.push({ sessionId, value: modeId });
            },
            setSessionConfigOption: async (sessionId, _configId, value) => {
                mutatorCalls.push({ sessionId, value });
            },
        });

        await backend.sendPrompt('sess_main', 'hello');
        await backend.setSessionMode!('sess_main', 'plan');
        await backend.setSessionConfigOption!('sess_main', 'model', 'model-a');
        expect(prompts).toEqual(['hello']);
        expect(mutatorCalls).toEqual([
            { sessionId: 'sess_main', value: 'plan' },
            { sessionId: 'sess_main', value: 'model-a' },
        ]);
    });
});
