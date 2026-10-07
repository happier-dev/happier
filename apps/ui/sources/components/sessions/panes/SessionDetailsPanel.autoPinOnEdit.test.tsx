import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

let SessionDetailsPanel: typeof import('./SessionDetailsPanel')['SessionDetailsPanel'];
function panel() {
    return <runtime.Wrapper><SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>;
}
async function openPreview() {
    await act(async () => runtime.pane.openDetailsTab({
        key: 'file:a', kind: 'file', title: 'a.txt', resource: { kind: 'file', path: 'a.txt' },
    }, { intent: 'preview' }));
}

describe('SessionDetailsPanel (auto pin on edit)', () => {
    it('pins a preview file tab when editing begins', async () => {
        ({ SessionDetailsPanel } = await import('./SessionDetailsPanel'));
        const { SessionFileDetailsView } = await import('@/components/sessions/files/views/SessionFileDetailsView');
        const screen = await renderScreen(panel());
        await openPreview();
        const views = screen.tree.findAllByType(SessionFileDetailsView);
        expect(views).toHaveLength(1);
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: 'file:a', isPreview: true, isPinned: false });
        expect(typeof views[0].props.onStartEditingFile).toBe('function');
        await act(async () => views[0].props.onStartEditingFile());
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: 'file:a', isPreview: false, isPinned: true });
    });

    it('keeps the file edit callback stable across unchanged panel rerenders', async () => {
        ({ SessionDetailsPanel } = await import('./SessionDetailsPanel'));
        const { SessionFileDetailsView } = await import('@/components/sessions/files/views/SessionFileDetailsView');
        const screen = await renderScreen(panel());
        await openPreview();
        const firstCallback = screen.tree.findByType(SessionFileDetailsView).props.onStartEditingFile;
        expect(typeof firstCallback).toBe('function');
        await screen.update(panel());
        expect(screen.tree.findByType(SessionFileDetailsView).props.onStartEditingFile).toBe(firstCallback);
        // The retained callback remains connected to the live reducer after the rerender.
        await act(async () => firstCallback());
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: 'file:a', isPinned: true, isPreview: false });
    });
});
