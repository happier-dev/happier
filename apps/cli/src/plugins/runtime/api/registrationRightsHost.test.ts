import { describe, expect, it, vi } from 'vitest';

import type {
    ActionHandler,
} from '@happier-dev/plugin-sdk/runtime';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/experimental/sessions';
import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { createContributionRegistrationHost } from './registrationRightsHost';

const actionHandler: ActionHandler = async () => ({ ok: true });
const agentFactory = (async () => ({
    sessions: {
        create: async () => { throw new Error('not invoked'); },
        resume: async () => { throw new Error('not invoked'); },
        fork: async () => { throw new Error('not invoked'); },
        attach: async () => { throw new Error('not invoked'); },
    },
})) as unknown as AgentRuntimeFactory;
const providerBinding: AgentProviderBindingAdapter = {
    v: 1,
    adapterVersion: 1,
    prepare: () => ({ v: 1, materialization: 'spawnEnv' }),
    materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
};

const externalSessionsContribution: AgentExternalSessionsContribution = Object.freeze({
    resolveSource: vi.fn(async (request) => ({ ok: true as const, value: { source: request.source } })),
    listCandidates: vi.fn(async () => ({ ok: true as const, value: { candidates: [], nextCursor: null } })),
    resolveLinkIdentity: vi.fn(async (request) => ({ ok: true as const, value: {
        remoteSessionId: request.remoteSessionId,
        source: request.source,
        linkData: request.linkData ?? {},
    } })),
    resolveLinkedIdentity: vi.fn(async (request) => ({ ok: true as const, value: {
        remoteSessionId: request.remoteSessionId,
        source: request.source,
        linkData: request.linkData,
    } })),
    pageTranscript: vi.fn(async () => ({ ok: true as const, value: { items: [], nextCursor: null } })),
    readAfterTranscript: vi.fn(async () => ({ ok: true as const, value: { outcome: 'already_current' as const } })),
});

type ExternalSessionsRegistrationApi = Readonly<{
    registerExternalSessions(id: string, contribution: AgentExternalSessionsContribution): void;
}>;

function externalSessionsApi(host: ReturnType<typeof createContributionRegistrationHost>): ExternalSessionsRegistrationApi {
    return host.api.agents as unknown as ExternalSessionsRegistrationApi;
}

describe('contribution-derived registration host', () => {
    it.each([
        ['accessor', () => Object.defineProperty({}, 'authentication', { enumerable: true, get: () => ({ kind: 'manual' }) })],
        ['prototype', () => Object.assign(Object.create({ inherited: true }), { authentication: { kind: 'manual' } })],
        ['cyclic/extra', () => { const value: Record<string, unknown> = {}; value.authentication = { kind: 'manual' }; value.self = value; return value; }],
        ['nested accessor', () => ({
            authentication: Object.defineProperty({ kind: 'manual' }, 'complete', { enumerable: true, get: () => async () => ({ status: 'rejected' }) }),
            async refresh() {}, async revoke() {}, async status() {}, async materialize() {},
        })],
        ['missing common method', () => ({
            authentication: { kind: 'manual', async complete() {} },
            async refresh() {}, async revoke() {}, async status() {},
        })],
    ])('rejects a malformed connected-account runtime (%s) before staging registration', (_label, buildRuntime) => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.accounts', generation: '1',
            rights: [{ family: 'connectedAccountDescriptors', localId: 'account' }],
            isGenerationCurrent: () => true,
        });

        expect(() => host.api.connectedAccounts.register('account', buildRuntime() as never)).toThrow(/invalid connected-account runtime/i);
        expect(host.registrations()).toEqual([]);
        expect(() => host.commit()).toThrow(/failed|missing/i);
    });

    it('rejects a non-string connected-account registration id before coercion or staging', () => {
        const coerceId = vi.fn(() => 'account');
        const host = createContributionRegistrationHost({
            pluginId: 'acme.accounts', generation: '1',
            rights: [{ family: 'connectedAccountDescriptors', localId: 'account' }],
            isGenerationCurrent: () => true,
        });
        const validRuntime = {
            authentication: {
                modes: {
                    manual: {
                        kind: 'manual' as const,
                        async complete() {
                            return {
                                status: 'rejected' as const,
                                diagnostic: { code: 'fixture', severity: 'error' as const, message: 'not invoked' },
                            };
                        },
                    },
                },
            },
            async refresh() { return { status: 'unavailable' as const }; },
            async revoke() { return { status: 'remoteUnsupported' as const }; },
            async status() { return { status: 'unavailable' as const }; },
            async materialize() { return { kind: 'environment' as const, env: {} }; },
        };

        expect(() => host.api.connectedAccounts.register(
            { toString: coerceId } as unknown as string,
            validRuntime,
        )).toThrow(/local id/i);
        expect(coerceId).not.toHaveBeenCalled();
        expect(host.registrations()).toEqual([]);
        expect(() => host.commit()).toThrow(/failed|missing/i);
    });

    it('publishes an exact nested registration set only after atomic commit', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [
                { family: 'actions', localId: 'run' },
                { family: 'agents', localId: 'assistant' },
            ],
            isGenerationCurrent: () => true,
        });

        expect(host.api.actions.register('run', actionHandler)).toBeUndefined();
        expect(host.api.agents.register('assistant', agentFactory)).toBeUndefined();

        expect(host.registrations()).toEqual([]);
        const committed = host.commit();
        expect(committed.map(({ family, localId }) => ({ family, localId }))).toEqual([
            { family: 'actions', localId: 'run' },
            { family: 'agents', localId: 'assistant' },
        ]);
        expect(host.registrations()).toEqual(committed);
        expect(Object.isFrozen(committed)).toBe(true);
    });

    it('preserves provider binding with the Agent factory as one registration value', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant' }],
            isGenerationCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, { providerBinding });

        expect(host.commit()).toEqual([
            expect.objectContaining({
                family: 'agents',
                localId: 'assistant',
                value: { factory: agentFactory, providerBinding },
            }),
        ]);
    });

    it.each(['primary-first', 'auxiliary-first'] as const)(
        'aggregates primary and External Sessions fields into one Agent registration (%s)',
        (order) => {
            const host = createContributionRegistrationHost({
                pluginId: 'acme.runtime',
                generation: 'generation-7',
                rights: [{ family: 'agents', localId: 'assistant', requiredFields: ['factory', 'externalSessions'] }],
                isGenerationCurrent: () => true,
            });

            if (order === 'primary-first') {
                host.api.agents.register('assistant', agentFactory, { providerBinding });
                externalSessionsApi(host).registerExternalSessions('assistant', externalSessionsContribution);
            } else {
                externalSessionsApi(host).registerExternalSessions('assistant', externalSessionsContribution);
                host.api.agents.register('assistant', agentFactory, { providerBinding });
            }

            expect(host.commit()).toEqual([{
                family: 'agents',
                localId: 'assistant',
                value: {
                    factory: agentFactory,
                    providerBinding,
                    externalSessions: externalSessionsContribution,
                },
            }]);
        },
    );

    it('publishes an auxiliary-only External Sessions contribution under the Agent identity', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', requiredFields: ['externalSessions'] }],
            isGenerationCurrent: () => true,
        });

        externalSessionsApi(host).registerExternalSessions('assistant', externalSessionsContribution);

        expect(host.commit()).toEqual([{
            family: 'agents',
            localId: 'assistant',
            value: { externalSessions: externalSessionsContribution },
        }]);
    });

    it.each(['primary', 'externalSessions'] as const)(
        'rejects a duplicate Agent registration field without publishing a partial value (%s)',
        (field) => {
            const host = createContributionRegistrationHost({
                pluginId: 'acme.runtime',
                generation: 'generation-7',
                rights: [{
                    family: 'agents',
                    localId: 'assistant',
                    requiredFields: field === 'primary' ? ['factory'] : ['externalSessions'],
                }],
                isGenerationCurrent: () => true,
            });

            if (field === 'primary') {
                host.api.agents.register('assistant', agentFactory);
                expect(() => host.api.agents.register('assistant', agentFactory)).toThrow();
            } else {
                externalSessionsApi(host).registerExternalSessions('assistant', externalSessionsContribution);
                expect(() => externalSessionsApi(host).registerExternalSessions(
                    'assistant',
                    externalSessionsContribution,
                )).toThrow();
            }

            expect(host.diagnostics()).toEqual([expect.objectContaining({ code: 'plugin_activation_failed' })]);
            expect(host.registrations()).toEqual([]);
            expect(() => host.commit()).toThrow(/failed/i);
        },
    );

    it('snapshots Provider binding data fields at registration ingress', () => {
        const originalPrepare = providerBinding.prepare;
        const originalMaterialize = providerBinding.materialize;
        const mutableProviderBinding = {
            ...providerBinding,
        };
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant' }],
            isGenerationCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, {
            providerBinding: mutableProviderBinding,
        });
        mutableProviderBinding.adapterVersion = 2;
        mutableProviderBinding.prepare = () => ({ v: 1, materialization: 'configFile' });
        mutableProviderBinding.materialize = async () => ({ v: 1, kind: 'configFile', env: [], files: [] });

        const committed = host.commit()[0];
        expect(committed?.family).toBe('agents');
        if (committed?.family !== 'agents') throw new TypeError('Expected Agent registration');
        expect(committed.value.providerBinding).toMatchObject({
            v: 1,
            adapterVersion: 1,
            prepare: originalPrepare,
            materialize: originalMaterialize,
        });
        expect(Object.isFrozen(committed.value.providerBinding)).toBe(true);
    });

    it('rejects accessor-backed Provider binding fields without invoking them', () => {
        const prepareGetter = vi.fn(() => providerBinding.prepare);
        const providerBindingWithAccessor = {
            v: 1,
            adapterVersion: 1,
            materialize: providerBinding.materialize,
        } as Record<string, unknown>;
        Object.defineProperty(providerBindingWithAccessor, 'prepare', {
            enumerable: true,
            get: prepareGetter,
        });
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant' }],
            isGenerationCurrent: () => true,
        });

        expect(() => host.api.agents.register('assistant', agentFactory, {
            providerBinding: providerBindingWithAccessor as AgentProviderBindingAdapter,
        })).toThrow(/provider binding/i);
        expect(prepareGetter).not.toHaveBeenCalled();
        expect(host.registrations()).toEqual([]);
    });

    it.each([
        ['undeclared identity', (host: ReturnType<typeof createContributionRegistrationHost>) => host.api.actions.register('other', actionHandler)],
        ['wrong family', (host: ReturnType<typeof createContributionRegistrationHost>) => host.api.agents.register('run', agentFactory)],
        ['duplicate registration', (host: ReturnType<typeof createContributionRegistrationHost>) => {
            host.api.actions.register('run', actionHandler);
            host.api.actions.register('run', actionHandler);
        }],
    ])('rejects %s with one coded diagnostic and no publication', (_name, register) => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime', generation: 'generation-7',
            rights: [{ family: 'actions', localId: 'run' }],
            isGenerationCurrent: () => true,
        });

        expect(() => register(host)).toThrow();
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toEqual([
            expect.objectContaining({ code: 'plugin_activation_failed' }),
        ]);
    });

    it('rejects a missing required registration without publishing earlier registrations', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime', generation: 'generation-7',
            rights: [
                { family: 'actions', localId: 'run' },
                { family: 'agents', localId: 'assistant' },
            ],
            isGenerationCurrent: () => true,
        });
        host.api.actions.register('run', actionHandler);

        expect(() => host.commit()).toThrow(/missing/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toHaveLength(1);
    });

    it('rejects registration and commit from a retired generation', () => {
        let current = true;
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime', generation: 'generation-7',
            rights: [{ family: 'actions', localId: 'run' }],
            isGenerationCurrent: () => current,
        });
        current = false;

        expect(() => host.api.actions.register('run', actionHandler)).toThrow(/generation/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toHaveLength(1);
    });

    it('unwinds staged host registrations when activation aborts', async () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.cleanup', generation: 'generation-7',
            rights: [{ family: 'actions', localId: 'run' }],
            isGenerationCurrent: () => true,
        });
        host.api.actions.register('run', actionHandler);

        await host.dispose();

        expect(host.registrations()).toEqual([]);
        expect(() => host.commit()).toThrow(/disposed/i);
    });

    it('unwinds published registrations and single-flights repeated disposal', async () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.cleanup', generation: 'generation-7',
            rights: [{ family: 'actions', localId: 'run' }],
            isGenerationCurrent: () => true,
        });
        host.api.actions.register('run', actionHandler);
        host.commit();

        const first = host.dispose();
        const second = host.dispose();

        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(host.registrations()).toEqual([]);
    });
});
