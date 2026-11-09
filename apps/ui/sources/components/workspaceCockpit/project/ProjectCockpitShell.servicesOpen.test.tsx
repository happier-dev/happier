import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { readLocalServiceActionOutcome } from '@/components/sessions/localServices/localServiceActionOutcome';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
}));
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_services',
    features: () => createRootLayoutFeaturesResponse({ features: { browser: { enabled: true } } }),
    request: async url => new URL(String(url)).pathname === '/v2/account/settings' ? Response.json({ version: 1,
        content: { t: 'plain', v: { actionsSettingsV1: { v: 1, actions: {},
            approvalWaivedSurfaces: { 'browser.workspace.open': ['ui'] } } } },
    }) : null,
});

describe('Project Services Browser destination', () => {
    it('opens from the desktop Services page into the Project details workspace', async () => {
        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        const { ProjectRightPanelServicesView } = await import('@/components/projects/detail/services/ProjectRightPanelServicesView');
        const screen = await renderScreen(<runtime.Wrapper><ProjectCockpitShell
            workspaceRef={{ id: 'wr_services', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 }}
            scopeId="project:wr_services" activeRootPath="/repo" surface="services" isFocused onSelectRootPath={() => {}}
        /></runtime.Wrapper>);
        const target: LocalServiceLaunchTargetV1 = { id: 'service', source: 'terminal_url', machineId: 'm1',
            title: 'Web app', subtitle: 'localhost:42511', confidence: 'high', state: 'available', actions: [],
            browserTarget: { kind: 'externalUrl', targetId: 'service', url: 'https://service.test/' } };
        await act(async () => {
            const result = await screen.tree.findByType(ProjectRightPanelServicesView).props.onOpenServiceInBrowser(target);
            expect(readLocalServiceActionOutcome(result)).toEqual({ kind: 'succeeded' });
        });
        // The visible desktop pane owns this tab. A successful open into its phone-only
        // sibling would leave the person on Services with nothing to see.
        expect(runtime.pane.scopeState?.details.tabs).toEqual([expect.objectContaining({ kind: 'browser-view',
            resource: expect.objectContaining({ target: target.browserTarget }) })]);
    });
});
