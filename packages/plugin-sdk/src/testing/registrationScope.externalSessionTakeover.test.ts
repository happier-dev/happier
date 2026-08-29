import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PluginApi } from '../activation.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import type { AgentExternalSessionsContribution } from '../externalSessions.js';
import type {
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverResolveLaunchRequest,
} from '../sessions/externalSessionTakeover.js';
import { createPluginRegistrationScope } from '../host/registration/index.js';

const factory = (async () => ({
    sessions: {
        open: async () => {
            throw new Error('not invoked');
        },
    },
})) as unknown as AgentRuntimeFactory;

const externalSessions: AgentExternalSessionsContribution = {
    resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
    listCandidates: async () => ({
        ok: true,
        value: { candidates: [], nextCursor: null },
    }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData: {} },
    }),
    resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData },
    }),
    pageTranscript: async () => ({
        ok: true,
        value: { items: [], nextCursor: null },
    }),
    readAfterTranscript: async () => ({
        ok: true,
        value: { outcome: 'already_current' },
    }),
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

const takeover: AgentExternalSessionTakeoverContribution = {
    resolveLaunch: async () => ({
        ok: true,
        value: { backendModeHint: 'resume' },
    }),
};

function scope(
    requiredFields: readonly ('factory' | 'externalSessions')[] = [
        'externalSessions',
    ],
) {
    return createPluginRegistrationScope({
        pluginId: 'acme.external',
        target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'assistant', target: { realm: 'daemon' }, requiredFields }],
    });
}

describe('Agent External Session takeover registration staging', () => {
    it('exposes one required static request-only registration callback', () => {
        type RegisterTakeover =
            PluginApi['agents']['registerExternalSessionTakeover'];
        expectTypeOf<Parameters<RegisterTakeover>[0]>().toEqualTypeOf<string>();
        expectTypeOf<Parameters<RegisterTakeover>[1]>()
            .toEqualTypeOf<AgentExternalSessionTakeoverContribution>();
        expectTypeOf<ReturnType<RegisterTakeover>>().toEqualTypeOf<void>();
        expectTypeOf<keyof AgentExternalSessionTakeoverContribution>()
            .toEqualTypeOf<'resolveLaunch'>();
        expectTypeOf<
            Parameters<AgentExternalSessionTakeoverContribution['resolveLaunch']>
        >().toEqualTypeOf<[request: AgentExternalSessionTakeoverResolveLaunchRequest]>();
    });

    it.each([
        'external-takeover',
        'takeover-external',
        'runtime-external-takeover',
        'runtime-takeover-external',
        'external-runtime-takeover',
        'external-takeover-runtime',
        'takeover-runtime-external',
        'takeover-external-runtime',
    ] as const)('merges all bindings on one Agent aggregate (%s)', (order) => {
        const registrationScope = scope(
            order.includes('runtime')
                ? ['factory', 'externalSessions']
                : ['externalSessions'],
        );
        for (const field of order.split('-')) {
            if (field === 'runtime') {
                registrationScope.api.agents.register('assistant', factory);
            }
            if (field === 'external') {
                registrationScope.api.agents.registerExternalSessions(
                    'assistant',
                    externalSessions,
                );
            }
            if (field === 'takeover') {
                registrationScope.api.agents.registerExternalSessionTakeover(
                    'assistant',
                    takeover,
                );
            }
        }

        expect(registrationScope.commit()).toEqual([{
            family: 'agents',
            localId: 'assistant',
            value: {
                ...(order.includes('runtime') ? { factory } : {}),
                externalSessions: externalSessionsSnapshotShape(),
                externalSessionTakeover: { resolveLaunch: expect.any(Function) },
            },
        }]);
    });

    it('snapshots the callback and rejects duplicate registration', () => {
        const mutable = { ...takeover };
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions(
            'assistant',
            externalSessions,
        );
        registrationScope.api.agents.registerExternalSessionTakeover(
            'assistant',
            mutable,
        );

        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents') {
            throw new Error('Expected Agent registration');
        }
        expect(registration.value.externalSessionTakeover).toEqual({
            resolveLaunch: expect.any(Function),
        });
        expect(registration.value.externalSessionTakeover).not.toBe(mutable);

        const duplicate = scope();
        duplicate.api.agents.registerExternalSessionTakeover(
            'assistant',
            takeover,
        );
        expect(() => duplicate.api.agents.registerExternalSessionTakeover(
            'assistant',
            takeover,
        )).toThrow(/duplicate Agent External Session takeover/u);
    });

    it('captures class, prototype, and accessor-backed callbacks with the author receiver', async () => {
        class StructuralTakeover implements AgentExternalSessionTakeoverContribution {
            readonly ignoredByRegistration = true;
            readonly owner = 'structural-takeover';

            get resolveLaunch() {
                return this.resolveLaunchImplementation;
            }

            resolveLaunchImplementation(_request: AgentExternalSessionTakeoverResolveLaunchRequest) {
                return Promise.resolve({
                    ok: true as const,
                    value: { backendModeHint: this.owner },
                });
            }
        }
        const contribution = new StructuralTakeover();
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
        registrationScope.api.agents.registerExternalSessionTakeover(
            'assistant',
            contribution,
        );

        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents' || !registration.value.externalSessionTakeover) {
            throw new Error('Expected Agent External Session takeover snapshot');
        }
        const snapshot = registration.value.externalSessionTakeover;
        expect(snapshot).not.toBe(contribution);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(snapshot).not.toHaveProperty('ignoredByRegistration');
        await expect(Reflect.apply(snapshot.resolveLaunch, { owner: 'foreign' }, [])).resolves.toMatchObject({
            value: { backendModeHint: 'structural-takeover' },
        });
    });

    it('rejects undeclared, factory-only, and takeover-without-External-Sessions registrations', () => {
        const undeclared = createPluginRegistrationScope({
            pluginId: 'acme.external',
            target: { realm: 'daemon' },
            rights: [],
        });
        expect(() => undeclared.api.agents.registerExternalSessionTakeover(
            'assistant',
            takeover,
        )).toThrow(/undeclared contribution/u);

        const factoryOnly = scope(['factory']);
        factoryOnly.api.agents.register('assistant', factory);
        expect(() => factoryOnly.api.agents.registerExternalSessionTakeover(
            'assistant',
            takeover,
        )).toThrow(/External Sessions entitlement/u);

        const missingExternalSessions = scope();
        missingExternalSessions.api.agents.registerExternalSessionTakeover(
            'assistant',
            takeover,
        );
        expect(() => missingExternalSessions.commit())
            .toThrow(/missing Agent External Sessions/u);
        expect(missingExternalSessions.registrations()).toEqual([]);
    });

    it.each([
        {
            label: 'missing operation',
            value: new Proxy(takeover, {
                get(target, property, receiver) {
                    return property === 'resolveLaunch'
                        ? undefined
                        : Reflect.get(target, property, receiver);
                },
            }),
        },
        {
            label: 'non-function operation',
            value: new Proxy(takeover, {
                get(target, property, receiver) {
                    return property === 'resolveLaunch'
                        ? null
                        : Reflect.get(target, property, receiver);
                },
            }),
        },
    ])('rejects a malformed required contribution: $label', ({ value }) => {
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessionTakeover(
            'assistant',
            value,
        );
        expect(() => registrationScope.commit()).toThrow(/invalid 'agents\/assistant' runtime/u);
    });
});
