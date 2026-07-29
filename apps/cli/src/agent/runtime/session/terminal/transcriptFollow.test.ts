import { describe, expect, it, vi } from 'vitest';

import { createPluginExternalSessionsAdapter } from '@/session/external/pluginExternalSessionsAdapter';

import { createHostTerminalTranscriptFollowService } from './transcriptFollow';

describe('createHostTerminalTranscriptFollowService', () => {
    it('binds the exact canonical External Session coordinate and releases once', async () => {
        const publish = vi.fn(async () => undefined);
        const dispose = vi.fn(async () => undefined);
        const executeFollow = vi.fn(async (request: Readonly<{
            ref: unknown;
            source: unknown;
            options: unknown;
            listener(event: unknown): void | Promise<void>;
        }>) => {
            await request.listener({
                kind: 'data',
                items: [{
                    id: 'item-1',
                    kind: 'agent',
                    data: { role: 'agent', text: 'hello' },
                }],
                fromCursor: 'cursor-0',
                nextCursor: 'cursor-1',
            });
            return {
                status: 'following' as const,
                startingCursor: 'cursor-0',
                subscription: { dispose },
            };
        });
        const service = createHostTerminalTranscriptFollowService({
            followProviderSession: async (request, listener) => await executeFollow({
                ref: {
                    agentId: request.agentId,
                    sourceId: 'terminal',
                    remoteSessionId: request.providerSessionId,
                },
                source: { kind: 'terminal', projectId: 'project-1' },
                options: {
                    ...(request.cursor ? { cursor: request.cursor } : {}),
                    signal: request.signal,
                },
                listener,
            }),
            signal: new AbortController().signal,
            publish,
        });

        await expect(service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
            cursor: 'cursor-0',
        })).resolves.toMatchObject({
            status: 'following',
            startingCursor: 'cursor-0',
            binding: { dispose: expect.any(Function) },
        });
        expect(executeFollow).toHaveBeenCalledWith({
            ref: {
                agentId: 'antigravity',
                sourceId: 'terminal',
                remoteSessionId: 'provider-session-1',
            },
            source: { kind: 'terminal', projectId: 'project-1' },
            options: {
                cursor: 'cursor-0',
                signal: expect.any(AbortSignal),
            },
            listener: expect.any(Function),
        });
        expect(publish).toHaveBeenCalledWith({
            kind: 'data',
            items: [{
                id: 'item-1',
                kind: 'agent',
                data: { role: 'agent', text: 'hello' },
            }],
            fromCursor: 'cursor-0',
            nextCursor: 'cursor-1',
        });

        await service.releaseActiveBindings();
        await service.releaseActiveBindings();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('releases a live binding once when the native session generation aborts', async () => {
        const lifecycle = new AbortController();
        const dispose = vi.fn(async () => undefined);
        const service = createHostTerminalTranscriptFollowService({
            followProviderSession: vi.fn(async () => ({
                status: 'following' as const,
                startingCursor: null,
                subscription: { dispose },
            })),
            signal: lifecycle.signal,
            publish: vi.fn(),
        });

        await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
        });
        lifecycle.abort();

        await vi.waitFor(() => {
            expect(dispose).toHaveBeenCalledOnce();
        });
        await service.releaseActiveBindings();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('follows with the exact Antigravity identity source instead of re-resolving the configured source', async () => {
        const dispose = vi.fn(async () => undefined);
        const followTranscript = vi.fn(async (input: Readonly<{
            source: Readonly<Record<string, unknown>>;
        }>) => {
            if (
                input.source.brainDir !== '/home/user/.gemini/antigravity-cli/brain'
                || input.source.conversationId !== 'provider-session-1'
                || input.source.sourceRevision !== 'revision-1'
            ) {
                return {
                    status: 'unavailable' as const,
                    code: 'plugin_external_follow_identity_mismatch',
                };
            }
            return {
                status: 'following' as const,
                startingCursor: 'cursor-0',
                subscription: { dispose },
            };
        });
        const externalSessions = createPluginExternalSessionsAdapter({
            isCurrent: () => true,
            sources: [{
                agentId: 'antigravity',
                sourceId: 'terminal',
                source: { kind: 'antigravityCliPrint' },
                supportsFollow: true,
            }],
            resolveProviderOps: async () => ({
                validateSource: async () => ({
                    ok: true as const,
                    // Antigravity source validation admits the exact identity but
                    // deliberately returns the broader configured discovery source.
                    source: { kind: 'antigravityCliPrint' as const },
                }),
                listCandidates: async () => ({
                    candidates: [],
                    nextCursor: null,
                }),
                resolveLinkIdentity: async ({ remoteSessionId }) => ({
                    source: {
                        kind: 'antigravityCliPrint' as const,
                        brainDir:
                            '/home/user/.gemini/antigravity-cli/brain',
                        conversationId: remoteSessionId,
                        sourceRevision: 'revision-1',
                    },
                    remoteSessionId,
                }),
                pageTranscript: async () => ({
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-0',
                    hasMore: false,
                    truncated: false,
                }),
                readAfterTranscript: async () => ({
                    outcome: 'already_current' as const,
                }),
            }),
            followTranscript,
        });
        const service = createHostTerminalTranscriptFollowService({
            followProviderSession: async (request, listener) => {
                const target = await externalSessions.resolveFollowTarget({
                    agentId: request.agentId,
                    remoteSessionId: request.providerSessionId,
                    signal: request.signal,
                });
                if (target.status === 'unavailable') return target;
                return await externalSessions.followTranscript(
                    target,
                    {
                        ...(request.cursor ? { cursor: request.cursor } : {}),
                        signal: request.signal,
                    },
                    listener,
                );
            },
            signal: new AbortController().signal,
            publish: vi.fn(),
        });

        const result = await service.bindProviderSession({
            agentId: 'antigravity',
            providerSessionId: 'provider-session-1',
            cursor: 'cursor-0',
        });

        expect(result).toMatchObject({
            status: 'following',
            startingCursor: 'cursor-0',
        });
        expect(followTranscript).toHaveBeenCalledWith(expect.objectContaining({
            source: {
                kind: 'antigravityCliPrint',
                brainDir: '/home/user/.gemini/antigravity-cli/brain',
                conversationId: 'provider-session-1',
                sourceRevision: 'revision-1',
            },
        }));
        if (result.status === 'following') {
            await result.binding.dispose();
        }
        expect(dispose).toHaveBeenCalledOnce();
    });
});
