import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { PluginActionReadInvalidation } from '@happier-dev/plugin-sdk/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema, normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import type { RpcHandler } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { invokeAccountMachineSourceAction } from '@/plugins/runtime/invocation/actions/accountMachineActionTransport';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('Account Action read observation through the daemon watch ingress', () => {
    it.each(['ui', 'cli', 'agent'] as const)('attaches from %s without acquiring data, invalidates on real change, retires authority and closes on cancellation', async executionSurface => {
        const accountPluginId = 'acme.account-observer';
        const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: accountPluginId, entrypoints: {}, contributes: {
            actions: [{ id: 'aggregate', title: 'Aggregate', scopes: ['global'], surfaces: ['ui', 'cli', 'agent'], dangerLevel: 'safe', placementBindings: [],
                execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }],
        } }));
        const digest = `sha256:${'a'.repeat(64)}`;
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
            PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
                intent: { pluginId: accountPluginId, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: normalizePluginReleaseFactsV1({ ref: { pluginId: accountPluginId, version: manifest.version }, archiveDigestSha256: digest,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } }),
                uiArtifacts: [], packageAssets: [] }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-observer.test' });
        let reads = 0;
        let value = 'initial';
        let disposals = 0;
        let effects = 0;
        let effectObservations = 0;
        let observationHold: Promise<void> | null = null;
        let observationStarted = () => {};
        const observers = new Set<PluginActionReadInvalidation>();
        const target = definePlugin({ id: 'acme.machine-observed', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
            state: { title: 'Read state', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
                run(_input, context) { reads++; return { value, caller: context.caller }; },
                async observeRead(_input, invalidate) {
                    observers.add(invalidate);
                    observationStarted();
                    if (observationHold) await observationHold;
                    return { dispose() { disposals++; observers.delete(invalidate); } };
                },
            },
            effect: { title: 'Apply effect', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
                run() { effects++; return {}; },
                observeRead() { effectObservations++; return { dispose() {} }; } },
        } });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: target.manifest,
            files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: target.activate }) }],
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            })); },
            runtimeOptions: { resolveCurrentMachineId: () => 'reading-machine',
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_observer', machineId: 'reading-machine' }) } });
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_observer', machineId: 'reading-machine' }),
                resolveAccountPluginExecutionSelection: pluginId => readCurrentAccountPluginExecutionSelection({ pluginId,
                    credentials: { token: 'fixture', encryption: null }, serverUrl: 'http://account-observer.test' }),
            });
            const invoke = async (method: string, request: unknown, signal?: AbortSignal) => {
                const handler = handlers.get(method);
                if (!handler) throw new Error('Missing registered daemon handler');
                return handler(request, signal ? { signal } : undefined);
            };
            const occurrenceId = fixture.registry.readPluginOccurrenceId?.(target.manifest.id);
            const actionRead = { machineId: 'reading-machine', qualifiedActionId: `${target.manifest.id}/state`,
                expectedContributorOccurrenceId: occurrenceId, requiredReadOnly: true, input: {}, executionSurface,
                invocation: { kind: 'clientPluginAction', clientActionBinding: { pluginId: accountPluginId, contributionLocalId: 'aggregate',
                    occurrenceId: 'account-occurrence', sourceCustody: { kind: 'account_release', pluginId: accountPluginId,
                        version: manifest.version, archiveDigestSha256: digest } } } };
            const base = { machineId: 'reading-machine', callerPluginId: target.manifest.id,
                expectedCallerOccurrenceId: occurrenceId, subscriptionId: 'observed-read' };
            const open = () => invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, { ...base, resource: { actionRead } });
            expect(await open()).toEqual({ ok: true, subscriptionId: base.subscriptionId });
            expect(reads).toBe(0);
            expect(observers.size).toBe(1);
            const notify = [...observers][0]!;
            value = 'changed';
            notify();
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, base)).toMatchObject({ ok: true,
                status: 'event', event: { kind: 'readInvalidated', subscriptionId: base.subscriptionId } });
            expect(reads).toBe(0);
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, actionRead)).toMatchObject({ ok: true,
                result: { value: 'changed', caller: { kind: 'plugin', pluginId: accountPluginId } } });
            expect(reads).toBe(1);
            notify.retire();
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, base)).toMatchObject({ ok: true,
                status: 'event', event: { kind: 'error', code: 'expired_resource' } });
            expect(observers.size).toBe(0);
            expect(await open()).toEqual({ ok: true, subscriptionId: base.subscriptionId });
            const late = [...observers][0]!;
            const controller = new AbortController();
            const pending = invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, base, controller.signal);
            controller.abort();
            expect(await pending).toMatchObject({ ok: true, status: 'idle' });
            expect(observers.size).toBe(0);
            late();
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, base)).toEqual({ ok: true, closed: false });
            expect(disposals).toBe(2);
            expect(reads).toBe(1);
            let releaseObservation = () => {};
            observationHold = new Promise<void>(resolve => { releaseObservation = resolve; });
            const admissionStarted = new Promise<void>(resolve => { observationStarted = resolve; });
            const admissionController = new AbortController();
            const pendingAdmission = invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
                { ...base, resource: { actionRead } }, admissionController.signal);
            await admissionStarted;
            admissionController.abort();
            releaseObservation();
            expect(await pendingAdmission).toMatchObject({ ok: false });
            expect(observers.size).toBe(0);
            observationHold = null;
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, { ...base,
                resource: { actionRead: { ...actionRead, qualifiedActionId: `${target.manifest.id}/effect` } } }))
                .toMatchObject({ ok: false, code: 'plugin_action_read_only_required' });
            expect(effects).toBe(0);
            expect(effectObservations).toBe(0);
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, { ...base,
                resource: { actionRead: { ...actionRead, machineId: 'another-machine' } } }))
                .toMatchObject({ ok: false });
            expect(await invoke(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, { ...base,
                resource: { actionRead: { ...actionRead, invocation: undefined } } }))
                .toMatchObject({ ok: false });
            expect(reads).toBe(1);
            if (executionSurface === 'cli') {
                // The process/network boundary is looped into the registered daemon;
                // Account transport, caller admission, policy and plugin observation stay real.
                const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async params =>
                    invoke(params.method, params.request, params.signal));
                const sourceCustody = fixture.registry.readPluginSourceCustody?.(target.manifest.id);
                if (!sourceCustody || !occurrenceId) throw new Error('Missing admitted Machine source');
                let subscription: Disposable | undefined;
                let retirements = 0;
                let notified = () => {};
                const changed = new Promise<void>(resolve => { notified = resolve; });
                const controller = new AbortController();
                try {
                    expect(await invokeAccountMachineSourceAction({ credentials: { token: 'fixture', encryption: null },
                        serverUrl: 'http://account-observer.test', machineId: 'reading-machine', callerManifest: manifest,
                        callerSourceCustody: { kind: 'account_release', pluginId: accountPluginId, version: manifest.version,
                            archiveDigestSha256: digest },
                        source: { manifest: normalizePluginManifestV2(target.manifest), occurrenceId, sourceCustody },
                        request: { action: { pluginId: target.manifest.id, localId: 'state' }, input: {}, requiredReadOnly: true,
                            surface: 'plugin', originSurface: 'cli', caller: { kind: 'plugin', pluginId: accountPluginId,
                                contribution: { id: 'aggregate', qualifiedId: `${accountPluginId}/aggregate` },
                                occurrenceId: 'account-occurrence', originSurface: 'cli' }, signal: controller.signal,
                            readObservation: { invalidate: () => notified(), retire: () => { retirements++; },
                                accept: value => { subscription = value; } } } }))
                        .toMatchObject({ status: 'executed' });
                    expect(reads).toBe(1);
                    expect(observers.size).toBe(1);
                    value = 'transport-change';
                    [...observers][0]!();
                    await changed;
                    expect(retirements).toBe(0);
                    controller.abort();
                    await subscription?.dispose();
                    expect(observers.size).toBe(0);
                    expect(reads).toBe(1);
                } finally { controller.abort(); await subscription?.dispose(); transport.mockRestore(); }
            }
        } finally { restore(); await app.close(); await fixture.dispose(); }
    });
});
