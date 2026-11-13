import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';

installProviderSettingsRpcBoundary(createProviderSettingsHarness({ machines: [] }));
const account = createProviderSettingsAccountHarness();
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { getInstalledPluginUiClientExecutableComposition, resolvePluginUiClientActionRefusal } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { resolveProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableProjection');
const { createPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/projection');
const { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { CurrentUiContextBridge } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { useCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');

afterEach(async () => { standardCleanup(); await account.reset(); });

it.each(['invoke', 'observe'] as const)('settles refused Account action %s while an unrelated Machine declaration is establishing', async mode => {
    await account.restore({ machines: [] });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected Account lifetime');
    const authored = definePlugin({ id: 'example.refused-investigation', version: '1.0.0', actions: {
        read: { title: 'Read', surfaces: ['ui'], readOnly: true,
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
            inputSchema: defineProtocolObject({}, { policy: 'closed' }), run: async () => null },
    } });
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
        activate: api => authored.activateAccount(api, { artifactId: 'account-runtime', exportName: 'activate' }), accountLifetime: lifetime });
    const composition = getInstalledPluginUiClientExecutableComposition();
    await composition.invalidatePlugin(authored.manifest.id);
    const platform = resolvePluginUiClientExecutablePlatform();
    const targets = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: installed.projection }, platform });
    const cache = createPluginReactNativeBundleCache();
    for (const target of targets) cache.putInstalledArtifact({ identity: target.cacheIdentity, bytes: new Uint8Array([47, 47]), format: 'plainJs' });
    // Executable bytes are an external boundary. Admission, activation, refusal
    // publication and the host Action acquisition remain real.
    await composition.reconcile(targets.map(target => ({ pluginId: target.pluginId, pluginVersion: target.pluginVersion,
        hostUiApiRange: target.hostUiApiRange, contributes: target.contributes, target: target.target,
        executionOrigin: target.executionOrigin, cache, identity: target.cacheIdentity, moduleReference: target.moduleReference,
        backend: { backendId: 'commonJs', available: true, async loadInstalledBundle() { throw new Error('Executable unavailable'); } },
        authority: target.authority, accountLifetime: lifetime,
        occurrenceId: Object.values(installed.projection.actionsById)[0]!.occurrenceId, isCurrent: lifetime.isCurrent,
    })));
    const action = Object.values(installed.projection.actionsById)[0]!;
    expect(resolvePluginUiClientActionRefusal({ action, platform })).not.toBeNull();
    let port: ReturnType<typeof useCurrentUiContextVoiceToolPort> = null;
    function Probe() { port = useCurrentUiContextVoiceToolPort(); return null; }
    const reader = { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} };
    const serverId = lifetime.scope.serverId;
    function Shell() {
        const defaults = useAppShellPluginUiProjection();
        return <AppShellPluginUiProjectionValueProvider declarationReady value={{ ...defaults,
            pluginUiProjection: installed.projection, phase: 'current', hasEstablishingMembers: true,
            clientExecutableActivation: { status: 'ready' }, accountLifetime: lifetime, serverId,
        }}><CurrentUiContextBridge publisher={null} reader={reader}><Probe /></CurrentUiContextBridge></AppShellPluginUiProjectionValueProvider>;
    }
    const screen = await renderScreen(<Shell />);
    const current = port as ReturnType<typeof useCurrentUiContextVoiceToolPort>;
    if (!current?.invokeAction || !current.observeAction) throw new Error('Expected invocation and observation ports');
    const controller = new AbortController();
    let result: unknown;
    const request = { action: { pluginId: authored.manifest.id, localId: 'read' }, input: {}, signal: controller.signal };
    const pending = mode === 'invoke' ? current.invokeAction(request).then(value => { result = value; })
        : current.observeAction({ ...request, isCurrent: lifetime.isCurrent, invalidate() {} }).then(
            async observer => { await observer.dispose(); result = { ok: true }; },
            (error: unknown) => { result = { ok: false, code: error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : null }; });
    try {
        await act(async () => {});
        expect(result).toMatchObject({ ok: false, code: mode === 'invoke' ? 'unavailable' : 'contributed_action_unavailable' });
    } finally {
        controller.abort(); await pending; await screen.unmount(); await installed.dispose();
    }
});
