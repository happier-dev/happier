import { describe, expect, it, vi } from 'vitest';

import { createPluginInvocationActionsService } from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('plugin invocation session.list scope', () => {
    it.each(['finite-agent', 'retired-turn', 'session-action'] as const)('keeps %s denied outside its admitted Session scope', async kind => {
        let transcriptReads = 0;
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.agent', version: '1.0.0' },
                contribution: kind === 'session-action'
                    ? { id: 'inspect', qualifiedId: 'acme.agent/actions/inspect' }
                    : { id: 'agent', qualifiedId: 'acme.agent/agents/agent' },
                occurrenceId: 'agent-occurrence', surface: 'agent',
                ...(kind === 'session-action' ? { session: { id: 'current-session' } } : {}),
                ...(kind === 'retired-turn' ? { readActiveTurnAdmissionWitness: () => null } : {}),
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            },
            actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
                // This host transcript transport must remain unreachable without a Session scope.
                sessionTranscriptGet: async ({ sessionId }) => {
                    transcriptReads++;
                    return { ok: true, sessionId, projection: 'externalShareableV1',
                        items: [], nextCursor: '0', scannedThroughSeq: 0, hasMore: false };
                },
            }),
            invokeContributedAction: async () => { throw new Error('No contributed Action expected'); },
        });
        await expect(service.execute('session.transcript.get', {
            sessionId: 'unrelated-session', projection: 'externalShareableV1', cursor: null, limit: 100,
        })).rejects.toMatchObject({ code: 'unsupported_action' });
        expect(transcriptReads).toBe(0);
    });

    it.each(['happier.builtin', 'acme.external-installed'] as const)(
        'gives %s Agent Actions the same exact current-Session listing scope',
        async (pluginId) => {
            const execute = vi.fn(async () => ({ ok: true as const, result: { sessions: [] } }));
            const service = createPluginInvocationActionsService({
                seed: {
                    plugin: { id: pluginId, version: '1.0.0' },
                    resolveCurrentPluginMaterializationRef:
                        createPluginActionCallerMaterializationFixture(pluginId)
                            .resolveCurrentPluginMaterializationRef,
                    contribution: { id: 'agent', qualifiedId: `${pluginId}/agents/agent` },
                    occurrenceId: 'occurrenceId-1',
                    correlationId: `${pluginId}-session-list`,
                    surface: 'agent',
                    session: { id: 'admitted-session' },
                    signal: new AbortController().signal,
                    isOccurrenceCurrent: () => true,
                },
                actionExecutor: { execute },
                invokeContributedAction: vi.fn(),
            });

            await expect(service.execute('session.list', {})).resolves.toEqual({ sessions: [] });
            expect(execute).toHaveBeenCalledWith('session.list', {}, expect.objectContaining({
                surface: 'agent',
                defaultSessionId: 'admitted-session',
                sessionListAccess: 'current_session',
            }));
        },
    );
});
