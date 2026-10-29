import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';

import { observeClaudeSdkProcess } from './observeClaudeSdkProcess';

// The supported Agent SDK process transport is the boundary; framing stays real.
class ProviderProcess extends EventEmitter implements SpawnedProcess {
    stdin = new PassThrough();
    stdout = new PassThrough();
    killed = false;
    exitCode: number | null = null;
    kill() { this.killed = true; return true; }
}

it('preserves stdout bytes and complete native frames across chunked UTF8, malformed lines and observer failure', async () => {
    const child = new ProviderProcess();
    const messages: unknown[] = [];
    const observation = observeClaudeSdkProcess(child, message => {
        messages.push(message);
        if (messages.length === 1) throw new Error('observer unavailable');
    });
    const received: Buffer[] = [];
    const drain = (async () => {
        for await (const chunk of observation.process.stdout) received.push(Buffer.from(chunk));
    })();
    const bytes = Buffer.from('not-json\n{"session_id":"native-é","type":"assistant"}\r\n{"type":"result"}');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    child.stdout.write(bytes.subarray(0, split));
    expect(messages).toEqual([]);
    child.stdout.write(bytes.subarray(split, split + 1));
    child.stdout.end(bytes.subarray(split + 1));
    await drain;
    expect(Buffer.concat(received)).toEqual(bytes);
    expect(messages).toEqual([{ session_id: 'native-é', type: 'assistant' }, { type: 'result' }]);
    observation.process.kill('SIGTERM');
    expect(child.killed).toBe(true);
    expect(observation.process.killed).toBe(true);
    child.exitCode = 7;
    expect(observation.process.exitCode).toBe(7);
    observation.dispose();
});

it('forwards source stream failure and releases observation listeners during disposal', async () => {
    const child = new ProviderProcess();
    const observation = observeClaudeSdkProcess(child, () => {});
    const error = new Error('provider output failed');
    const failure = once(observation.process.stdout, 'error');
    child.stdout.destroy(error);
    expect(await failure).toEqual([error]);
    observation.dispose();
    expect(child.stdout.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('close')).toBe(0);
});
