import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createProviderPromptAcceptanceSettlement } from '@/agent/runtime/prompt/createProviderPromptAcceptanceSettlement';
import type { ReplaySeedV1 } from '@/agent/runtime/replaySeed/replaySeedV1';
import { resolveClaudeQueuedPromptForDispatch } from '../runtime/resolveClaudeQueuedPromptForDispatch';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { startAnthropicSseBoundary } from '../sdk/anthropicSseBoundary.testkit';
import { createDeferred } from '@/testkit/async/deferred';
import { claudeRemote } from '../claudeRemote';

describe('Claude Agent SDK replay handoff recovery', () => {
    it.runIf(Boolean(process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH)).each(['agentSdk', 'legacy'] as const)('retires a handoff from native acknowledgment and preserves its context in the native transcript (%s)', async (runtime) => {
        const nativePath = process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH!;
        const root = await mkdtemp(join(tmpdir(), 'happier-native-handoff-'));
        const configDir = join(root, 'claude');
        const projectDir = join(root, 'project');
        await mkdir(configDir);
        await mkdir(projectDir);
        const hookSettingsPath = join(root, 'hooks.json');
        await writeFile(hookSettingsPath, '{}');
        const boundary = await startAnthropicSseBoundary();
        const finished = createDeferred<void>();
        const emitted: unknown[] = [];
        const seedText = 'Invented handoff: test colour violet; test number 73.';
        let metadata: { replaySeedV1: ReplaySeedV1 } = {
            replaySeedV1: { v: 1, seedText, sourceSessionId: 'synthetic-source', sourceCutoffSeqInclusive: 3, createdAtMs: 1 },
        };
        const resolution = await resolveClaudeQueuedPromptForDispatch({
            sessionClient: {
                getMetadataSnapshot: () => metadata,
                updateMetadata: updater => { metadata = updater(metadata); },
            },
            batch: { message: 'continue', mode: { localId: 'native-handoff' } }, didBootstrap: false,
        });
        const retirement = createProviderPromptAcceptanceSettlement();
        retirement.register('native-handoff', resolution.settleReplaySeedOnProviderAcceptance);
        const accepted = vi.fn(({ userMessageLocalIds }: { userMessageLocalIds: readonly string[] }) => {
            retirement.confirmProviderAccepted(userMessageLocalIds);
        });
        try {
            vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
            vi.stubEnv('HAPPIER_CLAUDE_PATH', nativePath);
            vi.stubEnv('ANTHROPIC_BASE_URL', boundary.url);
            vi.stubEnv('ANTHROPIC_API_KEY', 'local-test-key');
            vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
            vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
            vi.stubEnv('CLAUDECODE', undefined);
            vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
            let sent = false;
            const options = {
                sessionId: null, transcriptPath: null, path: projectDir, claudeExecutablePath: nativePath,
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
                nextMessage: async () => {
                    if (sent) { await finished.promise; return null; }
                    sent = true;
                    return {
                        message: resolution.message, userMessageLocalIds: ['native-handoff'],
                        mode: makeMode({ claudeRemoteSettingSourcesV2: [], claudeRemoteAgentSdkEnabled: true }),
                    };
                },
                onReady: () => { finished.resolve(); }, onSessionFound() {},
                onMessage: message => { emitted.push(message); },
                onPromptAcceptedByProvider: accepted,
            } satisfies Parameters<typeof claudeRemoteAgentSdk>[0];
            if (runtime === 'agentSdk') await claudeRemoteAgentSdk(options);
            else await claudeRemote({ ...options, hookSettingsPath });
            await retirement.drain();
            expect(accepted).toHaveBeenCalledExactlyOnceWith({ maxUserMessageSeq: null, userMessageLocalIds: ['native-handoff'] });
            expect(metadata.replaySeedV1).toMatchObject({ seedText: '', appliedToLocalId: 'native-handoff' });
            expect(emitted.some(message => (message as { type?: unknown }).type === 'user')).toBe(false);
            const paths = await readdir(join(configDir, 'projects'), { recursive: true });
            const transcripts = await Promise.all(paths.filter(path => path.endsWith('.jsonl'))
                .map(path => readFile(join(configDir, 'projects', path), 'utf8')));
            expect(transcripts.some(text => text.includes(seedText))).toBe(true);
        } finally {
            finished.resolve();
            vi.unstubAllEnvs();
            await boundary.close();
            await rm(root, { recursive: true, force: true });
        }
    });

    it.each([false, true])('retains the handoff after startup fails without provider acknowledgment (SDK read input: %s)', async (readInput) => {
        let metadata: { replaySeedV1: ReplaySeedV1 } = {
            replaySeedV1: {
                v: 1, seedText: 'Test colour: violet. Test number: 73.',
                sourceSessionId: 'synthetic-source', sourceCutoffSeqInclusive: 3, createdAtMs: 1,
            },
        };
        const sessionClient = {
            getMetadataSnapshot: () => metadata,
            updateMetadata: (updater: (current: typeof metadata) => typeof metadata) => { metadata = updater(metadata); },
        };
        const mode = makeMode({ localId: 'handoff-local', claudeRemoteAgentSdkEnabled: true });
        const dispatch = () => resolveClaudeQueuedPromptForDispatch({
            sessionClient, batch: { message: 'continue', mode }, didBootstrap: false,
        });
        const first = await dispatch();
        const retirement = createProviderPromptAcceptanceSettlement();
        retirement.register(mode.localId!, first.settleReplaySeedOnProviderAcceptance);
        const onAccepted = vi.fn(({ userMessageLocalIds }: { userMessageLocalIds: readonly string[] }) => {
            retirement.confirmProviderAccepted(userMessageLocalIds);
        });
        let sent = false;
        await expect(claudeRemoteAgentSdk({
            sessionId: null, transcriptPath: null, path: '/tmp', claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
            nextMessage: async () => {
                if (sent) return null;
                sent = true;
                return { message: first.message, mode, userMessageLocalIds: [mode.localId!] };
            },
            onReady() {}, onSessionFound() {}, onMessage() {},
            onPromptAcceptedByProvider: onAccepted,
            // The external SDK/process is the boundary. Prompt composition, correlation and metadata retirement stay real.
            createQuery: ({ prompt }) => ({
                async *[Symbol.asyncIterator]() {
                    if (readInput) await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
                    throw new Error('synthetic startup failure');
                },
                close() {},
            } as unknown as Query),
        })).rejects.toThrow('synthetic startup failure');
        await retirement.drain();

        expect(onAccepted).not.toHaveBeenCalled();
        expect(metadata.replaySeedV1.seedText).toBe('Test colour: violet. Test number: 73.');
        expect(metadata.replaySeedV1.appliedToLocalId).toBeUndefined();
        // A fresh dispatcher reads persisted metadata, as a replacement target runner does.
        expect((await dispatch()).message).toBe(first.message);
    });
});
