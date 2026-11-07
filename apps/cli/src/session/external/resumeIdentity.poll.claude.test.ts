import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { HostTerminalTranscriptFollowAdmissionError } from '@/agent/runtime/session/terminal/contract';
import { createClaudeAgentSdkResumeIdentityOwner } from '../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/resumeIdentity';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

it('acknowledges a refused promotion through real file polling and retries once for new evidence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const root = await mkdtemp(join(tmpdir(), 'follow-refusal-'));
    const path = join(root, 'native.jsonl');
    await writeFile(path, '');
    let attempts = 0;
    const lifetime = new AbortController();
    const source = createHostTerminalTranscriptFollowService({ signal: lifetime.signal,
        loadCommittedLocalIdBaseline: async () => ({ localIds: new Set<string>(), complete: true }),
        // Daemon transport boundary: a deterministic source admission refusal.
        followProviderSession: async () => { attempts++; return { status: 'unavailable', code: 'plugin_external_follow_unavailable' }; },
        publish: async () => {},
    });
    const fileFollow = createPluginTranscriptFileFollowService({ allowedPaths: [path] });
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
        { transcripts: { append: async () => {}, defineSource: async () => ({ id: 'unused', dispose: async () => {} }), fileFollow } });
    const warnings = vi.spyOn(ctx.logger, 'warn');
    const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx, onProviderSessionId: () => {},
        onTranscriptPromoted: async ({ providerSessionId }) => {
            const result = await source.bindProviderSession({ agentId: 'claude', providerSessionId });
            if (result.status === 'unavailable') throw new HostTerminalTranscriptFollowAdmissionError(result.code, 'bind');
        },
    });
    const row = (uuid: string) => JSON.stringify({ type: 'user', uuid, sessionId: 'native', message: { role: 'user', content: 'hello' } }) + '\n';
    // Timer callbacks start real asynchronous filesystem drains. Settle the active drain
    // between ticks; advancing fake time alone cannot wait for an OS read completion.
    const errors: unknown[] = [];
    const settle = async () => { await owner.settleCurrentCandidate().catch(error => { errors.push(error); }); };
    const tick = async () => { await vi.advanceTimersByTimeAsync(1_000); await settle(); };
    try {
        await owner.observeSessionHook('native', { hook_event_name: 'SessionStart', session_id: 'native', transcript_path: path });
        owner.recordSubmittedPrompt('hello');
        await owner.observeSessionHook('native', { hook_event_name: 'UserPromptSubmit', session_id: 'native', prompt: 'hello' });
        await appendFile(path, row('first'));
        // A refused admission must not become a proof-read failure or fail settlement.
        await settle();
        for (let index = 0; index < 180; index++) await tick();
        expect(attempts).toBe(1);
        expect(errors).toEqual([]);
        await appendFile(path, row('new-evidence'));
        await owner.settleCurrentCandidate();
        expect(attempts).toBe(2);
        expect(warnings.mock.calls.filter(([message]) => message === '[ClaudeAgentSdk] transcript identity promotion refused')).toHaveLength(1);
        await owner.observeSessionHook('native', { hook_event_name: 'SessionStart', session_id: 'native', transcript_path: path });
        expect(attempts).toBe(3);
        owner.recordSubmittedPrompt('hello');
        await owner.observeSessionHook('native', { hook_event_name: 'UserPromptSubmit', session_id: 'native', prompt: 'hello' });
        expect(attempts).toBe(4);
        for (let index = 0; index < 10; index++) await tick();
        expect(attempts).toBe(4);
    } finally {
        await owner.dispose();
        lifetime.abort();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
    }
});
