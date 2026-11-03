import { afterEach, expect, it, vi } from 'vitest';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { readPluginActionInputParser, readPluginActionReadObserver } from '@happier-dev/cli-common/plugins/registration/actionInputParser';
import { createPluginRegistrationScope } from '@/sync/domains/plugins/registrationScope';
import { evaluatePluginUiCommonJsBundle } from './commonJsEvaluator';
import { createLazyAccountExecutable } from './lazyAccountExecutable';

afterEach(() => vi.unstubAllGlobals());

function fixture(held = false) {
    const target = { realm: 'account' as const, artifactId: 'runtime', exportName: 'activate', platform: 'web' as const };
    const execution = { target: 'account', account: { artifactId: target.artifactId, exportName: target.exportName } } as const;
    const contributes = PluginContributesV2Schema.parse({
        actions: ['echo', 'plain'].map(id => ({ id, title: id, execution, scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe' })),
        resources: [{ id: 'context', source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global', execution }],
        connectedAccountDescriptors: [{ id: 'account', title: 'Account', authentication: {
            account: execution.account, defaultModeId: 'device',
            modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
        } }],
    });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = held ? new Promise<void>(resolve => { release = resolve; }) : undefined;
    const boundary = { evaluations: 0, activations: 0, cleanups: 0, observations: 0, unavailable: false, entered, gate };
    vi.stubGlobal('__lazyAccountExecutable', boundary);
    const bytes = new TextEncoder().encode(`
        const fixture = globalThis.__lazyAccountExecutable;
        fixture.evaluations++;
        exports.activate = async api => {
            fixture.activations++;
            const echo = input => input;
            Object.defineProperty(echo, 'happierProtocolActionInputParser', {
                value: input => ({ success: true, data: { transformed: input } })
            });
            api.actions.register('echo', echo, { observeRead: () => {
                fixture.observations++; return { dispose() {} };
            } });
            api.actions.register('plain', echo);
            api.resources.registerDynamicResource('context', { read: options => JSON.stringify(options.context),
                observe: () => { fixture.observations++; return { dispose() {} }; } });
            api.connectedAccounts.register('account', { authentication: { modes: {
                device: { kind: 'oauthDeviceCode',
                    begin: async () => ({ status: 'awaitingDeviceAuthorization', verificationUri: 'https://auth.example.test/device',
                        userCode: 'ABCD', expiresAtMs: 90000, pollIntervalMs: 5000 }),
                    poll: async () => ({ status: 'pending' }), cancel: async () => undefined,
                },
            } } });
            fixture.entered();
            if (fixture.gate) await fixture.gate;
            return () => { fixture.cleanups++; };
        };
    `);
    const lazy = createLazyAccountExecutable({ pluginId: 'acme.lazy', contributes, target, isCurrent: () => true,
        async load() {
            if (boundary.unavailable) return { ok: false, code: 'loader_backend_unavailable', diagnostics: ['commonjs_evaluator_unavailable'] };
            return { ok: true, exported: evaluatePluginUiCommonJsBundle({ bytes,
                identity: { pluginId: 'acme.lazy', artifactId: 'runtime', digest: 'fixture' }, requestedExport: 'activate' }) };
        } });
    const scope = createPluginRegistrationScope({ pluginId: 'acme.lazy', target,
        rights: derivePluginAccountContributionRegistrationRights(contributes, target) });
    const dispose = lazy.activate(scope.api);
    const registrations = scope.commit();
    return { ...lazy, boundary, registrations, started, release: () => release(),
        async dispose() { await scope.dispose(); await dispose(); } };
}

it('leaves descriptors unevaluated, shares real evaluation, and exposes exact parser/observer metadata after preparation', async () => {
    const state = fixture();
    try {
        expect(state.registrations).toHaveLength(4);
        expect(state.boundary.evaluations).toBe(0);
        const echo = state.registrations.find(value => value.localId === 'echo')!;
        const plain = state.registrations.find(value => value.localId === 'plain')!;
        const [prepared, repeated, nonObserved] = await Promise.all([
            state.prepareRegistration(echo), state.prepareRegistration(echo), state.prepareRegistration(plain),
        ]);
        expect(prepared).toBe(repeated);
        expect(state.boundary.evaluations).toBe(1);
        expect(state.boundary.activations).toBe(1);
        expect(readPluginActionInputParser(prepared.value)?.('input')).toEqual({ success: true, data: { transformed: 'input' } });
        expect(readPluginActionReadObserver(prepared.value)).toBeTypeOf('function');
        expect(readPluginActionReadObserver(nonObserved.value)).toBeUndefined();
        const resource = state.registrations.find(value => value.family === 'resources')!;
        const runtime = resource.value as import('@happier-dev/plugin-sdk/resources').PluginDynamicResourceRuntime;
        const options: import('@happier-dev/plugin-sdk/resources').PluginDynamicResourceInvocationOptionsV1 = {
            signal: new AbortController().signal, context: { kind: 'global' },
            resources: { describe() { throw new Error('Unused'); }, read: async () => { throw new Error('Unused'); },
                watch: async () => { throw new Error('Unused'); } },
            readAction: async () => { throw new Error('Unused'); }, observeAction: async () => { throw new Error('Unused'); },
        };
        expect(await runtime.read(options)).toBe(JSON.stringify(options.context));
        const observation = await runtime.observe(() => {}, options);
        expect(state.boundary.observations).toBe(1);
        await observation.dispose();
        expect(state.boundary.evaluations).toBe(1);
    } finally { await state.dispose(); }
    expect(state.boundary.cleanups).toBe(1);
});

it('publishes a portable authentication callback through the same lazy Account activation', async () => {
    const state = fixture();
    try {
        const declared = state.registrations.find(value => value.family === 'connectedAccountDescriptors');
        expect(declared).toBeDefined();
        expect(state.boundary.evaluations).toBe(0);
        const prepared = await state.prepareRegistration(declared!);
        expect(prepared.family).toBe('connectedAccountDescriptors');
        const runtime = prepared.value as Parameters<import('@happier-dev/plugin-sdk').PluginAccountApi['connectedAccounts']['register']>[1];
        expect(runtime.authentication.modes.device?.kind).toBe('oauthDeviceCode');
        expect(state.boundary.evaluations).toBe(1);
        expect(state.boundary.activations).toBe(1);
    } finally { await state.dispose(); }
});

it('returns the loader refusal and lets the next explicit operation retry without evaluating unused code', async () => {
    const state = fixture();
    try {
        state.boundary.unavailable = true;
        await expect(state.prepareRegistration(state.registrations[0]!)).rejects.toMatchObject({ code: 'loader_backend_unavailable' });
        expect(state.boundary.evaluations).toBe(0);
        state.boundary.unavailable = false;
        await state.prepareRegistration(state.registrations[0]!);
        expect(state.boundary.evaluations).toBe(1);
        expect(state.boundary.activations).toBe(1);
    } finally { await state.dispose(); }
});

it('cleans up a real activation that settles after its Account target retires', async () => {
    const state = fixture(true);
    const preparation = state.prepareRegistration(state.registrations[0]!);
    const refused = expect(preparation).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
    await state.started;
    await state.dispose();
    state.release();
    await refused;
    expect(state.boundary.evaluations).toBe(1);
    expect(state.boundary.cleanups).toBe(1);
});
