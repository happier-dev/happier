import { describe, expect, it } from 'vitest';

import type { AgentExternalSessionsContribution } from '../activation.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import { createPluginRegistrationScope } from './registrationScope.js';

const factory = (async () => ({
    sessions: {
        create: async () => { throw new Error('not invoked'); },
        resume: async () => { throw new Error('not invoked'); },
        fork: async () => { throw new Error('not invoked'); },
        attach: async () => { throw new Error('not invoked'); },
    },
})) as unknown as AgentRuntimeFactory;

const externalSessions: AgentExternalSessionsContribution = {
    resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
    listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({ ok: true, value: { source, remoteSessionId, linkData: {} } }),
    resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({ ok: true, value: { source, remoteSessionId, linkData } }),
    pageTranscript: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readAfterTranscript: async () => ({ ok: true, value: { outcome: 'already_current' } }),
};

function scope(requiredFields: readonly ('factory' | 'externalSessions')[] = ['externalSessions']) {
    return createPluginRegistrationScope({
        pluginId: 'acme.external',
        rights: [{ family: 'agents', localId: 'assistant', requiredFields }],
    });
}

describe('Agent External Sessions registration staging', () => {
    it('commits an auxiliary-only Agent registration without a fake runtime factory', () => {
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);

        expect(registrationScope.commit()).toEqual([{
            family: 'agents',
            localId: 'assistant',
            value: { externalSessions },
        }]);
    });

    it.each(['runtime-first', 'external-first'] as const)(
        'merges primary and auxiliary bindings on one Agent identity (%s)',
        (order) => {
            const registrationScope = scope(['factory', 'externalSessions']);
            if (order === 'runtime-first') {
                registrationScope.api.agents.register('assistant', factory);
                registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
            } else {
                registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
                registrationScope.api.agents.register('assistant', factory);
            }

            expect(registrationScope.commit()).toEqual([{
                family: 'agents',
                localId: 'assistant',
                value: { factory, externalSessions },
            }]);
        },
    );

    it('rejects duplicate registration of either Agent binding field', () => {
        const duplicateRuntime = scope();
        duplicateRuntime.api.agents.register('assistant', factory);
        expect(() => duplicateRuntime.api.agents.register('assistant', factory)).toThrow(/duplicate Agent runtime/u);

        const duplicateExternalSessions = scope();
        duplicateExternalSessions.api.agents.registerExternalSessions('assistant', externalSessions);
        expect(() => duplicateExternalSessions.api.agents.registerExternalSessions('assistant', externalSessions))
            .toThrow(/duplicate Agent External Sessions/u);
    });

    it('rejects follow coordination outside the exact six-method contribution', () => {
        const registrationScope = scope();
        const withFollowPath = {
            ...externalSessions,
            resolveFollowTranscriptPath: async () => ({
                ok: true as const,
                value: { path: '/private/provider/transcript.jsonl' },
            }),
        } as unknown as AgentExternalSessionsContribution;

        expect(() => registrationScope.api.agents.registerExternalSessions(
            'assistant',
            withFollowPath,
        )).toThrow(/invalid Agent External Sessions contribution/u);
    });

    it('requires every Agent subfield declared by the manifest', () => {
        const missingRuntime = scope(['factory', 'externalSessions']);
        missingRuntime.api.agents.registerExternalSessions('assistant', externalSessions);
        expect(() => missingRuntime.commit()).toThrow(/missing Agent runtime/u);

        const missingExternalSessions = scope(['factory', 'externalSessions']);
        missingExternalSessions.api.agents.register('assistant', factory);
        expect(() => missingExternalSessions.commit()).toThrow(/missing Agent External Sessions/u);
    });
});
