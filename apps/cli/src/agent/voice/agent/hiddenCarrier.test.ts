import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createHiddenCarrierAgentFixture } from './hiddenCarrier.testkit';

it('retains genuine native input/reply bytes across resume and reads them through its public transcript source', async () => {
  await withTempDir('voice-native-store-', async directory => {
    const nativeStorePath = join(directory, 'conversation.json');
    const userText = 'VOICE_HIDDEN_FIRST_INPUT';
    const fixture = createHiddenCarrierAgentFixture(userText, { nativeStorePath });
    const modulePath = join(directory, 'agent.mjs');
    await writeFile(modulePath, fixture.files['agent.mjs']);
    // This generated JS module is the authored external plugin boundary.
    const module: { externalSessions: AgentExternalSessionsContribution } = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    const run = (kind: 'create' | 'resume', inputId: string, text = userText) => spawnSync(fixture.nativeProgram.executable,
      [...fixture.nativeProgram.args, JSON.stringify({ kind, providerSessionId: 'voice-canary-native-conversation', openId: `open-${kind}` }),
        JSON.stringify([inputId]), `User: ${text}\nVoice agent:`], { encoding: 'utf8' });
    const first = run('create', 'first-input');
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ nativeHistoryTurns: 0, answer: expect.stringMatching(/^git version /) });
    const beforeRejected = await readFile(nativeStorePath, 'utf8');
    expect(run('resume', 'rejected-input', 'changed input').status).not.toBe(0);
    expect(await readFile(nativeStorePath, 'utf8')).toBe(beforeRejected);
    const second = run('resume', 'second-input');
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ nativeHistoryTurns: 1, nativeOpen: { kind: 'resume' } });
    // This source needs no network/Exec adapter. Fail closed if it starts
    // reaching one, rather than supplying a scripted process or transcript.
    const unavailable = () => { throw new Error('Unexpected external adapter use'); };
    const invocation: AgentExternalSessionsInvocation = {
      signal: new AbortController().signal, managedEndpointRead: async () => unavailable(), ripgrep: { run: async () => unavailable() },
      // The untyped JS leaf receives a deliberately unavailable external boundary.
      exec: new Proxy({} as AgentExternalSessionsInvocation['exec'], { get: unavailable }),
    };
    const page = await module.externalSessions.pageTranscript({ ...invocation, source: { kind: 'voiceCanaryNativeStore' },
      remoteSessionId: 'voice-canary-native-conversation', direction: 'older', maxItems: 4,
      maxSerializedBytes: Buffer.byteLength(await readFile(nativeStorePath, 'utf8')) * 2 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error('Native transcript source refused its own conversation');
    expect(page.value.items).toHaveLength(4);
    expect(page.value.items[0]?.raw).toMatchObject({ role: 'user', content: { text: `User: ${userText}\nVoice agent:` } });
    expect(page.value.items[1]?.raw).toMatchObject({ role: 'agent', content: { data: { message: first.stdout } } });
    expect(page.value.items[3]?.raw).toMatchObject({ role: 'agent', content: { data: { message: second.stdout } } });
    const after = await module.externalSessions.readAfterTranscript({ ...invocation, source: { kind: 'voiceCanaryNativeStore' },
      remoteSessionId: 'voice-canary-native-conversation', cursor: '2', maxItems: 2,
      maxSerializedBytes: Buffer.byteLength(await readFile(nativeStorePath, 'utf8')) * 2 });
    expect(after).toMatchObject({ ok: true, value: { outcome: 'advanced', nextCursor: '4', hasMore: false,
      items: [expect.objectContaining({ localId: 'second-input' }), expect.objectContaining({ messageRole: 'agent' })] } });
    const stored: { opens: { kind: string }[]; turns: unknown[] } = JSON.parse(await readFile(nativeStorePath, 'utf8'));
    expect(stored.opens.map(open => open.kind)).toEqual(['create', 'resume']);
    expect(stored.turns).toHaveLength(2);
  });
});
