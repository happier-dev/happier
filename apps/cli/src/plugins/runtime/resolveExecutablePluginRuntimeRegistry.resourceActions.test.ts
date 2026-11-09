import { describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginInvocationCaller, type Disposable, type JsonValue } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import type { PluginActionReadInvalidation } from '@happier-dev/plugin-sdk/actions';

describe('external Resource Action composition', () => {
    it('aborts a standalone Resource acquisition on explicit registered Action authority retirement without reacquiring on refresh', async () => {
        let holdNative = false;
        let releaseNative = () => {};
        let nativeStarted = () => {};
        let nativeReads = 0;
        let value = 'original';
        let readSignal: AbortSignal | undefined;
        const observations = new Set<PluginActionReadInvalidation>();
        const source = definePlugin({ id: 'acme.standalone-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
            state: { title: 'Read source', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                async run() {
                    nativeReads++;
                    const selectedValue = value;
                    if (holdNative) {
                        const pending = new Promise<void>(resolve => { releaseNative = resolve; });
                        nativeStarted();
                        await pending;
                    }
                    return { value: selectedValue };
                },
                observeRead(_input, invalidate) {
                    observations.add(invalidate);
                    return { dispose() { observations.delete(invalidate); } };
                },
            },
        } });
        const consumer = definePlugin({ id: 'acme.standalone-consumer', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, resources: {
            summary: { source: 'dynamic', scope: 'global', kind: 'config', contentType: 'application/json', runtime: {
                async read(options) {
                    readSignal = options.signal;
                    const observation = await options.observeAction(source.actionContracts.state, {}, () => {}, { signal: options.signal });
                    try { return JSON.stringify(await options.readAction(source.actionContracts.state, {}, { signal: options.signal })); }
                    finally { await observation.dispose(); }
                },
                observe() { return { dispose() {} }; },
            } },
        } });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [source, consumer].map(plugin => ({ manifest: plugin.manifest,
                files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) })),
            runtimeOptions: { scopedActionRuntime: { credentials: { token: 'fixture-standalone-observer-token', encryption: null },
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }) } },
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            })); },
        });
        const runtime = fixture.registry;
        const occurrence = runtime.readPluginOccurrenceId?.(consumer.manifest.id);
        if (!occurrence) throw new Error('Missing admitted Resource occurrence');
        const read = () => runtime.readUiResource!({ callerPluginId: consumer.manifest.id,
            expectedCallerOccurrenceId: occurrence, resourceId: 'summary' });
        try {
            await read();
            expect(observations.size).toBe(0);
            const beforeRead = nativeReads;
            holdNative = true;
            const started = new Promise<void>(resolve => { nativeStarted = resolve; });
            const pending = read().then(result => ({ result }), error => ({ error }));
            await started;
            const signal = readSignal!;
            const invalidate = [...observations][0]!;
            invalidate();
            await Promise.resolve();
            expect(signal.aborted).toBe(false);
            expect(nativeReads).toBe(beforeRead + 1);
            invalidate.retire();
            expect(signal.aborted).toBe(true);
            releaseNative();
            expect(await pending).toMatchObject({ error: { code: 'plugin_resource_aborted' } });
            expect(observations.size).toBe(0);
            value = 'replacement';
            const replacementStarted = new Promise<void>(resolve => { nativeStarted = resolve; });
            const replacementRead = read();
            await replacementStarted;
            const replacementSignal = readSignal!;
            invalidate.retire();
            expect(replacementSignal.aborted).toBe(false);
            releaseNative();
            const replacement = await replacementRead;
            expect(JSON.parse(new TextDecoder().decode(replacement.bytes))).toEqual({ ok: true, result: { value: 'replacement' } });
            expect(nativeReads).toBe(beforeRead + 2);
            expect(observations.size).toBe(0);
        } finally {
            releaseNative();
            await fixture.dispose();
        }
    });

    it('retires credential-backed Action dependencies through the real Resource owner while metadata stays quiet and late native bytes are fenced', async () => {
        const sourceId = 'acme.credential-resource-source';
        const service = { pluginId: sourceId, localId: 'accounts' };
        const account = { service, accountId: 'selected-account' };
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: 'accounts', title: 'Source Account', authentication: {
                defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }] }],
            },
        });
        const purpose = { consumer: { pluginId: sourceId, localId: 'state' }, purpose: 'upstream' };
        let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1,
            bindings: [{ purpose, target: { kind: 'account', account } }] };
        let profile: QualifiedConnectedAccountProfileV4 = {
            ref: account, revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            configurationRevision: 'configuration-one', authenticationModeId: 'token', configurationReady: true,
            status: 'connected', scopes: ['read'], displayName: 'Selected source Account',
        };
        let credentialAvailable = true;
        let nativeValue = 'old-authority';
        let nativeReads = 0;
        let producerReads = 0;
        let installedWatches = 0;
        const acquisitionsAtObservation: number[] = [];
        let publicMetadataDeliveries = 0;
        let resourceInvalidations = 0;
        let resourceObservationRetirements = 0;
        const resourceSignals: AbortSignal[] = [];
        const actionSignals: AbortSignal[] = [];
        const bindingListeners = new Set<() => void>();
        const profileListeners = new Set<() => void>();
        let sourceRowRevision = 'source-row-one';
        const sourceRowListeners = new Set<() => void>();
        let holdNative = false;
        const nativeGate: { release?: () => void } = {};
        const releaseNative = () => nativeGate.release?.();
        let nativeStarted: (() => void) | undefined;
        const nativePending = new Promise<void>(resolve => { nativeStarted = resolve; });
        // Only persisted selection and credential-free profile projection are boundaries.
        // The real purpose owner classifies presentation versus authority changes.
        const credentialOwner = createConnectedAccountPurposeBindingOwner({
            store: {
                async read() { return bindings; },
                async update(mutate) {
                    bindings = mutate(bindings);
                    for (const listener of bindingListeners) listener();
                    return bindings;
                },
                subscribe(listener) {
                    bindingListeners.add(listener);
                    return { dispose() { bindingListeners.delete(listener); } };
                },
            },
            async selectTarget() { throw new Error('This read never requests credential selection'); },
            resolveTarget: createPurposeTargetResolver({
                available: true,
                async resolveService() { return { service, authentication: descriptor.authentication }; },
                async listAccounts() { return credentialAvailable ? [profile] : []; },
            }),
            async materializeAccount() { throw new Error('This read never materializes credentials'); },
            async projectTargetAccounts() { throw new Error('This exact-purpose read never lists Accounts'); },
            async assertTargetAccountMaterializable() { throw new Error('This read never materializes a listed Account'); },
            subscribeInvalidations(listener) {
                profileListeners.add(listener);
                return { dispose() { profileListeners.delete(listener); } };
            },
        });
        const invalidateProfiles = () => {
            for (const listener of [...profileListeners]) listener();
        };
        const source = definePlugin({ id: sourceId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            hostAccess: { required: [{ id: 'upstream', capability: 'connectedAccounts', reason: 'Read the selected source Account.',
                scope: { serviceRefs: ['accounts'], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
            connectedAccountDescriptors: { accounts: {
                declaration: { title: descriptor.title, authentication: descriptor.authentication },
                runtime: {
                    authentication: { modes: { token: { kind: 'manual',
                        async complete() { throw new Error('This read never authenticates'); },
                    } } },
                    async refresh() { throw new Error('This read never refreshes credentials'); },
                    async revoke() { throw new Error('This read never revokes credentials'); },
                    async status() { throw new Error('This read never probes credential health'); },
                    async materialize() { throw new Error('This read never materializes credentials'); },
                },
            } },
            actions: { state: { title: 'Read source', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                hostAccess: ['upstream'],
                async run(_input, context): Promise<JsonValue> {
                    const binding = await context.services.connectedAccounts.getBinding('upstream');
                    if (!binding) return { kind: 'unavailable' as const };
                    nativeReads++;
                    const selectedValue = nativeValue;
                    if (holdNative) {
                        nativeStarted?.();
                        await new Promise<void>(resolve => { nativeGate.release = resolve; });
                    }
                    return { kind: 'ready' as const, value: selectedValue };
                },
                observeRead(_input, invalidate, context) {
                    installedWatches++;
                    acquisitionsAtObservation.push(nativeReads);
                    actionSignals.push(context.signal);
                    const admittedRevision = sourceRowRevision;
                    const onSourceRow = () => {
                        if (sourceRowRevision !== admittedRevision) invalidate.retire();
                        else invalidate();
                    };
                    sourceRowListeners.add(onSourceRow);
                    const credential = context.services.connectedAccounts.watch('upstream', () => { publicMetadataDeliveries++; });
                    return { async dispose() { sourceRowListeners.delete(onSourceRow); await credential.dispose(); } };
                },
            } },
        });
        const action = source.actionContracts.state;
        const consumer = definePlugin({ id: 'acme.credential-resource-consumer', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
            dependency: { title: 'Observe exact source', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                run() { throw new Error('Observation must not execute its dependency Action'); },
                async observeRead(_input, invalidate, context) {
                    return await context.services.actions.observe(action, {}, invalidate, { signal: context.signal });
                },
            },
        }, resources: {
            summary: { source: 'dynamic', scope: 'global', kind: 'config', contentType: 'application/json', runtime: {
                async read(options) {
                    producerReads++;
                    const result = await options.readAction(action, {}, { signal: options.signal });
                    return JSON.stringify(result);
                },
                async observe(invalidate, options) {
                    resourceSignals.push(options.signal);
                    options.signal.addEventListener('abort', () => { resourceObservationRetirements++; }, { once: true });
                    return await options.observeAction({ pluginId: 'acme.credential-resource-consumer', localId: 'dependency' }, {},
                        () => { resourceInvalidations++; invalidate(); }, { signal: options.signal });
                },
            } },
        } });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [source, consumer].map(plugin => ({ manifest: plugin.manifest,
                files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) })),
            runtimeOptions: { connectedAccounts: credentialOwner,
                scopedActionRuntime: { credentials: { token: 'fixture-credential-observer-token', encryption: null },
                    actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }) },
            },
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            })); },
        });
        const runtime = fixture.registry;
        const occurrence = runtime.readPluginOccurrenceId?.(consumer.manifest.id);
        if (!occurrence) throw new Error('Missing admitted Resource occurrence');
        const request = { callerPluginId: consumer.manifest.id, expectedCallerOccurrenceId: occurrence, resourceId: 'summary' };
        const read = async () => {
            const result = await runtime.readUiResource?.(request);
            return JSON.parse(new TextDecoder().decode(result?.bytes));
        };
        const openWatch = () => runtime.openUiResourceWatch?.({ ...request, subscriptionId: 'credential-watch' });
        const pollExpiredWatch = async () => {
            expect(await runtime.pollUiResourceWatch?.({ ...request, subscriptionId: 'credential-watch' }))
                .toMatchObject({ status: 'event', event: { kind: 'error', code: 'expired_resource' } });
        };
        try {
            const initialBaseline = await openWatch();
            await vi.waitFor(() => expect(profileListeners.size).toBe(1));
            await vi.waitFor(() => expect(publicMetadataDeliveries).toBe(1));
            // The real UI transport acquires one baseline after attaching its observer.
            // The observer's initial public resync must not acquire a second one.
            expect({ nativeReads, producerReads, installedWatches, acquisitionsAtObservation, resourceInvalidations, resourceObservationRetirements,
                resourceSignals: resourceSignals.map(signal => signal.aborted), actionSignals: actionSignals.map(signal => signal.aborted) })
                .toEqual({ nativeReads: 1, producerReads: 1, installedWatches: 1, acquisitionsAtObservation: [0], resourceInvalidations: 0, resourceObservationRetirements: 0,
                    resourceSignals: [false], actionSignals: [false] });
            expect(resourceInvalidations).toBe(0);
            expect(resourceObservationRetirements).toBe(0);
            const beforeMetadata = nativeReads;
            const firstActionSignal = actionSignals[0]!;
            const firstResourceSignal = resourceSignals[0]!;
            profile = { ...profile, displayName: 'Renamed source Account' };
            invalidateProfiles();
            await vi.waitFor(() => expect(publicMetadataDeliveries).toBe(2));
            profile = { ...profile, lastUsedAt: 123 };
            invalidateProfiles();
            await vi.waitFor(() => expect(publicMetadataDeliveries).toBe(3));
            expect(nativeReads).toBe(beforeMetadata);
            expect(resourceInvalidations).toBe(0);
            expect(resourceObservationRetirements).toBe(0);
            expect(firstActionSignal.aborted).toBe(false);
            expect(firstResourceSignal.aborted).toBe(false);
            expect(installedWatches).toBe(1);

            holdNative = true;
            const lateRead = read();
            const lateOutcome = lateRead.then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }));
            await nativePending;
            profile = { ...profile, credentialRevision: 'csr_bcdefghijklmnopqrstuvw' };
            invalidateProfiles();
            await vi.waitFor(() => expect(firstActionSignal.aborted).toBe(true));
            await vi.waitFor(() => expect(firstResourceSignal.aborted).toBe(true));
            expect(resourceObservationRetirements).toBe(1);
            credentialAvailable = false;
            holdNative = false;
            releaseNative();
            expect(await lateOutcome).toMatchObject({ kind: 'error' });
            await pollExpiredWatch();
            expect(profileListeners.size).toBe(0);
            expect(installedWatches).toBe(1);
            // A raw registry caller explicitly follows the same-id reconnect contract.
            // The client Resource store owns automatically doing this for mounted demand.
            const unavailableBaseline = await openWatch();
            await vi.waitFor(() => expect(installedWatches).toBe(2));
            expect(profileListeners.size).toBe(1);
            expect(unavailableBaseline?.digest).not.toBe(initialBaseline?.digest);
            const unavailable = await read();
            expect(unavailable).toEqual({ ok: true, result: { kind: 'unavailable' } });
            expect(JSON.stringify(unavailable)).not.toContain('old-authority');

            credentialAvailable = true;
            nativeValue = 'replacement-authority';
            profile = { ...profile, status: 'connected' };
            invalidateProfiles();
            await pollExpiredWatch();
            expect(profileListeners.size).toBe(0);
            const replacementBaseline = await openWatch();
            await vi.waitFor(() => expect(installedWatches).toBe(3));
            expect(replacementBaseline?.digest).not.toBe(unavailableBaseline?.digest);
            expect(await read()).toEqual({ ok: true, result: { kind: 'ready', value: 'replacement-authority' } });
            expect(runtime.readPluginOccurrenceId?.(consumer.manifest.id)).toBe(occurrence);
            expect(profileListeners.size).toBe(1);
            const rowActionSignal = actionSignals.at(-1)!;
            const rowResourceSignal = resourceSignals.at(-1)!;
            nativeValue = 'fresh-same-authority';
            for (const notify of [...sourceRowListeners]) notify();
            expect(await runtime.pollUiResourceWatch?.({ ...request, subscriptionId: 'credential-watch' }))
                .toMatchObject({ status: 'event', event: { kind: 'invalidated' } });
            expect(rowActionSignal.aborted).toBe(false);
            expect(rowResourceSignal.aborted).toBe(false);
            expect(await read()).toEqual({ ok: true, result: { kind: 'ready', value: 'fresh-same-authority' } });
            sourceRowRevision = 'source-row-two';
            const retiredRowCallbacks = [...sourceRowListeners];
            for (const notify of retiredRowCallbacks) notify();
            expect(rowActionSignal.aborted).toBe(true);
            expect(rowResourceSignal.aborted).toBe(true);
            await pollExpiredWatch();
            expect(sourceRowListeners.size).toBe(0);
            holdNative = true;
            nativeGate.release = undefined;
            nativeValue = 'replacement-source-row';
            const rowReopen = openWatch();
            await vi.waitFor(() => expect(nativeGate.release).toBeDefined());
            expect(installedWatches).toBe(4);
            holdNative = false;
            releaseNative();
            await rowReopen;
            expect(await read()).toEqual({ ok: true, result: { kind: 'ready', value: 'replacement-source-row' } });
            const currentResourceSignal = resourceSignals.at(-1)!;
            const currentActionSignal = actionSignals.at(-1)!;
            for (const notify of retiredRowCallbacks) notify();
            expect(currentResourceSignal.aborted).toBe(false);
            expect(currentActionSignal.aborted).toBe(false);
            expect(installedWatches).toBe(4);
            runtime.closeUiResourceWatch?.({ callerPluginId: consumer.manifest.id, subscriptionId: 'credential-watch' });
            await vi.waitFor(() => expect(profileListeners.size).toBe(0));
            expect(bindingListeners.size).toBe(0);
            expect(sourceRowListeners.size).toBe(0);
        } finally { holdNative = false; releaseNative(); await fixture.dispose(); }
    });

    it.each(['resolve', 'reject'] as const)('preserves the Resource plugin caller, refuses write operands and owns qualified observation disposal (%s)', async cleanupOutcome => {
        let reads = 0;
        let writes = 0;
        let value = 1;
        let invalidations = 0;
        let caller: PluginInvocationCaller | undefined;
        let observerCaller: PluginInvocationCaller | undefined;
        const observers = new Map<string, Set<() => void>>();
        let finishCleanup = () => {};
        const cleanupFailure = new Error('Selected observer cleanup failed');
        const cleanupGate = new Promise<void>((resolve, reject) => {
            finishCleanup = () => cleanupOutcome === 'reject' ? reject(cleanupFailure) : resolve();
        });
        void cleanupGate.catch(() => {});
        let ordinarySubscription: Disposable | undefined;
        let cancelOrdinary = () => {};
        let installed = () => {};
        const installation = new Promise<void>(resolve => { installed = resolve; });
        const source = definePlugin({ id: 'acme.resource-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
            state: { title: 'State', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'writesLocal',
                confirmation: { title: 'Change state', confirmLabel: 'Change' },
                confirmationWhen: { op: 'eq', path: 'kind', value: 'configure' },
                readOnly: { op: 'eq', path: 'kind', value: 'get' },
                inputSchema: defineProtocolObject({ kind: defineProtocolString(), key: defineProtocolString() }, { policy: 'closed' }),
                run(input, context) { caller = context.caller; if (input.kind === 'configure') writes++; else reads++; return { value }; },
                observeRead(input, invalidate, context) {
                    observerCaller = context.caller;
                    const key = String(input.key);
                    const selected = observers.get(key) ?? new Set<() => void>();
                    selected.add(invalidate); observers.set(key, selected);
                    installed();
                    return { async dispose() {
                        try { await cleanupGate; }
                        finally { selected.delete(invalidate); if (!selected.size) observers.delete(key); }
                    } };
                },
            },
        } });
        const action = source.actionContracts.state;
        const consumer = definePlugin({ id: 'acme.resource-consumer', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
            dependency: { title: 'Read dependency', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                run() { throw new Error('Dependency observation must not execute the Action'); },
                async observeRead(_input, invalidate, context) {
                    await expect(context.services.actions.observe(action, { kind: 'configure', key: 'selected' }, invalidate))
                        .rejects.toMatchObject({ code: 'plugin_action_read_only_required' });
                    await expect(context.services.actions.observe(action, { kind: 'get', key: 'selected' }, invalidate, {
                        expectedExecutionRouting: { serverIdentityId: 'srv_resource_fixture', machineId: 'foreign-machine', pluginId: source.manifest.id },
                    })).rejects.toMatchObject({ code: 'plugin_action_execution_origin_mismatch' });
                    const controller = new AbortController();
                    cancelOrdinary = () => controller.abort();
                    ordinarySubscription = await context.services.actions.observe(action, { kind: 'get', key: 'selected' }, invalidate,
                        { signal: AbortSignal.any([context.signal, controller.signal]) });
                    return ordinarySubscription;
                },
            },
        }, resources: {
            summary: { source: 'dynamic', scope: 'global', kind: 'config', contentType: 'application/json', runtime: {
                async read(options) {
                    const read = await options.readAction(action, { kind: 'get', key: 'selected' }, { signal: options.signal });
                    const write = await options.readAction(action, { kind: 'configure', key: 'selected' });
                    return JSON.stringify({ read, write });
                },
                async observe(invalidate, options) {
                    return await options.observeAction({ pluginId: 'acme.resource-consumer', localId: 'dependency' }, {}, () => { invalidations++; invalidate(); }, { signal: options.signal });
                },
            } },
        } });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [source, consumer].map(plugin => ({ manifest: plugin.manifest,
                files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) })),
            runtimeOptions: {
                scopedActionRuntime: { credentials: { token: 'fixture-resource-observer-token', encryption: null },
                    actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => null, allowEnvironmentOverride: false }) },
                resolveCurrentMachineId: () => 'resource-machine',
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_resource_fixture', machineId: 'resource-machine' }),
            },
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            })); },
        });
        const runtime = fixture.registry;
        const occurrence = runtime.readPluginOccurrenceId?.(consumer.manifest.id);
        if (!occurrence) throw new Error('Missing admitted Resource occurrence');
        const request = { callerPluginId: consumer.manifest.id, expectedCallerOccurrenceId: occurrence, resourceId: 'summary' };
        try {
            const result = await runtime.readUiResource?.(request);
            const snapshot = JSON.parse(new TextDecoder().decode(result?.bytes));
            expect(snapshot).toMatchObject({
                read: { ok: true, result: { value: 1 } }, write: { ok: false, errorCode: 'plugin_action_read_only_required' },
            });
            expect(ActionExecuteFailureSchema.safeParse(snapshot.write).success).toBe(true);
            expect(snapshot.write.details).toMatchObject({ actionHandlerInvocation: 'notStarted' });
            expect(writes).toBe(0);
            expect(caller).toMatchObject({ kind: 'plugin', pluginId: consumer.manifest.id, occurrenceId: occurrence,
                contribution: { id: 'summary', qualifiedId: `${consumer.manifest.id}/resources/summary` } });
            await runtime.openUiResourceWatch?.({ ...request, subscriptionId: 'summary-watch' });
            await installation;
            const before = reads;
            for (const notify of observers.get('unrelated') ?? []) notify();
            await Promise.resolve();
            expect(reads).toBe(before);
            expect(invalidations).toBe(0);
            expect(observers.get('selected')?.size).toBe(1);
            expect(observerCaller).toMatchObject({ kind: 'plugin', pluginId: consumer.manifest.id, occurrenceId: occurrence,
                contribution: { id: 'dependency', qualifiedId: `${consumer.manifest.id}/actions/dependency` } });
            value = 2;
            for (const notify of observers.get('selected') ?? []) notify();
            const changed = await runtime.pollUiResourceWatch?.({ ...request, subscriptionId: 'summary-watch' });
            expect(changed).toMatchObject({ status: 'event', event: { kind: 'invalidated' } });
            await Promise.resolve();
            await Promise.resolve();
            expect(invalidations).toBe(1);
            const refreshed = await runtime.readUiResource?.(request);
            expect(JSON.parse(new TextDecoder().decode(refreshed?.bytes))).toMatchObject({ read: { ok: true, result: { value: 2 } } });
            expect(writes).toBe(0);
            cancelOrdinary();
            if (!ordinarySubscription) throw new Error('Missing admitted ordinary observer');
            const cleanup = ordinarySubscription.dispose();
            expect(cleanup).toBeInstanceOf(Promise);
            expect(ordinarySubscription.dispose()).toBe(cleanup);
            let completed = false;
            let rejectedWith: unknown;
            const completion = Promise.resolve(cleanup).then(() => { completed = true; }, error => {
                completed = true;
                rejectedWith = error;
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(completed).toBe(false);
            finishCleanup();
            await completion;
            expect(rejectedWith).toBe(cleanupOutcome === 'reject' ? cleanupFailure : undefined);
            runtime.closeUiResourceWatch?.({ callerPluginId: consumer.manifest.id, subscriptionId: 'summary-watch' });
            await Promise.resolve();
            expect(observers.size).toBe(0);
        } finally { finishCleanup(); await fixture.dispose(); }
    });
});
