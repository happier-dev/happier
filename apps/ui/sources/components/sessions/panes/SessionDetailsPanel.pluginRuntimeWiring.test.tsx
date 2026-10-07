import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel plugin runtime wiring', () => {
    it.each([
        { scopeSessionId: 's1', phase: 'establishing' as const, accepted: true },
        { scopeSessionId: 's2', phase: 'current' as const, accepted: false },
    ])('admits only the exact registered Session snapshot ($scopeSessionId)', async ({ scopeSessionId, phase, accepted }) => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { DetailsSurfaceHost, createDetailsSurfaceDescriptor } = await import('@/components/appShell/panes/details/surfaces');
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 17 };
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" paneSurfaceScope={{
                targetKind: 'session', sessionId: scopeSessionId, serverId: runtime.serverId,
                machineId: 'machine-from-pane-driver', pluginUiProjection: projection,
                projectionPhase: phase, interactionEnabled: true, platform: 'web',
            }} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'unsupported:runtime', kind: 'unsupported', title: 'Runtime probe',
            resource: { kind: 'unsupported' },
        }, { intent: 'pinned' }));
        const host = screen.tree.findByType(DetailsSurfaceHost);
        expect(host.props.scope).toEqual({
            kind: 'session', sessionId: 's1',
            machineId: accepted ? 'machine-from-pane-driver' : null,
            serverId: accepted ? runtime.serverId : null,
        });
        // Exercise the registered renderer's public file-view input. An establishing projection
        // keeps its snapshot but cannot launch; a wrong Session cannot borrow the focused Home.
        const tab = { ...createSessionFileDetailsTab('README.md'), isPinned: true, isPreview: false };
        const descriptor = createDetailsSurfaceDescriptor({ tab, scope: host.props.scope, region: 'details' });
        const renderer = host.props.renderers.find((candidate: { id: string }) => candidate.id === 'session-file');
        expect(renderer).toBeDefined();
        const element = renderer.render({
            tab, descriptor, scope: host.props.scope, region: 'details', active: true, callbacks: host.props.callbacks,
        });
        expect(React.isValidElement(element)).toBe(true);
        if (!React.isValidElement<React.ComponentProps<typeof import('./SessionDetailsPanelDetailViews')['SessionFileDetailsViewForPanel']>>(element)) {
            throw new Error('Expected the real file-view adapter');
        }
        expect(element.props.openableContentViewer).toMatchObject({
            targetKind: 'session', projection: accepted ? projection : null,
            scopedLaunchFacts: {
                serverId: accepted ? runtime.serverId : null,
                machineId: accepted ? 'machine-from-pane-driver' : null,
                interactionEnabled: false,
            },
        });
    });
});
