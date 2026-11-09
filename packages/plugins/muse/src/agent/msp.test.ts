import { describe, expect, it } from 'vitest';

import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { openMuseMsp } from './msp.js';
import { createMuseMspProcessFixture } from './testkit/mspProcess.js';

async function fixture(options?: { schema?: JsonValue; startupEvent?: boolean }) {
    const { launch, ...boundary } = await createMuseMspProcessFixture(options);
    const exec = createStablePluginExecService({
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
        ...boundary,
    });
    return { exec, launch };
}

describe('Muse MSP native process transport', () => {
    it('initializes once before reads, permits an additive fingerprint and preserves selected launch inputs', async () => {
        const msp = await openMuseMsp(await fixture({ schema: { fingerprint: 'sha256:additive-native-build' } }));
        try {
            expect(await msp.client.request('model/list', {})).toMatchObject({ models: expect.any(Array) });
            expect(msp.initializeResult).toMatchObject({ schema: { version: 1, fingerprint: 'sha256:additive-native-build' } });
            const observation = await msp.client.request('fixture/inspect');
            expect(observation).toMatchObject({
                initialized: true, initializeCount: 1, initializedCount: 1,
                args: ['serve'], autoUpdate: '1', selectedHome: '/selected/native/home',
                initializeParams: { clientInfo: { name: 'happier_muse', version: expect.any(String) } },
                requests: ['initialize', 'initialized', 'model/list', 'fixture/inspect'],
            });
            if (observation && typeof observation === 'object' && 'initializeParams' in observation) {
                expect(observation.initializeParams).toEqual({ clientInfo: { name: 'happier_muse', version: expect.any(String) } });
            }
        } finally { await msp.dispose(); }
    });

    it('refuses an incompatible envelope before initialized and releases its process', async () => {
        let nativePid: number | undefined;
        await expect(openMuseMsp({ ...await fixture({ schema: { version: 2 }, startupEvent: true }),
            onNotification: message => {
                const params = message.params;
                if (message.method === 'fixture/startup' && params && typeof params === 'object'
                    && !Array.isArray(params) && 'pid' in params && typeof params.pid === 'number') nativePid = params.pid;
            },
        })).rejects.toMatchObject({
            data: { code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR' },
        });
        expect(nativePid).toBeTypeOf('number');
        if (nativePid !== undefined) expect(() => process.kill(nativePid, 0)).toThrow();
    });

    it('sends distinct native UUIDv7 command identities and delivers captured native events', async () => {
        const messages: Array<{ method: string; params?: JsonValue }> = [];
        let complete!: () => void;
        const completed = new Promise<void>(resolve => { complete = resolve; });
        const msp = await openMuseMsp({ ...await fixture({ startupEvent: true }),
            onNotification: message => { messages.push(message); if (message.method === 'turn/completed') complete(); },
        });
        const admitted: string[] = [];
        const admissionsAtNativeStart: string[][] = [];
        const receipt = msp.client.onNotificationReceived(message => {
            if (message.method === 'turn/started') admissionsAtNativeStart.push([...admitted]);
        });
        try {
            const beforeCommands = Date.now();
            await msp.command('session/start', { workspaceRoot: '/selected/worktree', commandId: 'caller-stale-id' });
            await msp.command('turn/start', { sessionId: 'native-session', input: [{ type: 'text', text: 'replay only' }] },
                { onCommandId: commandId => { admitted.push(commandId); } });
            await completed;
            const observation = await msp.client.request('fixture/inspect');
            expect(observation).toMatchObject({ commands: [expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
                expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)] });
            if (observation && typeof observation === 'object' && !Array.isArray(observation) && 'commands' in observation) {
                const commands = observation.commands;
                expect(Array.isArray(commands) && new Set(commands).size).toBe(2);
                if (Array.isArray(commands) && commands.every((id): id is string => typeof id === 'string')) {
                    const times = commands.map(id => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16));
                    expect(times[0]).toBeGreaterThanOrEqual(beforeCommands);
                    expect(times[1]).toBeGreaterThanOrEqual(times[0]!);
                    expect(times[1]).toBeLessThanOrEqual(Date.now());
                    expect(admitted).toEqual([commands[1]]);
                }
            }
            expect(messages[0]?.method).toBe('fixture/startup');
            expect(admissionsAtNativeStart).toEqual([admitted]);
            expect(messages.filter(message => message.method === 'turn/completed')).toHaveLength(1);
            expect(messages.some(message => message.method === 'item/delta')).toBe(true);
        } finally { receipt.dispose(); await msp.dispose(); }
    });

    it('returns a presentation receipt for native server requests without sending a decision', async () => {
        const occurrences: Array<JsonValue | undefined> = [];
        const msp = await openMuseMsp({ ...await fixture(), onRequest: {
            'approval/request': request => { occurrences.push(request.params); return {}; },
        } });
        try {
            await msp.client.request('fixture/approval');
            expect(occurrences).toEqual([{ approvalId: 'approval-1' }]);
            expect(await msp.client.request('fixture/inspect')).toMatchObject({
                receipts: [{ jsonrpc: '2.0', id: 'native-approval', result: {} }],
                commands: [],
                requests: ['initialize', 'initialized', 'fixture/approval', 'fixture/inspect'],
            });
        } finally { await msp.dispose(); }
    });

    it('preserves native application refusals and aborts only the requested RPC', async () => {
        const msp = await openMuseMsp(await fixture());
        try {
            await expect(msp.client.request('fixture/refuse')).rejects.toMatchObject({
                code: -32602, data: { field: 'input' },
            });
            const cancellation = new AbortController();
            const parked = msp.client.request('fixture/park', {}, { signal: cancellation.signal });
            cancellation.abort();
            await expect(parked).rejects.toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_ABORTED' });
            expect(await msp.client.request('fixture/inspect')).toMatchObject({ initialized: true });
        } finally { await msp.dispose(); }
    });

    it('closes stdin and observes drained native completion when disposed', async () => {
        const messages: string[] = [];
        const msp = await openMuseMsp({ ...await fixture(), onNotification: message => { messages.push(message.method); } });
        await msp.dispose();
        expect(messages).toContain('session/closed');
        expect(await msp.wait()).toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        });
    });
});
