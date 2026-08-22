import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type {
    ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type {
    PromptAssetAdapter,
} from '@happier-dev/plugin-sdk/resources';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentProviderBindingAdapter,
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
    createContributionRegistrationHost,
} from './registrationRightsHost';

const actionHandler: ActionHandler = async () => ({ ok: true });
type PromptAssetTypeDescriptor = PromptAssetAdapter['descriptor'];
const daemonTarget = Object.freeze({ realm: 'daemon' as const });
const promptAssetDescriptor = Object.freeze({
    id: 'acme.skill',
    providerId: 'acme',
    title: 'Acme skills',
    description: 'Acme SKILL.md bundles.',
    libraryKind: 'bundle' as const,
    supportsScope: { user: true, project: true },
    supportsFiles: true,
    formatId: 'skill_md_v1',
    defaultRoots: [
        {
            label: 'Project skills',
            scope: 'project' as const,
            pathTemplate: '.acme/skills',
        },
    ],
    capabilities: { supportsCatalogInstall: true },
} satisfies PromptAssetTypeDescriptor);

function createPromptAssetAdapter(
    descriptor: PromptAssetTypeDescriptor = promptAssetDescriptor,
): PromptAssetAdapter {
    const mutationFailure = Object.freeze({
        ok: false as const,
        errorCode: 'unsupported' as const,
        error: 'not invoked',
    });
    return Object.freeze({
        descriptor,
        async discover() { return Object.freeze([]); },
        async read() { return mutationFailure; },
        async writeDoc() { return mutationFailure; },
        async writeBundle() { return mutationFailure; },
        async delete() { return mutationFailure; },
    });
}
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
    it('consumes Protocol-owned Voice registration rights without rebuilding declarations', () => {
        const source = readFileSync(new URL('./registrationRightsHost.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('voiceProviders.find(');
        expect(source).not.toContain('voiceProviderDeclaration })');
    });

    it('commits a Prompt Asset adapter whose descriptor matches the advertised row', () => {
        const adapter = createPromptAssetAdapter();
        const host = createContributionRegistrationHost({
            pluginId: 'acme.prompts',
            generation: 'generation-7',
            rights: [{
                family: 'promptAssets',
                localId: 'external-skills',
                target: { realm: 'daemon' },
                promptAssetDescriptor,
            }],
            isGenerationCurrent: () => true,
        });

        host.api.resources.registerPromptAssetAdapter('external-skills', adapter);

        expect(host.commit()).toEqual([{
            family: 'promptAssets',
            localId: 'external-skills',
            value: {
                descriptor: promptAssetDescriptor,
                discover: expect.any(Function),
                read: expect.any(Function),
                writeDoc: expect.any(Function),
                writeBundle: expect.any(Function),
                delete: expect.any(Function),
            },
        }]);
    });

    it('rejects a missing Prompt Asset adapter before publishing the activation', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.prompts',
            generation: 'generation-7',
            rights: [{
                family: 'promptAssets',
                localId: 'external-skills',
                target: { realm: 'daemon' },
                promptAssetDescriptor,
            }],
            isGenerationCurrent: () => true,
        });

        expect(() => host.commit()).toThrow(/missing registration 'promptAssets\/external-skills'/i);
        expect(host.registrations()).toEqual([]);
    });

    it('rejects an undeclared extra Prompt Asset adapter before staging it', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.prompts',
            generation: 'generation-7',
            rights: [],
            isGenerationCurrent: () => true,
        });

        expect(() => host.api.resources.registerPromptAssetAdapter(
            'external-skills',
            createPromptAssetAdapter(),
        )).toThrow(/undeclared|not declared|registration right/i);
        expect(host.registrations()).toEqual([]);
    });

    it('rejects a Prompt Asset adapter descriptor mismatch before commit', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.prompts',
            generation: 'generation-7',
            rights: [{
                family: 'promptAssets',
                localId: 'external-skills',
                target: { realm: 'daemon' },
                promptAssetDescriptor,
            }],
            isGenerationCurrent: () => true,
        });
        host.api.resources.registerPromptAssetAdapter('external-skills', createPromptAssetAdapter({
            ...promptAssetDescriptor,
            formatId: 'different_format_v1',
        }));

        expect(() => host.commit()).toThrow(/mismatched Prompt Asset adapter descriptor/i);
        expect(host.registrations()).toEqual([]);
    });

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
    ])('rejects a malformed connected-account runtime (%s) before publishing the activation', (_label, buildRuntime) => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.accounts', generation: '1',
            rights: [{ family: 'connectedAccountDescriptors', localId: 'account', target: daemonTarget }],
            isGenerationCurrent: () => true,
        });

        host.api.connectedAccounts.register('account', buildRuntime() as never);

        expect(() => host.commit()).toThrow(/invalid 'connectedAccountDescriptors\/account' runtime/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toEqual([expect.objectContaining({ code: 'plugin_activation_failed' })]);
    });

    it('rejects a non-string connected-account registration id before coercion or staging', () => {
        const coerceId = vi.fn(() => 'account');
        const host = createContributionRegistrationHost({
            pluginId: 'acme.accounts', generation: '1',
            rights: [{ family: 'connectedAccountDescriptors', localId: 'account', target: daemonTarget }],
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
                { family: 'actions', localId: 'run', target: daemonTarget },
                { family: 'agents', localId: 'assistant', target: daemonTarget },
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
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget }],
            isGenerationCurrent: () => true,
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

    it('publishes an immutable generation-relative session runner factory locator', () => {
        const mutableLocator: {
            module: string;
            export: string;
            runtimeApiVersion: 1;
        } = { ...sessionRunnerFactory };
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{
                family: 'agents',
                localId: 'assistant',
                target: daemonTarget,
                requiredFields: ['factory', 'sessionRunnerFactory'],
            }],
            isGenerationCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, {
            sessionRunnerFactory: mutableLocator,
        } as never);

        const [registration] = host.commit();
        expect(registration?.family).toBe('agents');
        if (registration?.family !== 'agents') throw new TypeError('Expected Agent registration');
        // The locator is captured when the activation publishes, so a later
        // author mutation cannot reach the published registration.
        mutableLocator.module = './agent/runtime/replaced';
        expect(registration.value.sessionRunnerFactory).toEqual(sessionRunnerFactory);
        expect(Object.isFrozen(registration.value.sessionRunnerFactory)).toBe(true);
    });

    it.each([
        ['absolute module', { ...sessionRunnerFactory, module: '/tmp/factory.js' }],
        ['traversal module', { ...sessionRunnerFactory, module: './../outside.js' }],
        ['non-normal module', { ...sessionRunnerFactory, module: './agent/./factory.js' }],
        ['invalid export', { ...sessionRunnerFactory, export: 'default factory' }],
        ['wrong runtime API', { ...sessionRunnerFactory, runtimeApiVersion: 2 }],
        ['unknown field', { ...sessionRunnerFactory, extra: true }],
    ])('rejects an invalid session runner factory locator (%s)', (_label, locator) => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{
                family: 'agents',
                localId: 'assistant',
                target: daemonTarget,
                requiredFields: ['factory', 'sessionRunnerFactory'],
            }],
            isGenerationCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, {
            sessionRunnerFactory: locator,
        } as never);

        expect(() => host.commit()).toThrow(/invalid 'agents\/assistant' runtime/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toEqual([expect.objectContaining({ code: 'plugin_activation_failed' })]);
    });

    it.each(['primary-first', 'auxiliary-first'] as const)(
        'aggregates primary and External Sessions fields into one Agent registration (%s)',
        (order) => {
            const host = createContributionRegistrationHost({
                pluginId: 'acme.runtime',
                generation: 'generation-7',
                rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget, requiredFields: ['factory', 'externalSessions'] }],
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

    it('publishes an auxiliary-only External Sessions contribution under the Agent identity', () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget, requiredFields: ['externalSessions'] }],
            isGenerationCurrent: () => true,
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
                generation: 'generation-7',
                rights: [{
                    family: 'agents',
                    localId: 'assistant',
                    target: daemonTarget,
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

    it('captures Provider binding fields when the activation publishes', () => {
        const originalPrepare = providerBinding.prepare;
        const originalMaterialize = providerBinding.materialize;
        const mutableProviderBinding = {
            ...providerBinding,
        };
        const host = createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget }],
            isGenerationCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, {
            providerBinding: mutableProviderBinding,
        });

        const committed = host.commit()[0];
        // Publication is the capture boundary: the author object may still be
        // mutated afterwards without reaching the published registration.
        mutableProviderBinding.adapterVersion = 2;
        mutableProviderBinding.prepare = () => ({ v: 1, materialization: 'configFile' });
        mutableProviderBinding.materialize = async () => ({ v: 1, kind: 'configFile', env: [], files: [] });
        expect(committed?.family).toBe('agents');
        if (committed?.family !== 'agents') throw new TypeError('Expected Agent registration');
        expect(committed.value.providerBinding).toMatchObject({
            v: 1,
            adapterVersion: 1,
            prepare: expect.any(Function),
            materialize: expect.any(Function),
        });
        expect(committed.value.providerBinding?.prepare).not.toBe(originalPrepare);
        expect(committed.value.providerBinding?.materialize).not.toBe(originalMaterialize);
        expect(committed.value.providerBinding?.prepare({
            v: 1,
            agentTargetKey: 'assistant',
            connectionId: 'connection-1',
        })).toEqual({ v: 1, materialization: 'spawnEnv' });
        expect(Object.isFrozen(committed.value.providerBinding)).toBe(true);
    });

    it('reads an accessor-backed Provider binding field exactly once at capture', () => {
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
            rights: [{ family: 'agents', localId: 'assistant', target: daemonTarget }],
            isGenerationCurrent: () => true,
        });

        host.api.agents.register('assistant', agentFactory, {
            providerBinding: providerBindingWithAccessor as AgentProviderBindingAdapter,
        });
        expect(prepareGetter).not.toHaveBeenCalled();

        const committed = host.commit()[0];
        expect(committed?.family).toBe('agents');
        if (committed?.family !== 'agents') throw new TypeError('Expected Agent registration');
        expect(prepareGetter).toHaveBeenCalledTimes(1);

        // The published façade retains the captured method, so exercising the
        // registration must never re-enter the author accessor.
        expect(committed.value.providerBinding?.prepare({
            v: 1,
            agentTargetKey: 'assistant',
            connectionId: 'connection-1',
        })).toEqual({ v: 1, materialization: 'spawnEnv' });
        expect(prepareGetter).toHaveBeenCalledTimes(1);
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
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
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
                { family: 'actions', localId: 'run', target: daemonTarget },
                { family: 'agents', localId: 'assistant', target: daemonTarget },
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
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
            isGenerationCurrent: () => current,
        });
        current = false;

        expect(() => host.api.actions.register('run', actionHandler)).toThrow(/generation/i);
        expect(host.registrations()).toEqual([]);
        expect(host.diagnostics()).toHaveLength(1);
    });

    it('rejects undeclared and retired background-service registrations before publication', () => {
        const undeclared = createContributionRegistrationHost({
            pluginId: 'acme.background', generation: 'generation-7',
            rights: [],
            isGenerationCurrent: () => true,
        });

        expect(() => undeclared.api.backgroundServices.register('indexer', async () => {}))
            .toThrow(/undeclared|not declared|registration right/i);
        expect(undeclared.registrations()).toEqual([]);

        let current = true;
        const retired = createContributionRegistrationHost({
            pluginId: 'acme.background', generation: 'generation-7',
            rights: [{ family: 'backgroundServices', localId: 'indexer', target: daemonTarget }],
            isGenerationCurrent: () => current,
        });
        current = false;

        expect(() => retired.api.backgroundServices.register('indexer', async () => {}))
            .toThrow(/generation/i);
        expect(retired.registrations()).toEqual([]);
    });

    it('rejects a client-artifact right at the daemon host boundary before staging', () => {
        expect(() => createContributionRegistrationHost({
            pluginId: 'acme.runtime',
            generation: 'generation-7',
            rights: [{
                family: 'voiceProviders',
                localId: 'conversation',
                target: {
                    realm: 'client',
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceRuntime',
                    exportName: 'activate',
                    platforms: ['web'],
                },
            }],
            isGenerationCurrent: () => true,
        })).toThrow(/realm|daemon|client/i);
    });

    it('unwinds staged host registrations when activation aborts', async () => {
        const host = createContributionRegistrationHost({
            pluginId: 'acme.cleanup', generation: 'generation-7',
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
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
            rights: [{ family: 'actions', localId: 'run', target: daemonTarget }],
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
