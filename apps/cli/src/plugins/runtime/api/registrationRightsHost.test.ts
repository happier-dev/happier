import { describe, expect, it, vi } from 'vitest';

import type {
    ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    createContributionRegistrationHost,
} from './registrationRightsHost';

const actionHandler: ActionHandler = async () => ({ ok: true });
const daemonTarget = Object.freeze({ realm: 'daemon' as const });
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
const sessionRunnerFactory = Object.freeze({
    module: './agent/runtime/factory',
    export: 'createAssistantAgentRuntime',
    runtimeApiVersion: 1 as const,
});

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

    it('rejects a non-string connected-account registration id before coercion or staging', () => {
        const coerceId = vi.fn(() => 'account');
        const host = createContributionRegistrationHost({
            pluginId: 'acme.accounts', occurrenceId: '1',
            rights: [{ family: 'connectedAccountDescriptors', localId: 'account', target: daemonTarget }],
            isOccurrenceCurrent: () => true,
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
            occurrenceId: 'generation-7',
            rights: [
                { family: 'actions', localId: 'run', target: daemonTarget },
                { family: 'agents', localId: 'assistant', target: daemonTarget },
            ],
            isOccurrenceCurrent: () => true,
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
            occurrenceId: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget }],
            isOccurrenceCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, { providerBinding });

        expect(host.commit()).toEqual([
            expect.objectContaining({
                family: 'agents',
                localId: 'assistant',
                value: {
                    factory: agentFactory,
                    providerBinding: {
                        v: 1,
                        adapterVersion: 1,
                        prepare: expect.any(Function),
                        materialize: expect.any(Function),
                    },
                },
            }),
        ]);
    });

    it('preserves the trusted session runner factory locator receiver', () => {
        const mutableLocator: {
            module: string;
            export: string;
            runtimeApiVersion: 1;
        } = { ...sessionRunnerFactory };
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            occurrenceId: 'generation-7',
            rights: [{
                family: 'agents',
                localId: 'assistant',
                target: daemonTarget,
                requiredFields: ['factory', 'sessionRunnerFactory'],
            }],
            isOccurrenceCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, {
            sessionRunnerFactory: mutableLocator,
        } as never);

        const [registration] = host.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents') throw new TypeError('Expected Agent registration');
        mutableLocator.module = './agent/runtime/replaced';
        expect(registration.value.sessionRunnerFactory).toBe(mutableLocator);
        expect(registration.value.sessionRunnerFactory?.module).toBe('./agent/runtime/replaced');
    });

    it.each(['primary-first', 'auxiliary-first'] as const)(
        'aggregates primary and External Sessions fields into one Agent registration (%s)',
        (order) => {
            const host = createContributionRegistrationHost({
                pluginId: 'acme.runtime',
                occurrenceId: 'generation-7',
                rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget, requiredFields: ['factory', 'externalSessions'] }],
                isOccurrenceCurrent: () => true,
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
                    providerBinding: {
                        v: 1,
                        adapterVersion: 1,
                        prepare: expect.any(Function),
                        materialize: expect.any(Function),
                    },
                    externalSessions: {
                        resolveSource: expect.any(Function),
                        listCandidates: expect.any(Function),
                        resolveLinkIdentity: expect.any(Function),
                        resolveLinkedIdentity: expect.any(Function),
                        pageTranscript: expect.any(Function),
                        readAfterTranscript: expect.any(Function),
                    },
                },
            }]);
        },
    );

    it('invokes optional hydrateCandidates on its original contribution receiver', async () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            occurrenceId: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget, requiredFields: ['externalSessions'] }],
            isOccurrenceCurrent: () => true,
        });
        const contribution = {
            ...externalSessionsContribution,
            marker: 'receiver',
            async hydrateCandidates(this: { marker: string }) {
                return { ok: true as const, value: { candidates: [], receiver: this.marker } };
            },
        } as unknown as AgentExternalSessionsContribution;

        externalSessionsApi(host).registerExternalSessions('assistant', contribution);

        const [registration] = host.commit();
        const externalSessions = (registration?.value as { externalSessions: Record<string, unknown> }).externalSessions;
        const runtime = externalSessions as { hydrateCandidates(): Promise<unknown> };
        await expect(runtime.hydrateCandidates()).resolves.toEqual({ ok: true, value: { candidates: [], receiver: 'receiver' } });
    });

    it('publishes an auxiliary-only External Sessions contribution under the Agent identity', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            occurrenceId: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget, requiredFields: ['externalSessions'] }],
            isOccurrenceCurrent: () => true,
        });

        externalSessionsApi(host).registerExternalSessions('assistant', externalSessionsContribution);

        expect(host.commit()).toEqual([{
            family: 'agents',
            localId: 'assistant',
            value: {
                externalSessions: {
                    resolveSource: expect.any(Function),
                    listCandidates: expect.any(Function),
                    resolveLinkIdentity: expect.any(Function),
                    resolveLinkedIdentity: expect.any(Function),
                    pageTranscript: expect.any(Function),
                    readAfterTranscript: expect.any(Function),
                },
            },
        }]);
    });

    it.each(['primary', 'externalSessions'] as const)(
        'rejects a duplicate Agent registration field without publishing a partial value (%s)',
        (field) => {
            const host = createContributionRegistrationHost({
                pluginId: 'acme.runtime',
                occurrenceId: 'generation-7',
                rights: [{
                    family: 'agents',
                    localId: 'assistant',
                    target: daemonTarget,
                    requiredFields: field === 'primary' ? ['factory'] : ['externalSessions'],
                }],
                isOccurrenceCurrent: () => true,
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

    it.each([
        ['undeclared identity', (host: ReturnType<typeof createContributionRegistrationHost>) => host.api.actions.register('other', actionHandler)],
        ['wrong family', (host: ReturnType<typeof createContributionRegistrationHost>) => host.api.agents.register('run', agentFactory)],
        ['duplicate registration', (host: ReturnType<typeof createContributionRegistrationHost>) => {
            host.api.actions.register('run', actionHandler);
            host.api.actions.register('run', actionHandler);
        }],
    ])('rejects %s with one coded diagnostic and no publication', (_name, register) => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime', occurrenceId: 'generation-7',
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
            isOccurrenceCurrent: () => true,
        });

        expect(() => register(host)).toThrow();
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toEqual([
            expect.objectContaining({ code: 'plugin_activation_failed' }),
        ]);
    });

    it('rejects a missing required registration without publishing earlier registrations', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime', occurrenceId: 'generation-7',
            rights: [
                { family: 'actions', localId: 'run', target: daemonTarget },
                { family: 'agents', localId: 'assistant', target: daemonTarget },
            ],
            isOccurrenceCurrent: () => true,
        });
        host.api.actions.register('run', actionHandler);

        expect(() => host.commit()).toThrow(/missing/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toHaveLength(1);
    });

    it('rejects registration and commit from a retired generation', () => {
        let current = true;
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime', occurrenceId: 'generation-7',
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
            isOccurrenceCurrent: () => current,
        });
        current = false;

        expect(() => host.api.actions.register('run', actionHandler)).toThrow(/generation/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toHaveLength(1);
    });

    it('rejects undeclared and retired background-service registrations before publication', () => {
        const undeclared = createContributionRegistrationHost({
            pluginId: 'acme.background', occurrenceId: 'generation-7',
            rights: [],
            isOccurrenceCurrent: () => true,
        });

        expect(() => undeclared.api.backgroundServices.register('indexer', async () => {}))
            .toThrow(/undeclared|not declared|registration right/i);
        expect(undeclared.registrations()).toEqual([]);

        let current = true;
        const retired = createContributionRegistrationHost({
            pluginId: 'acme.background', occurrenceId: 'generation-7',
            rights: [{ family: 'backgroundServices', localId: 'indexer', target: daemonTarget }],
            isOccurrenceCurrent: () => current,
        });
        current = false;

        expect(() => retired.api.backgroundServices.register('indexer', async () => {}))
            .toThrow(/generation/i);
        expect(retired.registrations()).toEqual([]);
    });

    it('rejects a client-artifact right at the daemon host boundary before staging', () => {
        expect(() => createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            occurrenceId: 'generation-7',
            rights: [{
                family: 'voiceProviders',
                localId: 'conversation',
                target: {
                    realm: 'client',
                    artifactId: 'voice-runtime-web',
                    exportName: 'activate',
                    platforms: ['web'],
                },
            }],
            isOccurrenceCurrent: () => true,
        })).toThrow(/realm|daemon|client/i);
    });

    it('unwinds staged host registrations when activation aborts', async () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.cleanup', occurrenceId: 'generation-7',
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
            isOccurrenceCurrent: () => true,
        });
        host.api.actions.register('run', actionHandler);

        await host.dispose();

        expect(host.registrations()).toEqual([]);
        expect(() => host.commit()).toThrow(/disposed/i);
    });

    it('unwinds published registrations and single-flights repeated disposal', async () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.cleanup', occurrenceId: 'generation-7',
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
            isOccurrenceCurrent: () => true,
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
