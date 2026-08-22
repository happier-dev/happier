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

describe('createClaudeAgentSdkResumeIdentityOwner', () => {
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
            nowMs: () => 10_000,
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
});
