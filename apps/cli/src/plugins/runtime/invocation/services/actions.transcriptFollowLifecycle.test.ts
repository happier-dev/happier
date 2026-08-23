import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileBackedTranscriptSessionStore } from '@/api/session/fileBackedTranscripts/store';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import { createSessionTranscriptFollowLeaseRegistry } from '@/api/session/transcriptQueries';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
} from './factory';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { createProductionPluginInvocationServiceOwners } from './production';

const boundary = vi.hoisted(() => ({
    createdStores: [] as Array<Readonly<{
        sessionId: string;
        unsubscribe: ReturnType<typeof vi.fn>;
    }>>,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
    resolveSessionTransportContext: vi.fn(async ({ idOrPrefix }: Readonly<{ idOrPrefix: string }>) => ({
        ok: true as const,
        sessionId: idOrPrefix,
        mode: 'plain' as const,
        ctx: null,
    })),
}));

vi.mock('@/api/session/createServerBackedSessionTranscriptStore', () => ({
    createServerBackedSessionTranscriptStore: vi.fn((params: Readonly<{ sessionId: string }>) => {
        const unsubscribe = vi.fn();
        boundary.createdStores.push(Object.freeze({ sessionId: params.sessionId, unsubscribe }));
        return Object.freeze({
            warm: async () => undefined,
            dispose: async () => undefined,
            setLifecycleState: async () => undefined,
            pageOlder: async () => ({
                items: [],
                nextCursor: null,
                hasMore: false,
                tailCursor: null,
                truncated: false,
            }),
            readAfter: async () => ({ items: [], nextCursor: 'tail-next', truncated: false }),
            getTailCursor: () => 'tail-next',
            subscribe: () => unsubscribe,
            getTitle: async () => null,
            getWorkingDirectory: async () => null,
            getActivity: async () => null,
            getPreview: async () => null,
        }) satisfies FileBackedTranscriptSessionStore<SessionTranscriptActionItem>;
    }),
}));

vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
    ensureCliActionPolicySettings: vi.fn(async () => undefined),
}));

describe('production Plugin ActionsService transcript follow lifetime', () => {
    const transcriptMaterialization = createPluginActionCallerMaterializationFixture('acme.transcript');

    beforeEach(() => {
        boundary.createdStores.length = 0;
    });

    it('owns replacement, capacity, and retirement cleanup at one invocation lifetime', async () => {
        const credentials = {
            token: 'token-initial',
            encryption: null,
        } as const;
        let credentialRevision = 0;
        const readCredentials = vi.fn(async () => ({
            token: `token-${++credentialRevision}`,
            encryption: null,
        } as const));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => undefined },
            actionExecutor: createCliActionExecutorFromCredentials({
                credentials,
                readCredentials,
            }),
            invokeContributedAction: async () => ({
                status: 'unavailable' as const,
                code: 'test_target_action_unavailable',
                message: 'test_target_action_unavailable',
            }),
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(
            'generation-1',
            'binding-1',
        );
        const firstRetirement = new AbortController();
        const secondRetirement = new AbortController();
        const createServices = (correlationId: string, signal: AbortSignal) => owners.createServices({
            plugin: { id: 'acme.transcript', version: '1.0.0' },
            contribution: {
                id: 'follow',
                qualifiedId: 'acme.transcript/actions/follow',
            },
            generation: 'generation-1',
            correlationId,
            surface: 'background',
            resolveCurrentPluginMaterializationRef:
                transcriptMaterialization.resolveCurrentPluginMaterializationRef,
            signal,
            isGenerationCurrent: () => !signal.aborted,
        }, binding);
        const first = createServices('invocation-1', firstRetirement.signal);
        const second = createServices('invocation-2', secondRetirement.signal);
        const follow = async (
            services: typeof first,
            leaseId: string,
            sessionId: string,
        ) => await services.actions.execute('transcript.follow', {
            sessionId,
            cursor: 'tail',
            leaseId,
        });

        await expect(follow(first, 'replace-me', 'session-replacement')).resolves.toMatchObject({
            ok: true,
            leaseId: 'replace-me',
        });
        const replacedStore = boundary.createdStores.at(-1);
        await expect(follow(first, 'replace-me', 'session-replacement')).resolves.toMatchObject({
            ok: true,
            leaseId: 'replace-me',
        });
        expect(replacedStore?.unsubscribe).toHaveBeenCalledOnce();

        for (let index = 1; index < 16; index += 1) {
            await expect(follow(first, `lease-${index}`, `session-${index}`)).resolves.toMatchObject({
                ok: true,
                leaseId: `lease-${index}`,
            });
        }
        await expect(follow(first, 'lease-over-capacity', 'session-over-capacity')).rejects.toMatchObject({
            code: 'follow_lease_limit_exceeded',
        });
        expect(boundary.createdStores.at(-1)?.unsubscribe).toHaveBeenCalledOnce();

        await expect(follow(second, 'sibling-lease', 'sibling-session')).resolves.toMatchObject({
            ok: true,
            leaseId: 'sibling-lease',
        });
        const siblingStore = boundary.createdStores.at(-1);

        firstRetirement.abort();
        await vi.waitFor(() => {
            expect(boundary.createdStores
                .filter(({ sessionId }) => sessionId.startsWith('session-'))
                .filter(({ unsubscribe }) => unsubscribe.mock.calls.length === 0)).toEqual([]);
        });
        expect(siblingStore?.unsubscribe).not.toHaveBeenCalled();
        expect(readCredentials).toHaveBeenCalledTimes(19);

        secondRetirement.abort();
        await vi.waitFor(() => {
            expect(siblingStore?.unsubscribe).toHaveBeenCalledOnce();
        });
        await owners.dispose();
    });

    it('clears retained idle timers and refuses new leases after registry disposal', async () => {
        vi.useFakeTimers();
        const firstRelease = vi.fn(async () => undefined);
        const secondRelease = vi.fn(async () => undefined);
        const registry = createSessionTranscriptFollowLeaseRegistry({
            maxLeases: 2,
            idleTtlMs: 1_000,
        });
        try {
            expect(registry.retain({
                sessionId: 'session-1',
                leaseId: 'lease-1',
                idleTtlMs: 1_000,
                release: firstRelease,
            })).toBe(true);
            expect(registry.retain({
                sessionId: 'session-2',
                leaseId: 'lease-2',
                idleTtlMs: 1_000,
                release: secondRelease,
            })).toBe(true);
            expect(vi.getTimerCount()).toBe(2);

            await registry.dispose();

            expect(firstRelease).toHaveBeenCalledOnce();
            expect(secondRelease).toHaveBeenCalledOnce();
            expect(registry.activeCount()).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(registry.retain({
                sessionId: 'session-after-dispose',
                leaseId: 'lease-after-dispose',
                idleTtlMs: 1_000,
                release: firstRelease,
            })).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
