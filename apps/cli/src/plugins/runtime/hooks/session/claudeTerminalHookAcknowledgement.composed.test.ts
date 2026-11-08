import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionHooksService } from './service';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

it.each(['lifecycle', 'dispose_rekey'] as const)('acknowledges terminal hooks independently of a pending source (%s)', async scenario => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-hook-ack-'));
    const sessionId = 'hook-ack-session';
    const providerSessionId = 'hook-ack-native';
    const transcriptPath = join(directory, 'native.jsonl');
    const lifetime = new AbortController();
    const sourceEntered = createDeferred();
    const releaseSource = createDeferred();
    const sourceIdentities: string[] = [];
    const grants = createTranscriptFileFollowPathGrantRegistry();
    const fileFollow = createPluginTranscriptFileFollowService({ pluginId: 'happier.agent.claude',
        runtimeId: sessionId, readSessionId: () => sessionId, fileFollowPathGrants: grants });
    const disposables: Array<{ dispose(): void | Promise<void> }> = [];
    const hooks = createSessionHooksService({ happyHomeDir: directory,
        hasCapability: capability => capability === 'sessionHooks',
        addDisposable: disposable => { disposables.push(disposable); },
        grantTranscriptFileFollowPath: request => grants.grant({ pluginId: 'happier.agent.claude',
            runtimeId: sessionId, scope: { kind: 'session', sessionId }, path: request.transcriptPath,
            reason: 'providerTranscriptSource', evidence: request.evidence }),
    });
    const follow = createHostTerminalTranscriptFollowService({ signal: lifetime.signal,
        loadCommittedLocalIdBaseline: async () => ({ complete: true, localIds: new Set<string>() }),
        // Hold the external source transport, keeping the real admission and replay owner.
        followProviderSession: async (request, listener) => {
            sourceIdentities.push(request.providerSessionId);
            sourceEntered.resolve();
            await releaseSource.promise;
            await listener({ kind: 'data', phase: 'initial_replay', items: [], fromCursor: null, nextCursor: 'tail' });
            return { status: 'following', startingCursor: 'tail', subscription: { dispose: async () => {} } };
        }, publish: async () => {},
    });
    const base = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service);
    const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
        sessionHooks: hooks, transcripts: { ...base.agentRuntime.transcripts, fileFollow,
            followSource: async request => {
                const result = await follow.bindProviderSession({ agentId: 'claude', ...request });
                if (result.status !== 'following') throw new Error(result.code);
                return result.binding;
            },
        },
    });
    const operations = createClaudeAgentSdkTurnOperations({ ctx, directory, launchEnv: {},
        happierSessionId: sessionId, permissionMode: 'default', enableSessionResumability: true,
        enableSessionWorkState: true });
    const pending: Array<Promise<number | null>> = [];
    try {
        const presentation = await operations.prepareTerminalPresentation();
        await operations.observeTerminalExecution({ kind: 'started', plan: presentation.plan });
        const pluginDir = presentation.plan.argv[presentation.plan.argv.indexOf('--plugin-dir') + 1]!;
        const config = JSON.parse(await readFile(join(pluginDir, 'hooks/hooks.json'), 'utf8')) as {
            hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        };
        const forward = (event: string, extra: Record<string, unknown> = {}) => {
            const command = config.hooks[event]?.[0]?.hooks[0]?.command;
            if (!command) throw new Error(`Missing ${event} command`);
            const exited = new Promise<number | null>((resolve, reject) => {
                // Execute the actual generated native command at the process boundary.
                const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'pipe'] });
                child.on('error', reject);
                child.on('close', resolve);
                child.stdin.on('error', () => {});
                child.stdin.end(JSON.stringify({ session_id: providerSessionId, transcript_path: transcriptPath,
                    hook_event_name: event, ...extra }));
            });
            pending.push(exited);
            return exited;
        };
        expect(await forward('SessionStart', { source: 'startup' })).toBe(0);
        expect(await forward('UserPromptSubmit', { prompt: 'first input' })).toBe(0);
        await appendFile(transcriptPath, JSON.stringify({ type: 'user', sessionId: providerSessionId,
            message: { role: 'user', content: 'first input' } }) + '\n');
        await sourceEntered.promise;
        if (scenario === 'dispose_rekey') {
            expect(await forward('SessionStart', { source: 'resume', session_id: 'replacement-native' })).toBe(0);
            const disposal = operations.disposeProviderSession();
            releaseSource.resolve();
            await disposal;
            expect(sourceIdentities).toEqual([providerSessionId]);
            return;
        }
        // A person can submit again while follow admission is still in progress.
        const events = ['UserPromptSubmit', ...Object.keys(config.hooks).filter(event => event !== 'UserPromptSubmit' && event !== 'SessionEnd'), 'SessionEnd'];
        for (const event of events) {
            let acknowledged = false;
            const result = forward(event, { source: 'startup', prompt: 'next input' }).then(code => {
                acknowledged = true;
                return code;
            });
            await vi.waitFor(() => expect(acknowledged, `${event} waits for transcript follow`).toBe(true));
            expect(await result).toBe(0);
        }
    } finally {
        releaseSource.resolve();
        await Promise.allSettled(pending);
        lifetime.abort();
        await operations.disposeProviderSession();
        await Promise.all(disposables.map(disposable => disposable.dispose()));
        await rm(directory, { recursive: true, force: true });
    }
});
