import { describe, expect, it, vi } from 'vitest';

import type { AgentExternalSessionsContribution } from '../activation.js';
import type {
    AgentExternalSessionHooksContribution,
} from '../sessions/external/index.js';
import { createPluginRegistrationScope } from '../host/registration/index.js';

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

function createExternalSessionHooks(): AgentExternalSessionHooksContribution {
    return {
        installationVariants: [{
            variantId: 'fixture-variant',
            targets: [{
                targetId: 'settings',
                format: 'hook_event_json_arrays_v1',
                collectionId: 'hooks',
            }],
            events: [{
                eventId: 'session-start',
                targetId: 'settings',
                nativeEventName: 'SessionStart',
                command: {
                    kind: 'happier_observation_v1',
                    shellDialect: 'posix',
                },
            }],
        }],
        resolveInstallation: vi.fn(async () => ({
            ok: true as const,
            value: {
                kind: 'supported' as const,
                variantId: 'fixture-variant',
                targets: [{
                    targetId: 'settings',
                    absolutePath: '/var/lib/arbitrary-agent/settings.json',
                }],
                readiness: { kind: 'ready' as const },
            },
        })),
        mapHookEvent: vi.fn(async () => ({
            ok: true as const,
            value: { kind: 'ignored' as const },
        })),
    };
}

function scope(requiredFields: readonly ('factory' | 'externalSessions')[] = ['externalSessions']) {
    return createPluginRegistrationScope({
        pluginId: 'acme.external',
        target: { realm: 'daemon' },
        rights: [{ family: 'agents', localId: 'assistant', target: { realm: 'daemon' }, requiredFields }],
    });
}

describe('Agent External Session hook registration staging', () => {
    it.each(['external-first', 'hooks-first'] as const)(
        'commits one singular same-Agent contribution independent of registration order (%s)',
        (order) => {
            const registrationScope = scope();
            const externalSessionHooks = createExternalSessionHooks();
            if (order === 'external-first') {
                registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
                registrationScope.api.agents.registerExternalSessionHooks(
                    'assistant',
                    externalSessionHooks,
                );
            } else {
                registrationScope.api.agents.registerExternalSessionHooks(
                    'assistant',
                    externalSessionHooks,
                );
                registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
            }

            const [registration] = registrationScope.commit();
            expect(registration).toMatchObject({
                family: 'agents',
                localId: 'assistant',
                value: { externalSessions: externalSessionsSnapshotShape() },
            });
            if (registration?.family !== 'agents') {
                throw new Error('Expected Agent registration');
            }
            expect(registration.value.externalSessionHooks).toMatchObject({
                installationVariants: externalSessionHooks.installationVariants,
                resolveInstallation: expect.any(Function),
                mapHookEvent: expect.any(Function),
            });
            expect(registration.value.externalSessionHooks).not.toBe(externalSessionHooks);
            expect(registration.value.externalSessionHooks?.installationVariants)
                .not.toBe(externalSessionHooks.installationVariants);
        },
    );

    it('captures plain-DTO hooks while cloning static declarations and rejecting live receivers', async () => {
        const owner = 'structural-hooks';
        const mapHookEventImplementation = () => Promise.resolve({
            ok: true as const,
            value: { kind: 'ignored' as const, owner },
        });
        const contribution = {
            installationVariants: createExternalSessionHooks().installationVariants,
            resolveInstallation: () => Promise.resolve({
                ok: true as const,
                value: { kind: 'ignored' as const, owner },
            }),
            mapHookEvent: mapHookEventImplementation,
        } as unknown as AgentExternalSessionHooksContribution;
        const registrationScope = scope();
        registrationScope.api.agents.registerExternalSessions('assistant', externalSessions);
        registrationScope.api.agents.registerExternalSessionHooks(
            'assistant',
            contribution,
        );

        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents' || !registration.value.externalSessionHooks) {
            throw new Error('Expected Agent External Session hooks snapshot');
        }
        const snapshot = registration.value.externalSessionHooks;
        expect(snapshot).not.toBe(contribution);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(snapshot.installationVariants).not.toBe(contribution.installationVariants);
        expect(Object.isFrozen(snapshot.installationVariants)).toBe(true);
        // The captured callback stays bound to the author receiver: a foreign
        // `this` cannot redirect the invocation.
        await expect(Reflect.apply(snapshot.mapHookEvent, { owner: 'foreign' }, [])).resolves.toMatchObject({
            value: { owner },
        });

        // Live class receivers (prototype/accessor-backed hooks) are rejected:
        // registered hook DTOs must be static plain objects that cannot mutate
        // or re-bind after commit.
        class StructuralHooks {
            readonly ignoredByRegistration = true;
            get mapHookEvent() {
                return mapHookEventImplementation;
            }
            resolveInstallation() {
                return Promise.resolve({
                    ok: true as const,
                    value: { kind: 'ignored' as const, owner },
                });
            }
        }
        const liveReceiverScope = scope();
        liveReceiverScope.api.agents.registerExternalSessions('assistant', externalSessions);
        liveReceiverScope.api.agents.registerExternalSessionHooks(
            'assistant',
            new StructuralHooks() as unknown as AgentExternalSessionHooksContribution,
        );
        expect(() => liveReceiverScope.commit()).toThrow(
            /invalid 'agents\/assistant' runtime/u,
        );
    });

    it('rejects unknown External Session helper callbacks while ignoring unrelated data', () => {
        const authorOnly = vi.fn();
        const helperTag = 'trusted-helper';
        const registrationScope = scope();

        registrationScope.api.agents.registerExternalSessions(
            'assistant',
            {
                ...externalSessions,
                // Unrelated non-function extension data is ignored: it is not
                // an operation and never reaches the snapshot.
                helperTag,
            } as AgentExternalSessionsContribution,
        );

        const [registration] = registrationScope.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents') {
            throw new Error('Expected Agent External Sessions snapshot');
        }
        expect(registration.value.externalSessions).toMatchObject(externalSessionsSnapshotShape());
        expect(registration.value.externalSessions).not.toHaveProperty('helperTag');

        // A helper that is itself a callable is rejected through the
        // attributable registration diagnostic: only the closed callback
        // vocabulary may be executable on the registered runtime.
        const rejectingScope = scope();
        rejectingScope.api.agents.registerExternalSessions(
            'assistant',
            {
                ...externalSessions,
                authorOnly,
            } as AgentExternalSessionsContribution,
        );
        expect(() => rejectingScope.commit()).toThrow(
            /invalid 'agents\/assistant' runtime/u,
        );
        expect(authorOnly).not.toHaveBeenCalled();
    });

    it('fails the whole activation for duplicates, adapter cardinality, or missing co-registration', () => {
        const duplicate = scope();
        const externalSessionHooks = createExternalSessionHooks();
        duplicate.api.agents.registerExternalSessionHooks('assistant', externalSessionHooks);
        expect(() => duplicate.api.agents.registerExternalSessionHooks(
            'assistant',
            externalSessionHooks,
        )).toThrow(/duplicate Agent External Session hooks/u);

        const malformed = scope();
        const legacyAdapterAggregate: unknown = { adapters: [] };
        Reflect.apply(
            malformed.api.agents.registerExternalSessionHooks,
            malformed.api.agents,
            ['assistant', legacyAdapterAggregate],
        );
        expect(() => malformed.commit()).toThrow(/invalid 'agents\/assistant' runtime/u);

        const missingExternalSessions = scope();
        missingExternalSessions.api.agents.registerExternalSessionHooks(
            'assistant',
            externalSessionHooks,
        );
        expect(() => missingExternalSessions.commit()).toThrow(
            /missing Agent External Sessions contribution/u,
        );

        const noExternalSessionsRight = scope([]);
        expect(() => noExternalSessionsRight.api.agents.registerExternalSessionHooks(
            'assistant',
            externalSessionHooks,
        )).toThrow(/without External Sessions entitlement/u);
    });

    it('rejects a non-string Agent id before right lookup can coerce it', () => {
        const registrationScope = scope();
        const coerceId = vi.fn(() => 'assistant');

        expect(() => registrationScope.api.agents.registerExternalSessionHooks(
            { toString: coerceId } as unknown as string,
            createExternalSessionHooks(),
        )).toThrow(/local id/u);
        expect(coerceId).not.toHaveBeenCalled();
        expect(registrationScope.registrations()).toEqual([]);
        expect(() => registrationScope.commit()).toThrow(/failed/u);
    });
});
