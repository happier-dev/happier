/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
import { PluginHostApiProvider, PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { useScmFileViewed as usePluginViewed, useScmFileViewedFile as usePluginFile } from '@happier-dev/plugin-ui/hostApi';
import { renderScreen, act, standardCleanup } from '@/dev/testkit';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { acquireScmFileViewedSource } from '@/sync/ops/scmDiffSummary/fileViewedSources';
import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { useScmFileViewed, useScmFileViewedFile } from './useScmFileViewed';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const serverId = 'viewed-plugin-home';
const serverUrl = 'https://viewed-plugin.example.test';
let webLocks: ReturnType<typeof installWebLockManagerMock>;
beforeEach(() => { webLocks = installWebLockManagerMock(); });
afterEach(async () => {
    standardCleanup();
    try { await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId }); }
    finally { webLocks.restore(); }
});

it('mounts the public plugin hook through the production host bridge onto the core PR source without another read', async () => {
    await seedPersistedHomeProfilesForTests({ activeServerId: serverId, browserStorage: window.localStorage,
        profiles: [{ id: serverId, name: 'Viewed fixture', serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1 }] });
    await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: 'viewed-account' })).toString('base64url')}.signature`,
    });
    const binding = await resolveServerCredentialAccountScope(serverId);
    expect(binding.kind).toBe('bound');
    if (binding.kind !== 'bound') throw new Error('Fixture Account did not bind');
    const actions = { read: { action: { pluginId: 'example.forge', localId: 'read-viewed' } },
        set: { action: { pluginId: 'example.forge', localId: 'set-viewed' } } };
    const comparison = ScmComparisonSchema.parse({ id: 'viewed-pr', repository: { rootPath: '/repo' },
        source: { kind: 'pullRequest', locator: { providerId: 'example.forge', repository: 'example/repo', number: 17,
            fileViewedActions: actions } }, endpoints: { after: 'head' }, freshness: 'current',
        inventory: { state: 'complete', reasons: [], files: [] } });
    let reads = 0;
    const seed = acquireScmFileViewedSource({ actions,
        scopeKey: JSON.stringify([binding.scope, binding.credentialKey]), isCurrent: () => true,
        execute: async invocation => {
            if (invocation.action.localId === 'read-viewed') {
                reads++;
                return { kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: 'unviewed' }] };
            }
            return { kind: 'ready', path: 'a.ts', state: 'viewed' };
        },
    });
    seed.setActive(true);
    await seed.source.refresh();
    const context = createPluginSurfaceContextFixture({ accountScope: binding.scope });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface: context, installedMethods: [],
        requestSurface: { pluginId: 'example.forge', contributionId: 'files', surfaceId: 'files', placement: 'sessionPane',
            platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
        handleRequest: async () => { throw new Error('A Viewed observer must not issue Host API reads'); },
    });
    const hostProps = { hostApi: adapter.api, surfaceActivity: { active: true } };
    let core: ScmFileViewedSource | null = null;
    let plugin: ScmFileViewedSource | null = null;
    let coreFile: unknown;
    let pluginFile: unknown;
    function Core() {
        core = useScmFileViewed({ comparison, serverId, host: null });
        coreFile = useScmFileViewedFile(core, 'a.ts');
        return null;
    }
    function Plugin() {
        plugin = usePluginViewed({ comparison, serverId, host: null });
        pluginFile = usePluginFile(plugin, 'a.ts');
        return null;
    }
    try {
        await renderScreen(<PluginHostApiProvider {...hostProps}>
            <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context)}
                presentationHost={createPluginUiPrivatePresentationHost(undefined)}>
                <Core /><Plugin />
            </PluginUiHostPresentationScope>
        </PluginHostApiProvider>);
        await expect.poll(() => core === seed.source && plugin === seed.source).toBe(true);
        expect(coreFile).toBe(pluginFile);
        expect(reads).toBe(1);
        await act(async () => { await seed.source.setViewed('a.ts', true); });
        expect(coreFile).toBe(pluginFile);
        expect(pluginFile).toMatchObject({ state: 'viewed' });
        expect(reads).toBe(1);
    } finally {
        seed.release(); adapter.dispose();
    }
});
