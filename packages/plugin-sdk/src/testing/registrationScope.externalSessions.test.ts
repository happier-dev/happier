import { describe, expect, it, vi } from 'vitest';

import type { AgentExternalSessionsContribution } from '../activation.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import { createPluginRegistrationScope } from '../host/registration/index.js';

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

function externalSessionsSnapshotShape() {
    return {
        resolveSource: expect.any(Function),
        listCandidates: expect.any(Function),
        resolveLinkIdentity: expect.any(Function),
        resolveLinkedIdentity: expect.any(Function),
        pageTranscript: expect.any(Function),
        readAfterTranscript: expect.any(Function),
    };
}

function scope(requiredFields: readonly ('factory' | 'externalSessions')[] = ['externalSessions']) {
    return createPluginRegistrationScope({
        pluginId: 'acme.external',
        target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'assistant', target: { realm: 'daemon' }, requiredFields }],
    });
}

describe('Agent External Sessions registration staging', () => {
    it('admits and statically captures the optional managed endpoint service declaration', () => {
        const declaring: AgentExternalSessionsContribution = {
            ...externalSessions,
            resolveManagedEndpointService: () => null,
        };
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', declaring);
        const [registration] = registrationScope.commit();
        const snapshot = registration?.family === 'agents'
            ? registration.value.externalSessions
            : undefined;
        if (!snapshot) throw new Error('Expected committed External Sessions snapshot');

        expect(snapshot.resolveManagedEndpointService).toEqual(expect.any(Function));
        expect(Object.getOwnPropertyDescriptor(snapshot, 'resolveManagedEndpointService'))
            .toMatchObject({ enumerable: true, writable: false, configurable: false });
        expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('rejects missing or non-callable required operations', () => {
        const missingOperation = { ...externalSessions } as Record<string, unknown>;
        delete missingOperation.resolveSource;

        for (const contribution of [
            missingOperation,
            { ...externalSessions, resolveSource: null },
        ]) {
            const registrationScope = scope();
            registrationScope.api.agents.registerExternalSessions(
                'assistant',
                contribution as AgentExternalSessionsContribution,
            );
            expect(() => registrationScope.commit()).toThrow(/invalid 'agents\/assistant' runtime/iu);
        }
    });

    it('rejects public callback members outside the approved contribution operations', () => {
        const unrelatedOperation = vi.fn();
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions(
            'assistant',
            {
                ...externalSessions,
                notAnOperation: unrelatedOperation,
            } as unknown as AgentExternalSessionsContribution,
        );

        expect(() => registrationScope.commit()).toThrow(/invalid 'agents\/assistant' runtime/iu);
        expect(unrelatedOperation).not.toHaveBeenCalled();
    });

    it.each([
        ['data', (value: Record<PropertyKey, unknown>) => {
            value.notAnOperation = true;
        }],
        ['symbol', (value: Record<PropertyKey, unknown>) => {
            value[Symbol('unknown')] = true;
        }],
        ['accessor', (value: Record<PropertyKey, unknown>) => {
            Object.defineProperty(value, 'notAnOperation', {
                configurable: true,
                get: () => true,
            });
        }],
        ['non-enumerable', (value: Record<PropertyKey, unknown>) => {
            Object.defineProperty(value, 'notAnOperation', {
                configurable: true,
                enumerable: false,
                value: true,
            });
        }],
    ] as const)('rejects every unknown own %s member', (_kind, addUnknown) => {
        const contribution = { ...externalSessions } as Record<PropertyKey, unknown>;
        addUnknown(contribution);
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions(
            'assistant',
            contribution as unknown as AgentExternalSessionsContribution,
        );

        expect(() => registrationScope.commit()).toThrow(/invalid 'agents\/assistant' runtime/iu);
    });

    it('captures current callbacks at commit and freezes their facades', async () => {
        const mutable = { ...externalSessions };
        const replacement = vi.fn(async () => ({ ok: true as const, value: { source: {} as never } }));
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', mutable);
        mutable.resolveSource = replacement;
        const [registration] = registrationScope.commit();
        const snapshot = registration?.family === 'agents'
            ? registration.value.externalSessions
            : undefined;

        expect(snapshot).toBeDefined();
        if (!snapshot) throw new Error('Expected committed External Sessions snapshot');
        expect(snapshot).not.toBe(mutable);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Reflect.ownKeys(snapshot)).toEqual(Reflect.ownKeys(mutable));
        for (const operation of Reflect.ownKeys(snapshot)) {
            expect(Object.getOwnPropertyDescriptor(snapshot, operation))
                .toMatchObject({
                    enumerable: true,
                    writable: false,
                    configurable: false,
                    value: expect.any(Function),
                });
        }
        mutable.resolveSource = vi.fn();
        await Reflect.apply(snapshot.resolveSource, snapshot, [{}]);
        expect(replacement).toHaveBeenCalledOnce();
    });

    it('captures the same runner companion independently for each committed generation', () => {
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
        const [registered] = registrationScope.commit();

        const attestationScope = scope();
        attestationScope.api.agents.registerExternalSessions('assistant', externalSessions);
        const [attested] = attestationScope.commit();

        expect(registered?.family).toBe('agents');
        expect(attested?.family).toBe('agents');
        if (registered?.family !== 'agents' || attested?.family !== 'agents') {
            throw new Error('Expected Agent External Sessions registrations');
        }
        expect(attested.value.externalSessions).not.toBe(registered.value.externalSessions);
    });

    it('captures class, prototype, and accessor-backed operations with the author receiver', async () => {
        class StructuralExternalSessions {
            get owner() {
                return 'structural-runtime';
            }

            resolveSource({ source }: { source: unknown }) {
                return Promise.resolve({
                    ok: true as const,
                    value: { source, owner: this.owner },
                });
            }

            listCandidates() {
                return Promise.resolve({
                    ok: true as const,
                    value: { candidates: [], nextCursor: null },
                });
            }

            resolveLinkIdentity({ source, remoteSessionId }: {
                source: unknown;
                remoteSessionId: unknown;
            }) {
                return Promise.resolve({
                    ok: true as const,
                    value: { source, remoteSessionId, linkData: {} },
                });
            }

            resolveLinkedIdentity({ source, remoteSessionId, linkData }: {
                source: unknown;
                remoteSessionId: unknown;
                linkData: unknown;
            }) {
                return Promise.resolve({
                    ok: true as const,
                    value: { source, remoteSessionId, linkData },
                });
            }

            pageTranscript() {
                return Promise.resolve({
                    ok: true as const,
                    value: { items: [], nextCursor: null },
                });
            }

            get readAfterTranscript() {
                return this.readAfterTranscriptImplementation;
            }

            readAfterTranscriptImplementation() {
                return Promise.resolve({
                    ok: true as const,
                    value: { outcome: 'already_current' as const },
                });
            }
        }
        const contribution = new StructuralExternalSessions();

        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions(
            'assistant',
            contribution as unknown as AgentExternalSessionsContribution,
        );
        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents' || !registration.value.externalSessions) {
            throw new Error('Expected Agent External Sessions snapshot');
        }

        const snapshot = registration.value.externalSessions;
        expect(snapshot).not.toBe(contribution);
        expect(Object.isFrozen(snapshot)).toBe(true);
        await expect(Reflect.apply(snapshot.resolveSource, { owner: 'foreign' }, [{ source: 'source' }]))
            .resolves.toEqual({
                ok: true,
                value: { source: 'source', owner: 'structural-runtime' },
            });
    });

    it('commits an auxiliary-only Agent registration without a fake runtime factory', () => {
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);

        expect(registrationScope.commit()).toEqual([{
            family: 'agents',
            localId: 'assistant',
            value: { externalSessions: externalSessionsSnapshotShape() },
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
                value: {
                    factory,
                    externalSessions: externalSessionsSnapshotShape(),
                },
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

    it('rejects retired follow coordination beyond the External Sessions callback contract', () => {
        const registrationScope = scope();
        const withFollowPath = {
            ...externalSessions,
            resolveFollowTranscriptPath: async () => ({
                ok: true as const,
                value: { path: '/private/provider/transcript.jsonl' },
            }),
        } as unknown as AgentExternalSessionsContribution;

        registrationScope.api.agents.registerExternalSessions(
            'assistant',
            withFollowPath,
        );
        expect(() => registrationScope.commit()).toThrow(/invalid 'agents\/assistant' runtime/iu);
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
