import { describe, expect, it } from 'vitest';
import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineProtocolObject, defineProtocolString, defineProtocolNumber } from '@happier-dev/plugin-sdk/protocol';
import { SessionTargetV1ProtocolSchema } from '@happier-dev/protocol/actions/sessionTargetV1';
import { readPluginActionReadObserver } from '@happier-dev/cli-common/plugins/registration/actionInputParser';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createTargetActionHostBindingResolver } from '../hostAccess/resolve';
import { resolveManifestHostAccessRequests } from '../hostAccess/manifestRequests';
import { createPluginInvocationServiceBinding, createPluginInvocationServicesFactory, createUnavailablePluginServicesFactory } from './services/factory';

import { createManagedPluginSourceCustody } from '../lifecycle/contributions/runtimeIdentity.testkit';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import { createTargetActionInvocationRegistry } from './targetActionRegistry';
import { createStablePluginConnectedAccountsHost } from './services/connectedAccounts';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';

describe('Resource read admission through an external authored Action', () => {
    it('observes only an admitted Action purpose through real credential authority without invoking plugin code', async () => {
        let runs = 0;
        const plugin = definePlugin({ id: 'acme.authority', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [{ id: 'github', capability: 'connectedAccounts', reason: 'Observe exact read authority',
                scope: { serviceRefs: [{ pluginId: 'acme.credentials', localId: 'github-account' }], operations: ['use'] } }], optional: [] },
            actions: { read: { title: 'Read', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe', readOnly: true,
                hostAccess: ['github'],
                inputSchema: defineProtocolObject({ kind: defineProtocolString() }, { policy: 'closed' }),
                run() { runs++; return null; } } } });
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: { activate: plugin.activate } });
        const handler = kit.registration('actions', 'read');
        if (typeof handler !== 'function') throw new Error('Expected external handler');
        const listeners = new Set<() => void>();
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { async read() { return { v: 1, bindings: [] }; }, async update(mutate) { return mutate({ v: 1, bindings: [] }); },
                subscribe() { return { dispose() {} }; } },
            async selectTarget() { throw new Error('Watching must never select'); }, async resolveTarget() { return null; },
            async materializeAccount() { throw new Error('Watching must never materialize'); },
            async projectTargetAccounts() { throw new Error('Watching must never enumerate accounts'); },
            async assertTargetAccountMaterializable() { throw new Error('Watching must never admit materialization'); },
            subscribeInvalidations(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
        });
        const host = createStablePluginConnectedAccountsHost(owner);
        const createServices = createPluginInvocationServicesFactory({ loggerSink: { write() {} }, connectedAccounts: host });
        const occurrenceId = 'authority-1' as PluginRuntimeOccurrenceId;
        const manifest = normalizePluginManifestV2(plugin.manifest);
        const registry = createTargetActionInvocationRegistry({
            actions: [{ pluginId: plugin.manifest.id, pluginVersion: '1.0.0', localId: 'read', occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('authority-generation'),
                definition: { ...manifest.contributes.actions[0]!,
                    hostAccessRequests: resolveManifestHostAccessRequests({ manifest, pluginId: manifest.id,
                        contribution: { family: 'actions', localId: 'read' }, requestIds: manifest.contributes.actions[0]!.hostAccess ?? [] }) }, handler }],
            createServices,
            resolveHostBinding: createTargetActionHostBindingResolver({
                createServiceBinding: (occurrence, id) => createPluginInvocationServiceBinding(occurrence, id),
            }), readCurrentPluginOccurrenceId: () => occurrenceId,
            resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId,
                appliedGeneration: action.occurrenceId }, resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        });
        let subscription: import('@happier-dev/plugin-sdk').Disposable | undefined;
        let retirements = 0;
        try {
            const admitted = await registry.invoke({ pluginId: plugin.manifest.id, localId: 'read', surface: 'ui', input: { kind: 'get' },
                readObservation: { authorityPurpose: 'github', invalidate() { throw new Error('Metadata is not authority retirement'); },
                    retire() { retirements++; }, accept(value) { subscription = value; } } });
            expect(admitted, JSON.stringify(admitted)).toMatchObject({ status: 'executed', value: null });
            expect(runs).toBe(0);
            await new Promise<void>(resolve => setImmediate(resolve));
            for (const listener of listeners) listener();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(retirements).toBe(1);
            expect(listeners.size).toBe(0);
        } finally { await subscription?.dispose(); registry.dispose(); host.retire(); await kit.dispose(); }
    });
    it('fences a supported nested Session operand before reads or observer installation', async () => {
        let reads = 0;
        let observations = 0;
        const plugin = definePlugin({ id: 'acme.resource-nested', version: '1.0.0',
            entrypoints: { daemon: './daemon.mjs' }, actions: { read: {
                title: 'Read sessions', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                sessionTarget: { field: 'payload.sessionId', cardinality: 'one' },
                inputSchema: defineProtocolObject({ payload: defineProtocolObject({
                    sessionId: SessionTargetV1ProtocolSchema,
                }, { policy: 'closed' }) }, { policy: 'closed' }),
                run() { reads++; return null; },
                observeRead() { observations++; return { dispose() {} }; },
            } } });
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: { activate: plugin.activate } });
        const declaration = normalizePluginManifestV2(plugin.manifest).contributes.actions[0]!;
        const handler = kit.registration('actions', 'read');
        if (typeof handler !== 'function') throw new Error('Expected committed external handler');
        const occurrenceId = 'nested-1' as PluginRuntimeOccurrenceId;
        const registry = createTargetActionInvocationRegistry({
            actions: [{ pluginId: plugin.manifest.id, pluginVersion: '1.0.0', occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('nested-generation'), localId: 'read',
                definition: declaration, handler, observeRead: readPluginActionReadObserver(handler) }],
            createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
            readCurrentPluginOccurrenceId: () => occurrenceId,
            resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        });
        const invocation = { pluginId: plugin.manifest.id, localId: 'read', surface: 'plugin' as const,
            requiredReadOnly: true as const, sessionId: 'selected-session', resourceSessionId: 'selected-session' };
        try {
            expect(await registry.invoke({ ...invocation, input: { payload: { sessionId: 'selected-session' } } }))
                .toMatchObject({ status: 'executed', value: null });
            for (const sessionId of ['foreign-session', { selector: 'workers', of: 'selected-session' }]) {
                const input = { payload: { sessionId } };
                expect(await registry.invoke({ ...invocation, input }))
                    .toMatchObject({ code: 'plugin_action_resource_session_mismatch', actionHandlerInvocation: 'notStarted' });
                expect(await registry.invoke({ ...invocation, input, readObservation: {
                    invalidate() {}, accept() { throw new Error('Foreign Session observer must not attach'); },
                } })).toMatchObject({ code: 'plugin_action_resource_session_mismatch', actionHandlerInvocation: 'notStarted' });
            }
            expect(reads).toBe(1);
            expect(observations).toBe(0);
            const { resourceSessionId: _resourceSessionId, ...ordinary } = invocation;
            for (const sessionId of ['self', { selector: 'workers', of: 'selected-session' }]) {
                expect(await registry.invoke({ ...ordinary, input: { payload: { sessionId } }, readObservation: {
                    invalidate() {}, accept() { throw new Error('Unresolved Session observer must not attach'); },
                } })).toMatchObject({ code: 'plugin_action_read_observation_session_unresolved', actionHandlerInvocation: 'notStarted' });
            }
            let subscription: { dispose(): void | Promise<void> } | undefined;
            expect(await registry.invoke({ ...ordinary, input: { payload: { sessionId: 'selected-session' } }, readObservation: {
                invalidate() {}, accept(next) { subscription = next; },
            } })).toMatchObject({ status: 'executed', value: null });
            expect(reads).toBe(1);
            expect(observations).toBe(1);
            await subscription?.dispose();
        } finally { registry.dispose(); await kit.dispose(); }
    });
    it('reports a legacy snapshot-only Action as unobservable before a read ceiling is considered', async () => {
        const registry = createTargetActionInvocationRegistry({
            actions: [{ pluginId: 'acme.legacy', pluginVersion: '1.0.0', occurrenceId: 'legacy-1' as PluginRuntimeOccurrenceId,
                sourceCustody: createManagedPluginSourceCustody('legacy-generation'), localId: 'read',
                definition: { id: 'read', dangerLevel: 'safe', scopes: ['global'], surfaces: ['plugin'] },
                handler() { throw new Error('Observation must not execute a snapshot-only handler'); } }],
            createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
            readCurrentPluginOccurrenceId: () => 'legacy-1' as PluginRuntimeOccurrenceId,
            resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        });
        try {
            expect(await registry.invoke({ pluginId: 'acme.legacy', localId: 'read', input: null, surface: 'plugin', requiredReadOnly: true,
                readObservation: { invalidate() {}, accept() { throw new Error('Unexpected subscription'); } } }))
                .toMatchObject({ status: 'unavailable', code: 'plugin_action_read_observation_unavailable', actionHandlerInvocation: 'notStarted' });
        } finally { registry.dispose(); }
    });
    it('admits only normalized declared reads and observes without invoking the read handler', async () => {
        let reads = 0;
        let writes = 0;
        let subscriptions = 0;
        let credentialBindings = 0;
        let observerGate: Promise<void> | undefined;
        let observerStarted = () => {};
        let notify: (() => void) | undefined;
        let observerContext: PluginInvocationContext | undefined;
        let retireObservedAuthority = () => {};
        let retireFromAuthor = () => {};
        let authorityRetirements = 0;
        let retireDuringAttachment = false;
        const unavailableServices = createUnavailablePluginServicesFactory();
        const listeners = new Set<() => void>();
        const plugin = definePlugin({ id: 'acme.resource-source', version: '1.0.0',
            entrypoints: { daemon: './daemon.mjs' }, actions: { state: {
                title: 'State', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'writesLocal',
                confirmation: { title: 'Change state', confirmLabel: 'Change' },
                confirmationWhen: { op: 'eq', path: 'kind', value: 'configure' },
                readOnly: { op: 'or', any: [{ op: 'eq', path: 'kind', value: 'get' }, { op: 'eq', path: 'kind', value: 'list' }] },
                sessionTarget: { field: 'sessionId', cardinality: 'one' },
                inputSchema: defineProtocolObject({ kind: defineProtocolString(), sessionId: defineProtocolString() }, { policy: 'closed' }),
                resultSchema: defineProtocolObject({ value: defineProtocolNumber() }, { policy: 'closed' }),
                run(input) { if (input.kind === 'configure') writes++; else reads++; return { value: 42 }; },
                async observeRead(_input, invalidate, context) {
                    retireFromAuthor = () => invalidate.retire();
                    observerStarted();
                    if (observerGate) await observerGate;
                    observerContext = context;
                    subscriptions++;
                    listeners.add(invalidate);
                    if (retireDuringAttachment) retireObservedAuthority();
                    return { dispose() { listeners.delete(invalidate); subscriptions--; } };
                },
            } } });
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: { activate: plugin.activate } });
        const declaration = normalizePluginManifestV2(plugin.manifest).contributes.actions[0]!;
        const handler = kit.registration('actions', 'state');
        if (typeof handler !== 'function') throw new Error('Expected committed external handler');
        const registry = createTargetActionInvocationRegistry({
            actions: [{ pluginId: plugin.manifest.id, pluginVersion: '1.0.0', occurrenceId: 'source-1' as PluginRuntimeOccurrenceId,
                sourceCustody: createManagedPluginSourceCustody('source-generation'), localId: 'state', definition: declaration,
                handler, observeRead: readPluginActionReadObserver(handler) }],
            createServices(seed, binding) {
                retireObservedAuthority = seed.retireReadObservation ?? (() => {});
                return unavailableServices(seed, binding);
            }, resolveHostBinding: createTargetActionHostBindingResolver(),
            // Persistent credential-operation custody is outside this registry.
            bindConnectedAccountActionOperation: async () => {
                credentialBindings++;
                return { exactPurposeBindingSubjectId: 'selected-credential-operation', dispose() { credentialBindings--; } };
            },
            readCurrentPluginOccurrenceId: () => 'source-1' as PluginRuntimeOccurrenceId,
            resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId, desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        });
        const controller = new AbortController();
        const invocation = { pluginId: plugin.manifest.id, localId: 'state', surface: 'plugin' as const,
            signal: controller.signal, requiredReadOnly: true as const, sessionId: 'selected-session' };
        try {
            expect(await registry.invoke({ ...invocation, input: { kind: 'get', sessionId: 'selected-session' } })).toMatchObject({ status: 'executed', value: { value: 42 } });
            expect(await registry.invoke({ ...invocation, input: { kind: 'configure', sessionId: 'selected-session' } })).toMatchObject({ code: 'plugin_action_read_only_required', actionHandlerInvocation: 'notStarted' });
            expect(await registry.invoke({ ...invocation, input: { kind: 'get', sessionId: 'selected-session', unexpected: true } })).toMatchObject({ status: 'invalid' });
            expect(await registry.invoke({ ...invocation, resourceSessionId: 'selected-session', input: { kind: 'get', sessionId: 'other-session' } }))
                .toMatchObject({ code: 'plugin_action_resource_session_mismatch', actionHandlerInvocation: 'notStarted' });
            expect(reads).toBe(1);
            expect(writes).toBe(0);
            expect(credentialBindings).toBe(0);
            let invalidations = 0;
            expect(await registry.invoke({ ...invocation, input: { kind: 'get', sessionId: 'selected-session' }, readObservation: {
                invalidate() { invalidations++; }, retire() { authorityRetirements++; },
                accept(subscription) { notify = () => subscription.dispose(); },
            } })).toMatchObject({ status: 'executed', value: null });
            expect(reads).toBe(1);
            expect(subscriptions).toBe(1);
            expect(credentialBindings).toBe(1);
            expect(observerContext?.session).toEqual({ id: 'selected-session' });
            expect(observerContext?.signal.aborted).toBe(false);
            for (const listener of listeners) listener();
            expect(invalidations).toBe(1);
            expect(authorityRetirements).toBe(0);
            retireFromAuthor();
            await Promise.resolve();
            await Promise.resolve();
            expect(authorityRetirements).toBe(1);
            expect(invalidations).toBe(1);
            expect(subscriptions).toBe(0);
            expect(credentialBindings).toBe(0);
            expect(observerContext?.signal.aborted).toBe(true);
            controller.abort();
            await Promise.resolve();
            await Promise.resolve();
            expect(subscriptions).toBe(0);
            expect(credentialBindings).toBe(0);
            expect(observerContext?.signal.aborted).toBe(true);
            notify?.();
            expect(subscriptions).toBe(0);
            retireDuringAttachment = true;
            expect(await registry.invoke({ ...invocation, signal: new AbortController().signal,
                input: { kind: 'get', sessionId: 'selected-session' }, readObservation: {
                    invalidate() {}, retire() { authorityRetirements++; },
                    accept() { throw new Error('Withdrawn authority must not attach'); },
                } })).toMatchObject({ code: 'plugin_action_generation_retired' });
            await Promise.resolve();
            expect(authorityRetirements).toBe(2);
            expect(subscriptions).toBe(0);
            expect(credentialBindings).toBe(0);
            retireDuringAttachment = false;
            let releaseObserver = () => {};
            observerGate = new Promise<void>(resolve => { releaseObserver = resolve; });
            const started = new Promise<void>(resolve => { observerStarted = resolve; });
            const late = new AbortController();
            const pending = registry.invoke({ ...invocation, signal: late.signal,
                input: { kind: 'get', sessionId: 'selected-session' }, readObservation: {
                    invalidate() {}, accept() { throw new Error('Canceled observer must not be retained'); },
                } });
            await started;
            late.abort();
            expect(await pending).toMatchObject({ status: 'unavailable' });
            releaseObserver();
            await Promise.resolve();
            await Promise.resolve();
            expect(subscriptions).toBe(0);
            expect(credentialBindings).toBe(0);
        } finally { registry.dispose(); await kit.dispose(); }
    });
});
