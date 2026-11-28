import { describe, expect, it } from 'vitest';

import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { createPiAgentRuntime } from './engine.js';
import { hostBoundaries } from './nativeProcess.test-support.js';

describe('Pi Session resume', () => {
  it.each([true, false])('stops and sends again with completed native history: %s', async (completedTurn) => {
    const providerSessionId = '01a221eb-92f1-724c-a468-7d220e4cf02d';
    const request = { sessionId: 'cmx0bw7z800tc63mcrb0tqaq2', cwd: '/workspace' };
    const open = createPiAgentRuntime().sessions.open;
    const firstProcess = hostBoundaries(undefined, { sessionId: providerSessionId, messageCount: 0 });
    const first = await open({ ...request, kind: 'create' }, firstProcess.context);
    const events: AgentSessionRuntimeEvent[] = [];
    const watch = first.watch(event => events.push(event));
    const send = (runtime: typeof first, turnId: string) => runtime.send({
      inputIds: [turnId],
      delivery: { kind: 'newTurn', turnId },
      input: { text: 'Hello' },
    });
    try {
      if (completedTurn) {
        await expect(send(first, 'first')).resolves.toMatchObject({ status: 'admitted' });
        await firstProcess.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hi' },
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        });
        await firstProcess.emit({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });
        await firstProcess.emit({ type: 'agent_end', willRetry: false });
        expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId: 'first' }));
      }
    } finally {
      watch.dispose();
      await first.dispose('user');
    }

    // On Send after Stop the host reopens the same Happier Session. The native
    // open kind comes from the resumable identity published by the first runtime.
    const savedIdentity = events.find(event => event.kind === 'provider-session-id')?.providerSessionId;
    const nextProcess = hostBoundaries(undefined, { sessionId: completedTurn ? providerSessionId : 'fresh-pi-id' });
    const spawn = nextProcess.spawn.getMockImplementation()!;
    nextProcess.spawn.mockImplementation(async spec => {
      if (!completedTurn && spec.launch.args.includes('--session')) {
        throw new Error(`No session found matching '${providerSessionId}'`);
      }
      return spawn(spec);
    });
    const resumed = await open(savedIdentity
      ? { ...request, kind: 'resume', providerSessionId: savedIdentity }
      : { ...request, kind: 'create' }, nextProcess.context);
    try {
      const args = nextProcess.spawn.mock.calls[0]![0].launch.args;
      if (completedTurn) {
        expect(args.slice(args.indexOf('--session'), args.indexOf('--session') + 2))
          .toEqual(['--session', providerSessionId]);
      } else {
        expect(args).not.toContain('--session');
        expect(savedIdentity).toBeUndefined();
      }
      await expect(send(resumed, 'after-stop')).resolves.toMatchObject({ status: 'admitted' });
    } finally {
      await resumed.dispose('user');
    }
  });
});
