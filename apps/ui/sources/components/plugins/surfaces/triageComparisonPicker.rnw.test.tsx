// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-comparison-picker-native';

import { createPluginEventAutomationSetupSurfaceBinding } from '@/components/automations/editor/presentPluginEventAutomationSetupSurface';
import { createCanonicalPluginReactNativeHostApiAdapter } from '../reactNative/hostApi';
import { createPluginSurfaceHostApi, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';
import { createTriageEphemeralSharedScopeFixture } from '../../../../../../packages/plugins/triage/src/ui/window/ephemeralSharedScope.test-support';

// RNW is the platform boundary; the picker and both host API owners remain real.
vi.mock('react-native', () => import('react-native-web'));

it.each([false, true])('mounts the comparison picker in the Files ephemeral host (current-UI publisher=%s)', async withPublisher => {
    const binding = createPluginEventAutomationSetupSurfaceBinding({ isSettled: () => false, settle: () => {} });
    const bundle = binding.createMountedHostApiHandlers?.({ isCurrent: () => true });
    const requestSurface = { pluginId: 'happier.triage', contributionId: 'comparison-picker',
        surfaceId: 'files-comparison-picker', platform: 'web' as const, channel: 'development' as const };
    const publications: unknown[] = [];
    const publishCurrentUiContext: PluginSurfaceHostApiMethodHandler = request => {
        publications.push(request.payload);
        return null;
    };
    const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface, handlers: {
        ...bundle?.handlers,
        ...(withPublisher ? { publishCurrentUiContext } : {}),
    } });
    expect(host.installedMethods).toContain('settleEphemeralInput');
    expect(host.installedMethods.includes('publishCurrentUiContext')).toBe(withPublisher);
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: createSurfaceContextFixture(), requestSurface,
        installedMethods: host.installedMethods, handleRequest: host.handleRequest,
    });
    let picker: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
        await act(async () => {
            picker = await createPluginUiTestkit({
                identity: { instanceId: 'files-comparison-picker', mountNonce: 'files-comparison-mount' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                surfaceContext: createSurfaceContextFixture(),
                surface: context => renderSurface({ ...context, hostApi: adapter.api }),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
                launchInput: { inputType: { pluginId: 'happier.triage', localId: 'pull-request-comparison' },
                    semantic: 'scmPullRequestComparison' },
            });
        });
        expect(await picker!.getByRole('textbox', { label: 'Search pull requests' })).toBeDefined();
        expect(await picker!.getByRole('button', { name: 'Refresh' })).toBeDefined();
        if (withPublisher) expect(publications.at(-1)).toMatchObject({ enrichment: { detail: { view: 'comparison-picker' } } });
        else expect(publications).toEqual([]);
    } finally {
        await act(async () => { await picker?.dispose(); });
        adapter.dispose();
    }
    if (withPublisher) expect(publications.at(-1)).toEqual({ enrichment: null });
});
