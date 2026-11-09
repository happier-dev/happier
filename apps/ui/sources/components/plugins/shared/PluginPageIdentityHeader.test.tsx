import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Cold compilation belongs to collection, outside the per-test timeout.
const { PluginPageIdentityHeaderProvider } = await import('./PluginPageIdentityHeader');
const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');

describe('PluginPageIdentityHeaderProvider', () => {
    // A page that has not loaded keeps its identity above its cold state, unless a host page around it (a Machine
    // page's tab) already names it: then the cold state stands under the host's header alone.
    it.each([
        ['page', true],
        ['host', false],
    ] as const)('with %s identity, a cold page shows its own header: %s', async (identityOwner, shown) => {
        const screen = await renderScreen(
            <PluginPageIdentityHeaderProvider pluginId="acme.sandboxes" title="Sandboxes" identityOwner={identityOwner}>
                <PluginSurfaceInteractionBoundary surfaceId="cold-page" snapshotTitle="Sandboxes" enabled={false}>
                    {null}
                </PluginSurfaceInteractionBoundary>
            </PluginPageIdentityHeaderProvider>,
        );
        try {
            expect(screen.findByTestId('plugin-page-identity-header:acme.sandboxes') !== null).toBe(shown);
        } finally {
            await screen.unmount();
        }
    });

    it('says a phone toolbar page\'s identity as the large title its Collection leads with, not an entity header', async () => {
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const screen = await renderScreen(
            <PluginPageIdentityHeaderProvider pluginId="happier.triage" title="PRs & Issues" headerStyle="toolbar" largeTitle>
                <PluginSurfaceInteractionBoundary surfaceId="cold-page" snapshotTitle="PRs & Issues" enabled={false}>
                    {null}
                </PluginSurfaceInteractionBoundary>
            </PluginPageIdentityHeaderProvider>,
        );
        try {
            const header = screen.findByType(PageHeader);
            expect(header.props).toMatchObject({ title: 'PRs & Issues', alwaysShowTitle: true });
            // The loaded page draws the name alone (lab `merged-list` 390): no mark, so nothing moves on arrival.
            expect(header.props.leading).toBeUndefined();
            expect(screen.findByTestId('plugin-page-identity-toolbar:happier.triage')).toBeNull();
        } finally {
            await screen.unmount();
        }
    });
});
