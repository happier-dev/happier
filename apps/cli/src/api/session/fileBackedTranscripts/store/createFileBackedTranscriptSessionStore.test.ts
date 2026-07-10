import { describe, expect, it, vi } from 'vitest';

import { createFileBackedTranscriptSessionStore } from './createFileBackedTranscriptSessionStore';
import type { FileBackedTranscriptSessionAdapter } from './fileBackedTranscriptSessionAdapterTypes';

describe('createFileBackedTranscriptSessionStore', () => {
    it('delegates warm, lifecycle, metadata, and transcript operations through one resolved context', async () => {
        const resolveSession = vi.fn(async () => ({
            key: {
                agentId: 'codex' as const,
                source: { kind: 'codexHome' as const, home: 'user' as const },
                remoteSessionId: 'session-1',
            },
            value: { sessionRoot: '/tmp/session-1' },
        }));
        const discoverStreams = vi.fn(async () => ([{
            streamId: 'primary',
            filePath: '/tmp/session-1/rollout.jsonl',
        }]));
        const adapter: FileBackedTranscriptSessionAdapter<string, { running: boolean }, string | null, { sessionRoot: string }, never> = {
            resolveSession,
            discoverStreams,
            warm: vi.fn(async () => {}),
            dispose: vi.fn(async () => {}),
            onLifecycleStateChange: vi.fn(async () => {}),
            probeMetadata: vi.fn(async () => ({
                title: 'Session Title',
                workingDirectory: '/tmp/session-1',
                activity: { running: true },
                preview: 'Preview text',
            })),
            pageOlder: vi.fn(async () => ({
                items: ['older'],
                nextCursor: 'older-next',
                hasMore: true,
                tailCursor: 'tail-cursor',
                truncated: false,
            })),
            readAfter: vi.fn(async () => ({
                items: ['newer'],
                nextCursor: 'after-next',
                truncated: false,
            })),
            subscribe: vi.fn(() => () => {}),
        };

        const store = createFileBackedTranscriptSessionStore({
            key: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'session-1',
            },
            adapter,
        });

        await store.warm();
        await store.setLifecycleState('hot_attached');
        await expect(store.getTitle()).resolves.toBe('Session Title');
        await expect(store.getWorkingDirectory()).resolves.toBe('/tmp/session-1');
        await expect(store.getActivity()).resolves.toEqual({ running: true });
        await expect(store.getPreview()).resolves.toBe('Preview text');
        await expect(store.pageOlder()).resolves.toMatchObject({ items: ['older'], nextCursor: 'older-next' });
        await expect(store.readAfter()).resolves.toMatchObject({ items: ['newer'], nextCursor: 'after-next' });
        const unsubscribe = store.subscribe();
        await new Promise((resolve) => setTimeout(resolve, 0));
        unsubscribe();
        await store.dispose();

        expect(resolveSession).toHaveBeenCalledTimes(1);
        expect(discoverStreams).toHaveBeenCalledTimes(1);
        expect(adapter.warm).toHaveBeenCalledTimes(1);
        expect(adapter.onLifecycleStateChange).toHaveBeenCalledWith(expect.objectContaining({
            resolvedSession: expect.objectContaining({ value: { sessionRoot: '/tmp/session-1' } }),
            streams: expect.arrayContaining([expect.objectContaining({ streamId: 'primary' })]),
        }), 'hot_attached');
        expect(adapter.pageOlder).toHaveBeenCalledTimes(1);
        expect(adapter.readAfter).toHaveBeenCalledTimes(1);
        expect(adapter.subscribe).toHaveBeenCalledTimes(1);
        expect(adapter.dispose).toHaveBeenCalledTimes(1);
    });

    it('retries context resolution after a transient resolve failure', async () => {
        const resolveSession = vi
            .fn()
            .mockRejectedValueOnce(new Error('transient resolve failure'))
            .mockResolvedValue({
                key: {
                    agentId: 'codex' as const,
                    source: { kind: 'codexHome' as const, home: 'user' as const },
                    remoteSessionId: 'session-1',
                },
                value: { sessionRoot: '/tmp/session-1' },
            });
        const adapter: FileBackedTranscriptSessionAdapter<string, { running: boolean }, string | null, { sessionRoot: string }, never> = {
            resolveSession,
            discoverStreams: vi.fn(async () => ([{
                streamId: 'primary',
                filePath: '/tmp/session-1/rollout.jsonl',
            }])),
            probeMetadata: vi.fn(async () => ({
                title: 'Recovered title',
            })),
            pageOlder: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false, tailCursor: null, truncated: false })),
            readAfter: vi.fn(async () => ({ items: [], nextCursor: null, truncated: false })),
        };

        const store = createFileBackedTranscriptSessionStore({
            key: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'session-1',
            },
            adapter,
        });

        await expect(store.getTitle()).rejects.toThrow('transient resolve failure');
        await expect(store.getTitle()).resolves.toBe('Recovered title');
        expect(resolveSession).toHaveBeenCalledTimes(2);
    });

    it('does not leak a late subscription when unsubscribe happens before context resolution completes', async () => {
        let resolveSession!: (value: {
            key: {
                agentId: 'codex';
                source: { kind: 'codexHome'; home: 'user' };
                remoteSessionId: 'session-1';
            };
            value: { sessionRoot: string };
        }) => void;
        const resolveSessionPromise = new Promise<{
            key: {
                agentId: 'codex';
                source: { kind: 'codexHome'; home: 'user' };
                remoteSessionId: 'session-1';
            };
            value: { sessionRoot: string };
        }>((resolve) => {
            resolveSession = resolve;
        });
        const unsubscribeSpy = vi.fn();
        const adapter: FileBackedTranscriptSessionAdapter<string, { running: boolean }, string | null, { sessionRoot: string }, never> = {
            resolveSession: vi.fn(async () => await resolveSessionPromise),
            discoverStreams: vi.fn(async () => ([{
                streamId: 'primary',
                filePath: '/tmp/session-1/rollout.jsonl',
            }])),
            pageOlder: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false, tailCursor: null, truncated: false })),
            readAfter: vi.fn(async () => ({ items: [], nextCursor: null, truncated: false })),
            subscribe: vi.fn(() => unsubscribeSpy),
        };

        const store = createFileBackedTranscriptSessionStore({
            key: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'session-1',
            },
            adapter,
        });

        const unsubscribe = store.subscribe(() => {});
        unsubscribe();

        resolveSession({
            key: {
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                remoteSessionId: 'session-1',
            },
            value: { sessionRoot: '/tmp/session-1' },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(adapter.subscribe).not.toHaveBeenCalled();
        expect(unsubscribeSpy).not.toHaveBeenCalled();
    });
});
