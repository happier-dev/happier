import type {
    AgentTranscriptFileFollowInput as TranscriptFileFollowInputV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
    createEventsFixture,
    createPluginContextFixture,
    createTerminalHostFixture,
} from '../../engine.testkit.js';
import { createClaudeAgentSdkResumeIdentityOwner } from './resumeIdentity.js';
import { createDeferred } from '../../../../../../../../apps/cli/src/testkit/async/deferred.js';

describe('createClaudeAgentSdkResumeIdentityOwner', () => {
    it.each([false, true])('leaves transient promotion failures eligible for JSONL redelivery (typed: %s)', async typed => {
        let follow: TranscriptFileFollowInputV1 | undefined;
        const transient = Object.assign(new Error('temporary transport failure'), typed ? {
            code: 'native_agent_terminal_transcript_follow_admission_failed',
            phase: 'bind', followCode: 'plugin_external_follow_unavailable', retryable: true,
        } : { code: 'EIO' });
        let attempts = 0;
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: async () => {}, defineSource: async () => ({ id: 'unused', dispose: async () => {} }),
                fileFollow: { follow: async input => { follow = input; return { id: 'proof', close: async () => {}, drainNow: async () => {} }; } },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx, onProviderSessionId: () => {},
            onTranscriptPromoted: async () => { if (++attempts === 1) throw transient; },
        });
        try {
            await owner.observeSessionHook('native', { hook_event_name: 'SessionStart', session_id: 'native', transcript_path: '/tmp/native.jsonl' });
            await owner.observeSessionHook('native', { hook_event_name: 'UserPromptSubmit', session_id: 'native', prompt: 'hello' }, 'local_terminal');
            if (!follow) throw new Error('Missing transcript follower');
            const row = { line: JSON.stringify({ type: 'user', sessionId: 'native', message: { role: 'user', content: 'hello' } }), sourcePath: follow.path, sequence: 1 };
            await expect(follow.onLine(row)).rejects.toBe(transient);
            await expect(follow.onLine(row)).resolves.toBeUndefined();
            expect(attempts).toBe(2);
        } finally { await owner.dispose(); }
    });

    it.each(['acquire', 'onError', 'drain', 'healthy'] as const)('settles the replacement candidate after a retired drain completes (%s)', async phase => {
        const follows: TranscriptFileFollowInputV1[] = [];
        const drains: string[] = [];
        const denied = Object.assign(new Error('Current candidate access denied'), { code: 'EACCES' });
        const stale = Object.assign(new Error('Retired candidate access denied'), { code: 'EACCES' });
        const pendingDrain = createDeferred();
        const drainEntered = createDeferred();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                    follows.push(input);
                    const previous = input.path.endsWith('/previous.jsonl');
                    if (!previous && phase === 'acquire') throw denied;
                    return { id: input.path, close: async () => {}, drainNow: async () => {
                        drains.push(input.path);
                        if (previous) { drainEntered.resolve(); await pendingDrain.promise; throw stale; }
                        if (phase === 'drain') throw denied;
                    } };
                }) },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx, onProviderSessionId: () => {}, onTranscriptPromoted: async () => {} });
        const start = (id: string) => owner.observeSessionHook(id, { hook_event_name: 'SessionStart', session_id: id,
            transcript_path: `/tmp/${id}.jsonl` }, 'local_terminal');
        try {
            await start('previous');
            const settlement = owner.settleCurrentCandidate();
            const result = phase === 'healthy' ? expect(settlement).resolves.toBeUndefined() : expect(settlement).rejects.toBe(denied);
            await drainEntered.promise;
            await start('current');
            await owner.observeSessionHook('current', { hook_event_name: 'UserPromptSubmit', session_id: 'current', prompt: 'Local context' }, 'local_terminal');
            if (phase === 'onError') await follows[1]?.onError?.(denied);
            pendingDrain.resolve();
            await result;
            expect(drains).toEqual(phase === 'acquire' ? ['/tmp/previous.jsonl'] : ['/tmp/previous.jsonl', '/tmp/current.jsonl']);
        } finally { pendingDrain.resolve(); await owner.dispose(); }
    });

    it('retains unexpected proof read failures until matched proof or candidate retirement', async () => {
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: string[] = [];
        const denied = Object.assign(new Error('Proof access denied'), { code: 'EACCES' });
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                    follows.push(input);
                    return { id: 'proof-follow', drainNow: async () => {}, close: async () => {} };
                }) },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx,
            onProviderSessionId: () => {}, onTranscriptPromoted: async promotion => { promotions.push(promotion.providerSessionId); } });
        const start = (id: string) => owner.observeSessionHook(id, { hook_event_name: 'SessionStart',
            session_id: id, transcript_path: `/tmp/${id}.jsonl` }, 'local_terminal');
        try {
            await start('first');
            const first = follows[0];
            if (!first) throw new Error('Missing transcript follow');
            for (const code of ['ENOENT', 'ENOTDIR']) {
                await first.onError?.(Object.assign(new Error('Transcript not present'), { code }));
                await expect(owner.settleCurrentCandidate()).resolves.toBeUndefined();
            }
            await first.onError?.(denied);
            await expect(owner.settleCurrentCandidate()).rejects.toBe(denied);
            await expect(owner.settleCurrentCandidate()).rejects.toBe(denied);
            await start('current');
            await first.onError?.(denied);
            await expect(owner.settleCurrentCandidate()).resolves.toBeUndefined();
            const current = follows[1];
            if (!current) throw new Error('Missing current transcript follow');
            await owner.observeSessionHook('current', { hook_event_name: 'UserPromptSubmit', session_id: 'current',
                prompt: 'Local context' }, 'local_terminal');
            await current.onError?.(denied);
            await expect(owner.settleCurrentCandidate()).rejects.toBe(denied);
            await current.onLine({ line: JSON.stringify({ type: 'user', sessionId: 'current',
                timestamp: new Date(10_000).toISOString(), message: { role: 'user', content: 'Local context' } }),
                sourcePath: current.path, sequence: 1 });
            await expect(owner.settleCurrentCandidate()).resolves.toBeUndefined();
            await current.onError?.(denied);
            await expect(owner.settleCurrentCandidate()).resolves.toBeUndefined();
            expect(promotions).toEqual(['current']);
        } finally { await owner.dispose(); }
    });

    it.each([
        { origin: 'sdk' as const, hookSessionId: 'native-current', sidechain: false, expectedPromotions: [] },
        { origin: 'local_terminal' as const, hookSessionId: 'native-current', sidechain: false, expectedPromotions: ['native-current'] },
        { origin: 'local_terminal' as const, hookSessionId: 'native-other', sidechain: false, expectedPromotions: [] },
        { origin: 'local_terminal' as const, hookSessionId: 'native-current', sidechain: true, expectedPromotions: [] },
    ])('admits unsubmitted $origin prompt proof only for the primary candidate ($hookSessionId, sidechain=$sidechain)', async ({ origin, hookSessionId, sidechain, expectedPromotions }) => {
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: string[] = [];
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                    follows.push(input);
                    return { id: 'native-file', drainNow: async () => {}, close: async () => {} };
                }) },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx,
            onProviderSessionId: () => {},
            onTranscriptPromoted: async promotion => { promotions.push(promotion.providerSessionId); },
        });
        try {
            await owner.observeSessionHook('native-current', { hook_event_name: 'SessionStart',
                session_id: 'native-current', transcript_path: '/tmp/native-current.jsonl' }, origin);
            const payload = { hook_event_name: 'UserPromptSubmit', session_id: hookSessionId,
                prompt: 'Locally typed context', ...(sidechain ? { agent_id: 'child-agent' } : {}) };
            await owner.observeSessionHook(hookSessionId, payload, origin);
            expect(promotions).toEqual([]);
            const follow = follows[0];
            if (!follow) throw new Error('Missing authenticated transcript follow');
            const row = { line: JSON.stringify({ type: 'user', sessionId: 'native-current',
                timestamp: new Date(10_000).toISOString(),
                message: { role: 'user', content: 'Locally typed context' } }),
                sourcePath: follow.path, sequence: 1 };
            await follow.onLine(row);
            await owner.observeSessionHook(hookSessionId, payload, origin);
            await follow.onLine(row);
            expect(promotions).toEqual(expectedPromotions);
            expect(follows).toHaveLength(1);
        } finally { await owner.dispose(); }
    });

    it('does not promote an accepted hook that precedes its authenticated transcript candidate', async () => {
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: string[] = [];
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                    follows.push(input);
                    return { id: 'native-file', drainNow: async () => {}, close: async () => {} };
                }) },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx,
            onProviderSessionId: () => {},
            onTranscriptPromoted: async promotion => { promotions.push(promotion.providerSessionId); },
        });
        try {
            owner.recordSubmittedPrompt('Host-owned context\nReply ready.');
            // Native transport owns ordering; an unbound hook is not authority for a future candidate.
            await owner.observeSessionHook('native-current', { hook_event_name: 'UserPromptSubmit',
                session_id: 'native-current', prompt: 'Host-owned context\nReply ready.' });
            expect(promotions).toEqual([]);
            await owner.observeSessionHook('native-current', { hook_event_name: 'SessionStart',
                session_id: 'native-current', transcript_path: '/tmp/native-current.jsonl' });
            const follow = follows[0];
            if (!follow) throw new Error('Missing authenticated transcript follow');
            await follow.onLine({ line: JSON.stringify({ type: 'user', sessionId: 'native-current',
                timestamp: new Date(10_000).toISOString(),
                message: { role: 'user', content: 'Host-owned context\nReply ready.' } }),
                sourcePath: follow.path, sequence: 1 });
            expect(promotions).toEqual([]);
        } finally { await owner.dispose(); }
    });

    it('does not reuse accepted-prompt proof across transcript candidate generations', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        return {
                            id: `follow-${follows.length}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => undefined),
                        };
                    }),
                },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });

        try {
            owner.recordSubmittedPrompt('same prompt');
            await owner.observeSessionHook('same-session', {
                hook_event_name: 'SessionStart',
                session_id: 'same-session',
                transcript_path: '/tmp/first.jsonl',
            });
            await owner.observeSessionHook('same-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'same-session',
                prompt: 'same prompt',
            });
            await owner.observeSessionHook('same-session', {
                hook_event_name: 'SessionStart',
                source: 'compact',
                session_id: 'same-session',
                transcript_path: '/tmp/second.jsonl',
            });

            const secondFollow = follows[1];
            if (!secondFollow) throw new Error('missing rotated transcript follow');
            await secondFollow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'replayed-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'same-session',
                    message: { role: 'user', content: 'same prompt' },
                }),
                sourcePath: secondFollow.path,
                sequence: 1,
            });

            expect(promotions).toEqual([]);
        } finally {
            await owner.dispose();
        }
    });

    it('allows a repeatedly reset transcript tuple to establish a fresh proof generation', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        return {
                            id: `follow-${follows.length}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => undefined),
                        };
                    }),
                },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });
        const sessionStart = {
            hook_event_name: 'SessionStart',
            session_id: 'same-session',
            transcript_path: '/tmp/same.jsonl',
        } as const;

        try {
            await owner.observeSessionHook('same-session', sessionStart);
            await follows[0]?.onReset?.({ reason: 'truncated' });
            await owner.observeSessionHook('same-session', sessionStart);
            await follows[1]?.onReset?.({ reason: 'replaced' });
            await owner.observeSessionHook('same-session', sessionStart);

            owner.recordSubmittedPrompt('fresh prompt');
            await owner.observeSessionHook('same-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'same-session',
                prompt: 'fresh prompt',
            });
            const thirdFollow = follows[2];
            if (!thirdFollow) throw new Error('missing third transcript proof generation');
            await thirdFollow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'fresh-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'same-session',
                    message: { role: 'user', content: 'fresh prompt' },
                }),
                sourcePath: thirdFollow.path,
                sequence: 1,
            });

            expect(follows).toHaveLength(3);
            expect(promotions).toEqual([{
                providerSessionId: 'same-session',
                transcriptPath: '/tmp/same.jsonl',
            }]);
        } finally {
            await owner.dispose();
        }
    });

    it('waits for promotion work owned by a retired transcript candidate', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        let releasePromotion: (() => void) | null = null;
        const promotionPending = new Promise<void>((resolve) => {
            releasePromotion = resolve;
        });
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        return {
                            id: `follow-${follows.length}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => undefined),
                        };
                    }),
                },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async () => { await promotionPending; },
        });

        owner.recordSubmittedPrompt('accepted prompt');
        await owner.observeSessionHook('first-session', {
            hook_event_name: 'SessionStart',
            session_id: 'first-session',
            transcript_path: '/tmp/first.jsonl',
        });
        await owner.observeSessionHook('first-session', {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'first-session',
            prompt: 'accepted prompt',
        });
        const firstFollow = follows[0];
        if (!firstFollow) throw new Error('missing first transcript follow');
        const promotion = firstFollow.onLine({
            line: JSON.stringify({
                type: 'user',
                uuid: 'accepted-row',
                timestamp: new Date(10_000).toISOString(),
                sessionId: 'first-session',
                message: { role: 'user', content: 'accepted prompt' },
            }),
            sourcePath: firstFollow.path,
            sequence: 1,
        });
        await owner.observeSessionHook('second-session', {
            hook_event_name: 'SessionStart',
            source: 'compact',
            session_id: 'second-session',
            transcript_path: '/tmp/second.jsonl',
        });

        let disposeSettled = false;
        const dispose = owner.dispose().then(() => { disposeSettled = true; });
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(disposeSettled).toBe(false);

        releasePromotion?.();
        await Promise.all([promotion, dispose]);
    });

    it('invalidates exact-prompt proof when the transcript follower resets', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        return {
                            id: `follow-${follows.length}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => undefined),
                        };
                    }),
                },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });

        try {
            owner.recordSubmittedPrompt('accepted prompt');
            await owner.observeSessionHook('primary-session', {
                hook_event_name: 'SessionStart',
                session_id: 'primary-session',
                transcript_path: '/tmp/primary-session.jsonl',
            });
            await owner.observeSessionHook('primary-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'primary-session',
                prompt: 'accepted prompt',
            });
            const follow = follows[0];
            if (!follow) throw new Error('missing primary transcript follow');
            await follow.onReset?.({ reason: 'truncated' });
            await follow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'historical-replayed-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'primary-session',
                    message: { role: 'user', content: 'accepted prompt' },
                }),
                sourcePath: follow.path,
                sequence: 1,
            });

            expect(promotions).toEqual([]);
        } finally {
            await owner.dispose();
        }
    });

    it('waits for in-flight follower acquisition during disposal', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const close = vi.fn(async () => undefined);
        let releaseAttach: (() => void) | null = null;
        const attachPending = new Promise<void>((resolve) => {
            releaseAttach = resolve;
        });
        const follow = vi.fn(async () => {
            await attachPending;
            return { id: 'follow-dispose-race', drainNow: vi.fn(async () => undefined), close };
        });
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: vi.fn(async () => undefined),
        });

        const sessionStart = owner.observeSessionHook('primary-session', {
            hook_event_name: 'SessionStart',
            session_id: 'primary-session',
            transcript_path: '/tmp/primary-session.jsonl',
        });
        await vi.waitFor(() => expect(follow).toHaveBeenCalledTimes(1));
        let disposeSettled = false;
        const dispose = owner.dispose().then(() => {
            disposeSettled = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(disposeSettled).toBe(false);

        releaseAttach?.();
        await Promise.all([sessionStart, dispose]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not roll back to a retired SessionStart after compact rotation', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        const onProviderSessionId = vi.fn();
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        return {
                            id: `follow-${follows.length}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => undefined),
                        };
                    }),
                },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId,
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });

        try {
            await owner.observeSessionHook('old-session', {
                hook_event_name: 'SessionStart',
                source: 'startup',
                session_id: 'old-session',
                transcript_path: '/tmp/old-session.jsonl',
            });
            owner.recordSubmittedPrompt('new prompt');
            await owner.observeSessionHook('new-session', {
                hook_event_name: 'SessionStart',
                source: 'compact',
                session_id: 'new-session',
                transcript_path: '/tmp/new-session.jsonl',
            });
            await owner.observeSessionHook('old-session', {
                hook_event_name: 'SessionStart',
                source: 'startup',
                session_id: 'old-session',
                transcript_path: '/tmp/old-session.jsonl',
            });
            await owner.observeSessionHook('new-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'new-session',
                prompt: 'new prompt',
            });
            const newFollow = follows[1];
            if (!newFollow) throw new Error('missing compact transcript follow');
            await newFollow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'new-session-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'new-session',
                    message: { role: 'user', content: 'new prompt' },
                }),
                sourcePath: newFollow.path,
                sequence: 1,
            });

            expect(onProviderSessionId.mock.calls.map((call) => call[0])).toEqual(['old-session', 'new-session']);
            expect(promotions).toEqual([expect.objectContaining({
                providerSessionId: 'new-session',
                transcriptPath: '/tmp/new-session.jsonl',
            })]);
        } finally {
            await owner.dispose();
        }
    });

    it('starts at the SessionStart boundary and closes a follower promoted before attachment returns', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        const close = vi.fn(async () => undefined);
        let releaseAttach: (() => void) | null = null;
        const attachPending = new Promise<void>((resolve) => {
            releaseAttach = resolve;
        });
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        await attachPending;
                        return { id: 'follow-racing-attach', drainNow: vi.fn(async () => undefined), close };
                    }),
                },
            },
        });
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });

        try {
            owner.recordSubmittedPrompt('current prompt');
            const sessionStart = owner.observeSessionHook('primary-session', {
                hook_event_name: 'SessionStart',
                session_id: 'primary-session',
                transcript_path: '/tmp/primary-session.jsonl',
            });
            await vi.waitFor(() => expect(follows).toHaveLength(1));
            expect(follows[0]?.startAt).toBe('end');
            await owner.observeSessionHook('primary-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'primary-session',
                prompt: 'current prompt',
            });
            const follow = follows[0];
            if (!follow) throw new Error('missing primary transcript follow');
            await follow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'current-prompt-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'primary-session',
                    message: { role: 'user', content: 'current prompt' },
                }),
                sourcePath: follow.path,
                sequence: 1,
            });
            releaseAttach?.();
            await sessionStart;

            expect(promotions).toEqual([{
                providerSessionId: 'primary-session',
                transcriptPath: '/tmp/primary-session.jsonl',
            }]);
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            releaseAttach?.();
            await owner.dispose();
        }
    });

    it('ignores a pathless SessionStart that attempts to re-key the active primary transcript', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        const onProviderSessionId = vi.fn();
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        return {
                            id: `follow-${follows.length}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => undefined),
                        };
                    }),
                },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId,
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });

        try {
            owner.recordSubmittedPrompt('accepted prompt');
            await owner.observeSessionHook('primary-session', {
                hook_event_name: 'SessionStart',
                session_id: 'primary-session',
                transcript_path: '/tmp/primary-session.jsonl',
            });
            await owner.observeSessionHook('pathless-rekey', {
                hook_event_name: 'SessionStart',
                session_id: 'pathless-rekey',
            });
            await owner.observeSessionHook('primary-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'primary-session',
                prompt: 'accepted prompt',
            });

            const follow = follows[0];
            if (!follow) throw new Error('missing primary transcript follow');
            await follow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'primary-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'primary-session',
                    message: { role: 'user', content: 'accepted prompt' },
                }),
                sourcePath: follow.path,
                sequence: 1,
            });

            expect(onProviderSessionId).toHaveBeenCalledTimes(1);
            expect(onProviderSessionId).toHaveBeenCalledWith('primary-session');
            expect(promotions).toEqual([{
                providerSessionId: 'primary-session',
                transcriptPath: '/tmp/primary-session.jsonl',
            }]);
        } finally {
            await owner.dispose();
        }
    });

    it('retains an authenticated prompt hook that overtakes the old follower close during rotation', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        let releaseOldClose: (() => void) | null = null;
        let markOldCloseStarted: (() => void) | null = null;
        const oldClosePending = new Promise<void>((resolve) => {
            releaseOldClose = resolve;
        });
        const oldCloseStarted = new Promise<void>((resolve) => {
            markOldCloseStarted = resolve;
        });
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        const index = follows.length - 1;
                        return {
                            id: `follow-${index}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => {
                                if (index !== 0) return;
                                markOldCloseStarted?.();
                                await oldClosePending;
                            }),
                        };
                    }),
                },
            },
        });
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });

        try {
            await owner.observeSessionHook('old-session', {
                hook_event_name: 'SessionStart',
                session_id: 'old-session',
                transcript_path: '/tmp/old-session.jsonl',
            });
            owner.recordSubmittedPrompt('new accepted prompt');

            const rotation = owner.observeSessionHook('new-session', {
                hook_event_name: 'SessionStart',
                source: 'compact',
                session_id: 'new-session',
                transcript_path: '/tmp/new-session.jsonl',
            });
            await oldCloseStarted;
            await owner.observeSessionHook('new-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'new-session',
                prompt: 'new accepted prompt',
            });
            releaseOldClose?.();
            await rotation;

            const newFollow = follows[1];
            if (!newFollow) throw new Error('missing rotated transcript follow');
            await newFollow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: 'new-session-row',
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: 'new-session',
                    message: { role: 'user', content: 'new accepted prompt' },
                }),
                sourcePath: newFollow.path,
                sequence: 1,
            });

            expect(promotions).toEqual([{
                providerSessionId: 'new-session',
                transcriptPath: '/tmp/new-session.jsonl',
            }]);
        } finally {
            releaseOldClose?.();
            await owner.dispose();
        }
    });

    it('fences the old transcript before awaiting its close during compact rotation', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const follows: TranscriptFileFollowInputV1[] = [];
        let releaseOldClose: (() => void) | null = null;
        const oldClosePending = new Promise<void>((resolve) => {
            releaseOldClose = resolve;
        });
        const ctx = createPluginContextFixture(terminalHost.service, events.service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: {
                    follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                        follows.push(input);
                        const index = follows.length - 1;
                        return {
                            id: `follow-${index}`,
                            drainNow: vi.fn(async () => undefined),
                            close: vi.fn(async () => {
                                if (index === 0) await oldClosePending;
                            }),
                        };
                    }),
                },
            },
        });
        const promotions: Array<Readonly<{ providerSessionId: string; transcriptPath: string }>> = [];
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async (promotion) => {
                promotions.push({
                    providerSessionId: promotion.providerSessionId,
                    transcriptPath: promotion.transcriptPath,
                });
            },
        });
        const emitExactRow = async (index: number, providerSessionId: string, text: string) => {
            const follow = follows[index];
            if (!follow) throw new Error(`missing transcript follow ${index}`);
            await follow.onLine({
                line: JSON.stringify({
                    type: 'user',
                    uuid: `${providerSessionId}-row`,
                    timestamp: new Date(10_000).toISOString(),
                    sessionId: providerSessionId,
                    message: { role: 'user', content: text },
                }),
                sourcePath: follow.path,
                sequence: 1,
            });
        };

        try {
            owner.recordSubmittedPrompt('old accepted prompt');
            await owner.observeSessionHook('old-session', {
                hook_event_name: 'SessionStart',
                session_id: 'old-session',
                transcript_path: '/tmp/old-session.jsonl',
            });
            await owner.observeSessionHook('old-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'old-session',
                prompt: 'old accepted prompt',
            });

            const rotation = owner.observeSessionHook('new-session', {
                hook_event_name: 'SessionStart',
                source: 'compact',
                session_id: 'new-session',
                transcript_path: '/tmp/new-session.jsonl',
            });
            await vi.waitFor(() => expect(releaseOldClose).not.toBeNull());
            await emitExactRow(0, 'old-session', 'old accepted prompt');

            expect(promotions).toEqual([]);
            releaseOldClose?.();
            await rotation;

            owner.recordSubmittedPrompt('new accepted prompt');
            await owner.observeSessionHook('new-session', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'new-session',
                prompt: 'new accepted prompt',
            });
            await emitExactRow(1, 'new-session', 'new accepted prompt');
            expect(promotions).toEqual([{
                providerSessionId: 'new-session',
                transcriptPath: '/tmp/new-session.jsonl',
            }]);
        } finally {
            releaseOldClose?.();
            await owner.dispose();
        }
    });
    it('treats a trimmed SDK result session id as a resume identity mismatch', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const ctx = createPluginContextFixture(terminalHost.service, events.service);
        // Claude was asked to resume the padded bytes. A result naming the trimmed
        // form is a different conversation, so resume must fail rather than adopt it.
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async () => undefined,
            expectedInitialProviderSessionId: '  provider\nses/AB+cd==  ',
        });

        try {
            expect(owner.validateSdkResultProviderSessionId('provider\nses/AB+cd==')).not.toBeNull();
        } finally {
            await owner.dispose();
        }
    });

    it('accepts the SDK result that echoes the requested provider session id exactly', async () => {
        const terminalHost = createTerminalHostFixture();
        const events = createEventsFixture();
        const ctx = createPluginContextFixture(terminalHost.service, events.service);
        const owner = createClaudeAgentSdkResumeIdentityOwner({
            ctx,
            onProviderSessionId: vi.fn(),
            onTranscriptPromoted: async () => undefined,
            expectedInitialProviderSessionId: '  provider\nses/AB+cd==  ',
        });

        try {
            expect(owner.validateSdkResultProviderSessionId('  provider\nses/AB+cd==  ')).toBeNull();
        } finally {
            await owner.dispose();
        }
    });

    it('promotes an accepted prompt whose native acceptance and transcript row arrive long after submission', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: string[] = [];
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                    follows.push(input);
                    return { id: 'slow-start', drainNow: async () => {}, close: async () => {} };
                }) },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx, onProviderSessionId: () => {},
            onTranscriptPromoted: async promotion => { promotions.push(promotion.providerSessionId); } });
        try {
            vi.setSystemTime(1_000_000);
            owner.recordSubmittedPrompt('First prompt');
            // A slow native start (for example MCP initialisation) delays SessionStart,
            // UserPromptSubmit and the persisted row well past any fixed correlation window.
            vi.setSystemTime(1_000_000 + 10 * 60_000);
            await owner.observeSessionHook('slow', { hook_event_name: 'SessionStart', session_id: 'slow',
                transcript_path: '/tmp/slow.jsonl' });
            await owner.observeSessionHook('slow', { hook_event_name: 'UserPromptSubmit', session_id: 'slow',
                prompt: 'First prompt' });
            vi.setSystemTime(1_000_000 + 20 * 60_000);
            const follow = follows[0];
            if (!follow) throw new Error('Missing transcript follow');
            await follow.onLine({ line: JSON.stringify({ type: 'user', sessionId: 'slow',
                timestamp: new Date(1_000_000 + 20 * 60_000).toISOString(),
                message: { role: 'user', content: 'First prompt' } }), sourcePath: follow.path, sequence: 1 });
            expect(promotions).toEqual(['slow']);
        } finally {
            vi.useRealTimers();
            await owner.dispose();
        }
    });

    it('does not promote a transcript row that no accepted prompt for this candidate produced', async () => {
        const follows: TranscriptFileFollowInputV1[] = [];
        const promotions: string[] = [];
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            transcripts: {
                append: vi.fn(async () => undefined),
                defineSource: vi.fn(async () => ({ id: 'unused', dispose: vi.fn(async () => undefined) })),
                fileFollow: { follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
                    follows.push(input);
                    return { id: `follow-${follows.length}`, drainNow: async () => {}, close: async () => {} };
                }) },
            },
        });
        const owner = createClaudeAgentSdkResumeIdentityOwner({ ctx, onProviderSessionId: () => {},
            onTranscriptPromoted: async promotion => { promotions.push(promotion.providerSessionId); } });
        const row = (text: string) => JSON.stringify({ type: 'user', sessionId: 'native',
            timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
        try {
            owner.recordSubmittedPrompt('Submitted but never accepted');
            await owner.observeSessionHook('native', { hook_event_name: 'SessionStart', session_id: 'native',
                transcript_path: '/tmp/native.jsonl' });
            const follow = follows[0];
            if (!follow) throw new Error('Missing transcript follow');
            await follow.onLine({ line: row('Submitted but never accepted'), sourcePath: follow.path, sequence: 1 });
            await follow.onLine({ line: row('Never submitted'), sourcePath: follow.path, sequence: 2 });
            await owner.observeSessionHook('native', { hook_event_name: 'UserPromptSubmit', session_id: 'native',
                prompt: 'Never submitted' });
            expect(promotions).toEqual([]);
        } finally {
            await owner.dispose();
        }
    });
});
