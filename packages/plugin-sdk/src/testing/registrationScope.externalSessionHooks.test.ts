import { describe, expect, it, vi } from 'vitest';

import type { AgentExternalSessionsContribution } from '../activation.js';
import type {
    AgentExternalSessionHooksContribution,
} from '../sessions/index.js';
import { createPluginRegistrationScope } from './registrationScope.js';

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
        rights: [{ family: 'agents', localId: 'assistant', requiredFields }],
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
                value: { externalSessions },
            });
            if (registration?.family !== 'agents') {
                throw new Error('Expected Agent registration');
            }
            expect(registration.value.externalSessionHooks).toEqual(externalSessionHooks);
            expect(registration.value.externalSessionHooks).not.toBe(externalSessionHooks);
            expect(registration.value.externalSessionHooks?.installationVariants)
                .not.toBe(externalSessionHooks.installationVariants);
        },
    );

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
        expect(() => Reflect.apply(
            malformed.api.agents.registerExternalSessionHooks,
            malformed.api.agents,
            ['assistant', legacyAdapterAggregate],
        )).toThrow(/invalid Agent External Session hooks/u);

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
