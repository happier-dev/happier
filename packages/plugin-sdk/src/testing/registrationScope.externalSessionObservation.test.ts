import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionObservationReconcileResourceRequest,
    AgentExternalSessionsContribution,
    PluginApi,
} from '../activation.js';
import type { AgentRuntimeFactory } from '../agentRuntime/index.js';
import type {
    AgentExternalSessionObservationResourceDescriptorOutcomeV1,
} from '../externalSessionObservation.js';
import { createPluginRegistrationScope } from '../host/registration/index.js';

const factory = (async () => ({
    sessions: {
        open: async () => { throw new Error('not invoked'); },
    },
})) as unknown as AgentRuntimeFactory;

const externalSessions: AgentExternalSessionsContribution = {
    resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
    listCandidates: async () => ({ ok: true, value: { candidates: [], nextCursor: null } }),
    resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData: {} },
    }),
    resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({
        ok: true,
        value: { source, remoteSessionId, linkData },
    }),
    pageTranscript: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readAfterTranscript: async () => ({ ok: true, value: { outcome: 'already_current' } }),
};

const observation: AgentExternalSessionObservationContribution = {
    describeResource: () => ({
        resourceKey: 'resource-1',
        linkKey: 'link-1',
        changeObservation: 'observe_resource',
    }),
    observeResource: async () => ({ dispose() {} }),
    reconcileResource: async () => ({
        purpose: 'observation_evidence',
        outcomes: [],
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

function observationSnapshotShape() {
    return {
        describeResource: expect.any(Function),
        observeResource: expect.any(Function),
        reconcileResource: expect.any(Function),
    };
}

function scope(requiredFields: readonly ('factory' | 'externalSessions')[] = ['externalSessions']) {
    return createPluginRegistrationScope({
        pluginId: 'acme.external',
        target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'assistant', target: { realm: 'daemon' }, requiredFields }],
    });
}

describe('Agent External Session observation registration staging', () => {
    it('makes the Plugin API method required, present, static, and non-disposable', () => {
        expectTypeOf<PluginApi['agents']['registerExternalSessionObservation']>().toBeFunction();
        expectTypeOf<
            ReturnType<PluginApi['agents']['registerExternalSessionObservation']>
        >().toEqualTypeOf<void>();
        expectTypeOf<keyof AgentExternalSessionObservationContribution>().toEqualTypeOf<
            'describeResource' | 'observeResource' | 'reconcileResource'
        >();
        expectTypeOf<
            AgentExternalSessionObservationReconcileResourceRequest['purpose']
        >().toEqualTypeOf<'observation_evidence' | 'resource_descriptors'>();
        expectTypeOf<AgentExternalSessionObservationResourceDescriptorOutcomeV1>()
            .toMatchTypeOf<
                | Readonly<{
                    kind: 'described';
                    descriptor: Readonly<{
                        resourceKey: string;
                        linkKey: string;
                    }>;
                }>
                | Readonly<{ kind: 'unavailable'; linkKey: string }>
            >();
    });

    it.each([
        'observation-external',
        'external-observation',
        'runtime-external-observation',
        'runtime-observation-external',
        'observation-external-runtime',
        'observation-runtime-external',
        'external-observation-runtime',
        'external-runtime-observation',
    ] as const)('merges all bindings on one Agent aggregate (%s)', (order) => {
        const registrationScope = scope(
            order.includes('runtime') ? ['factory', 'externalSessions'] : ['externalSessions'],
        );
        for (const field of order.split('-')) {
            if (field === 'runtime') registrationScope.api.agents.register('assistant', factory);
            if (field === 'external') {
                registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
            }
            if (field === 'observation') {
                registrationScope.api.agents.registerExternalSessionObservation('assistant', observation);
            }
        }

        expect(registrationScope.commit()).toEqual([{
            family: 'agents',
            localId: 'assistant',
            value: {
                ...(order.includes('runtime') ? { factory } : {}),
                externalSessions: externalSessionsSnapshotShape(),
                externalSessionObservation: observationSnapshotShape(),
            },
        }]);
    });

    it('rejects undeclared, factory-only, observation-without-External-Sessions, and duplicate bindings', () => {
        const undeclared = createPluginRegistrationScope({
            pluginId: 'acme.external',
            target: { realm: 'daemon' },
            rights: [],
        });
        expect(() => undeclared.api.agents.registerExternalSessionObservation('assistant', observation))
            .toThrow(/undeclared contribution/u);

        const factoryOnly = scope(['factory']);
        factoryOnly.api.agents.register('assistant', factory);
        expect(() => factoryOnly.api.agents.registerExternalSessionObservation('assistant', observation))
            .toThrow(/External Sessions entitlement/u);

        const missingExternalSessions = scope();
        missingExternalSessions.api.agents.registerExternalSessionObservation('assistant', observation);
        expect(() => missingExternalSessions.commit()).toThrow(/missing Agent External Sessions/u);

        const duplicate = scope();
        duplicate.api.agents.registerExternalSessionObservation('assistant', observation);
        expect(() => duplicate.api.agents.registerExternalSessionObservation('assistant', observation))
            .toThrow(/duplicate Agent External Session observation/u);
    });

    it.each([
        {
            label: 'missing operation',
            value: {
                describeResource: observation.describeResource,
                observeResource: observation.observeResource,
            },
        },
        {
            label: 'non-function operation',
            value: { ...observation, reconcileResource: null },
        },
    ])('rejects a malformed required contribution: $label', ({ value }) => {
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessionObservation(
            'assistant',
            value as AgentExternalSessionObservationContribution,
        );
        expect(() => registrationScope.commit()).toThrow(/invalid 'agents\/assistant' runtime/u);
    });

    it('ignores a trusted fourth observation helper while publishing declared operations', () => {
        const registrationScope = scope();
        const fourthOperationName = ['resolve', 'TopologyRoots'].join('');
        const fourthOperation = vi.fn(() => ['/provider/sessions']);
        const contributed = {
            ...observation,
            [fourthOperationName]: fourthOperation,
        };

        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
        registrationScope.api.agents.registerExternalSessionObservation(
            'assistant',
            contributed,
        );
        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents') {
            throw new Error('Expected Agent External Session observation snapshot');
        }
        expect(registration.value.externalSessionObservation).toMatchObject(
            observationSnapshotShape(),
        );
        expect(registration.value.externalSessionObservation).not.toHaveProperty(fourthOperationName);
        expect(fourthOperation).not.toHaveBeenCalled();
    });

    it('captures class, prototype, and accessor-backed operations with the author receiver', async () => {
        class StructuralObservation {
            readonly ignoredByRegistration = true;
            readonly owner = 'structural-observation';

            describeResource() {
                return {
                    resourceKey: 'resource-1',
                    linkKey: 'link-1',
                    changeObservation: 'observe_resource',
                    owner: this.owner,
                };
            }

            observeResource() {
                return Promise.resolve({ dispose() {} });
            }

            get reconcileResource() {
                return this.reconcileResourceImplementation;
            }

            reconcileResourceImplementation() {
                return Promise.resolve({
                    purpose: 'observation_evidence',
                    outcomes: [],
                    owner: this.owner,
                });
            }
        }
        const contribution = new StructuralObservation();
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
        registrationScope.api.agents.registerExternalSessionObservation(
            'assistant',
            contribution as unknown as AgentExternalSessionObservationContribution,
        );

        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents' || !registration.value.externalSessionObservation) {
            throw new Error('Expected Agent External Session observation snapshot');
        }
        const snapshot = registration.value.externalSessionObservation;
        expect(snapshot).not.toBe(contribution);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(snapshot).not.toHaveProperty('ignoredByRegistration');
        expect(Reflect.apply(snapshot.describeResource, { owner: 'foreign' }, [])).toMatchObject({
            owner: 'structural-observation',
        });
    });

    it('rejects a non-string Agent id before right lookup can coerce it', () => {
        const registrationScope = scope();
        const coerceId = vi.fn(() => 'assistant');

        expect(() => registrationScope.api.agents.registerExternalSessionObservation(
            { toString: coerceId } as unknown as string,
            observation,
        )).toThrow(/local id/u);
        expect(coerceId).not.toHaveBeenCalled();
        expect(registrationScope.registrations()).toEqual([]);
        expect(() => registrationScope.commit()).toThrow(/failed/u);
    });
});
