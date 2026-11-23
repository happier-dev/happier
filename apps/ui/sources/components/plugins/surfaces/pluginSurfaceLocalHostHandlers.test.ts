import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { expect, it, vi } from 'vitest';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { createCanonicalPluginReactNativeHostApiAdapter } from '../reactNative/hostApi';
import { createPluginSurfaceHostApi } from './createPluginSurfaceHostApi';
import { createPluginSurfaceLocalHostHandlers } from './pluginSurfaceLocalHostHandlers';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const workbench: PluginUiSurfaceContextV1 = {
    pluginId: 'com.happier.database-workbench',
    contributionId: 'workbench',
    surfaceId: 'workbench-mount',
    placement: 'appSurface',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

function mountDeviceState(serverId: string, accountId: string, requestSurface = workbench) {
    const host = createPluginSurfaceHostApi({
        surfaceContext: requestSurface,
        handlers: createPluginSurfaceLocalHostHandlers({ surfaceContext: requestSurface, deviceScope: { serverId, accountId } }),
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: createPluginSurfaceContextFixture({
            mount: { kind: 'destination', destination: { pluginId: requestSurface.pluginId, localId: requestSurface.contributionId }, container: 'appPage' },
            target: { kind: 'app' },
        }),
        requestSurface,
        installedMethods: host.installedMethods,
        handleRequest: host.handleRequest,
    });
    return {
        api: adapter.api,
        dispose() {
            adapter.dispose();
            host.dispose?.();
        },
    };
}

it('round-trips a structured Console key through the web mount without sharing drafts across Homes, Accounts or contributions', async () => {
    const key = JSON.stringify(['database-console', 'machine-1', {
        accountId: 'account-1',
        installationId: 'installation-1',
        kind: 'manual',
        projectKey: 'project-1',
        savedSecretId: 'selected',
        workspace: { machineId: 'machine-1', rootPath: '/project', serverId: 'home-1', workspaceId: 'workspace-1' },
    }]);
    const draft = { sql: 'select 1', history: [{ sql: 'select 1' }] };
    const original = mountDeviceState('home-1', 'account-1');
    try {
        await expect(original.api.deviceState({ operation: 'read', key: 'simple-draft' })).resolves.toEqual({ status: 'ready', value: null });
        await expect(original.api.deviceState({ operation: 'read', key })).resolves.toEqual({ status: 'ready', value: null });
        await expect(original.api.deviceState({ operation: 'write', key, value: draft })).resolves.toEqual({ status: 'ready', value: null });
    } finally {
        original.dispose();
    }

    const reopened = mountDeviceState('home-1', 'account-1');
    const anotherHome = mountDeviceState('home-2', 'account-1');
    const anotherAccount = mountDeviceState('home-1', 'account-2');
    const anotherPlugin = mountDeviceState('home-1', 'account-1', { ...workbench, pluginId: 'acme.other' });
    const anotherContribution = mountDeviceState('home-1', 'account-1', { ...workbench, contributionId: 'another-contribution' });
    try {
        await expect(reopened.api.deviceState({ operation: 'read', key })).resolves.toEqual({ status: 'ready', value: draft });
        for (const sibling of [anotherHome, anotherAccount, anotherPlugin, anotherContribution]) {
            await expect(sibling.api.deviceState({ operation: 'read', key })).resolves.toEqual({ status: 'ready', value: null });
        }
        await expect(reopened.api.deviceState({ operation: 'remove', key })).resolves.toEqual({ status: 'ready', value: null });
        await expect(reopened.api.deviceState({ operation: 'read', key })).resolves.toEqual({ status: 'ready', value: null });
    } finally {
        for (const mount of [reopened, anotherHome, anotherAccount, anotherPlugin, anotherContribution]) mount.dispose();
    }
});
